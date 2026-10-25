import { waitUntil } from "@vercel/functions";
import { getAllPosts, addQueueIdeas } from "../lib/db.js";
import { computeStats } from "../lib/analytics.js";
import { askClaude } from "../lib/claude.js";
import { extractJson } from "../lib/parse.js";
import { sendTelegramMessage } from "../lib/telegram.js";
import { readFileSync } from "fs";
import { join } from "path";

const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), "prompts", "system-prompt.md"),
  "utf-8"
);

// Один запрос на весь план (24 идеи) стабильно стал упираться в таймаут —
// в prompts/system-prompt.md со временем накопилось много правил (форматы,
// лимиты длины, доля экспериментов, дисциплина по ссылкам), и на их фоне
// Клоду physически не хватало 50 секунд, чтобы сгенерировать все 24 идеи
// за один присест, а поднять лимит дальше некуда — потолок Vercel Hobby для
// serverless-функций 60 секунд, это жёсткий предел плана, не настройка.
//
// Решение — делить план на ДВЕ ПОЛОВИНЫ (по 12 идей) и просить их у Клода
// ПАРАЛЛЕЛЬНО, а не одним большим запросом: по времени это упирается не в
// сумму двух запросов, а в более медленный из них, так что общее время
// примерно в 1.5-2 раза меньше, чем раньше. Делим так, чтобы было ровно
// 12/12: Пн-Ср (3 буднях × 4) = 12, Чт-Вс (2 буднях × 4 + 2 выходных × 2) = 12.
const HALF1_DAYS = "Mon, Tue, Wed";
const HALF1_COUNT = 12; // 3 будних дня × 4
const HALF2_DAYS = "Thu, Fri, Sat, Sun";
const HALF2_COUNT = 12; // 2 будних дня × 4 + 2 выходных × 2

// На каждую половину — меньше токенов и меньше времени, чем раньше на весь
// план разом (8000 токенов / 50с). Обе половины ОБЯЗАНЫ уложиться
// параллельно в общий 60-секундный бюджет функции — оставляем ~15-18с
// сверху на БД, формирование списка и отправку в Telegram.
const HALF_TIMEOUT_MS = 40000;
const HALF_MAX_TOKENS = 4500;

function buildHalfPrompt(stats, days, count) {
  return `task: plan

IMPORTANT OVERRIDE — this is a PARTIAL request, not the full week: generate ideas ONLY for these days: ${days}. Total ideas in your response: EXACTLY ${count} (ignore the "EXACTLY 24 for a full week" instruction in the system prompt below — that count is for a full week, this request is deliberately split into two halves to fit a hard response-time limit; apply all the OTHER plan rules — cadence per day, format mix, link discipline, long-form budget, risky-experiments share — scaled down proportionally to these ${count} ideas and these specific days only, not the full week's numbers).

${JSON.stringify(stats)}`;
}

// Вся тяжёлая работа — здесь. Запускается в фоне (waitUntil), поэтому
// cron-job.org не ждёт её завершения и не упирается в свой 30-секундный
// лимит ответа. Функция сама шлёт в Telegram и результат, и ошибку.
async function generateAndSendPlan(chatId) {
  try {
    const posts = await getAllPosts();
    if (posts.length === 0) {
      console.log("weekly-plan: постов ещё нет, план не генерируем");
      return;
    }

    const stats = computeStats(posts);

    const [half1Raw, half2Raw] = await Promise.all([
      askClaude({
        system: SYSTEM_PROMPT,
        userMessage: buildHalfPrompt(stats, HALF1_DAYS, HALF1_COUNT),
        maxTokens: HALF_MAX_TOKENS,
        timeoutMs: HALF_TIMEOUT_MS,
      }),
      askClaude({
        system: SYSTEM_PROMPT,
        userMessage: buildHalfPrompt(stats, HALF2_DAYS, HALF2_COUNT),
        maxTokens: HALF_MAX_TOKENS,
        timeoutMs: HALF_TIMEOUT_MS,
      }),
    ]);

    const half1 = extractJson(half1Raw);
    const half2 = extractJson(half2Raw);

    // Одна половина могла не распознаться, а другая — вполне нормально
    // прийти валидной. Берём что получилось, не выбрасываем всё целиком
    // из-за сбоя в одной части — лучше неполный план, чем вообще никакой.
    const ideas = [
      ...(Array.isArray(half1) ? half1 : []),
      ...(Array.isArray(half2) ? half2 : []),
    ];

    if (ideas.length === 0) {
      console.error("weekly-plan: не смогла распознать JSON ни в одной половине:", { half1Raw, half2Raw });
      await sendTelegramMessage(
        chatId,
        "⚠️ План на неделю сгенерировать не смогла — Клод ответил не в ожидаемом формате. Напиши мне «идеи», чтобы попробовать ещё раз."
      );
      return;
    }

    await addQueueIdeas(ideas);

    const partialNote =
      !Array.isArray(half1) || !Array.isArray(half2)
        ? "\n\n⚠️ Одна часть недели не сгенерировалась, собрала что есть — если дней не хватает, напиши «идеи»."
        : "";

    const list = ideas
      .map((i, idx) => `${idx + 1}. [${i.day_of_week || "?"} ${i.suggested_slot}] ${i.topic} — ${i.angle}`)
      .join("\n");

    await sendTelegramMessage(
      chatId,
      `💡 План на неделю (буду сама напоминать в эти часы):\n\n${list}${partialNote}`
    );
  } catch (err) {
    console.error("weekly-plan: ошибка", err);
    const reason =
      err.name === "AbortError"
        ? "Claude не уложился по времени (таймаут)"
        : err.message;
    try {
      await sendTelegramMessage(chatId, `⚠️ План на неделю не удалось сгенерировать — ошибка: ${reason}`);
    } catch (notifyErr) {
      console.error("weekly-plan: не удалось даже уведомить об ошибке", notifyErr);
    }
  }
}

export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const chatId = process.env.FOUNDER_CHAT_ID;

  // Отвечаем крону сразу, а генерацию продолжаем в фоне.
  waitUntil(generateAndSendPlan(chatId));
  res.status(200).send("plan generation started");
}
