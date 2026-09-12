import { getAllPosts, getRecentPosts, clearQueuedIdeas, addQueueIdeas } from "../lib/db.js";
import { computeStats, weightedOverallER } from "../lib/analytics.js";
import { askClaude } from "../lib/claude.js";
import { extractJson } from "../lib/parse.js";
import { sendTelegramMessage } from "../lib/telegram.js";
import { readFileSync } from "fs";
import { join } from "path";

const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), "prompts", "system-prompt.md"),
  "utf-8"
);

const RECENT_COUNT = 5; // сколько последних постов считаем "текущей формой" (было 3 — слишком шумно)
const UNDERPERFORM_THRESHOLD = 0.7; // если свежие посты дают <70% от обычного ER — бьём тревогу
const MIN_TOTAL_POSTS = 15; // до этого объёма любое сравнение "просадки" — шум, а не сигнал

export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const chatId = process.env.FOUNDER_CHAT_ID;

  try {
    const allPosts = await getAllPosts();
    if (allPosts.length < Math.max(RECENT_COUNT + 5, MIN_TOTAL_POSTS)) {
      // Слишком мало данных, чтобы делать выводы о "просадке" — не дёргаем план зря
      return res.status(200).send("not enough data for midweek check yet");
    }

    const recent = await getRecentPosts(RECENT_COUNT);
    const recentAvgER =
      recent.reduce((sum, p) => sum + (p.engagement_rate || 0), 0) / recent.length;

    // Сравниваем не с "сырым" средним за всю историю (где посты полугодовой
    // давности тянут наравне со вчерашними), а со взвешенным по свежести —
    // иначе легко принять естественный дрейф стиля/аудитории за "просадку".
    const overallAvgER = weightedOverallER(allPosts);

    if (overallAvgER === 0 || recentAvgER >= overallAvgER * UNDERPERFORM_THRESHOLD) {
      // Всё в порядке, план не проваливается — ничего не делаем и не пишем
      return res.status(200).send("performance within normal range, no replan needed");
    }

    // Просадка реальна — просим Клода поменять тактику на оставшиеся дни недели
    const stats = computeStats(allPosts);
    const result = await askClaude({
      system: SYSTEM_PROMPT,
      userMessage: `task: replan\n\nRecent ${RECENT_COUNT} posts average ER: ${recentAvgER.toFixed(
        2
      )}%. Overall account average ER: ${overallAvgER.toFixed(
        2
      )}%. That's a real underperformance this week.\n\nFull stats:\n${JSON.stringify(
        stats
      )}\n\nRespond in EXACTLY this format:\nEXPLANATION: <3-5 sentences in Russian>\nIDEAS: <JSON array of replacement ideas, same shape as the plan task>`,
      maxTokens: 3000,
    });

    const explMatch = result.match(/EXPLANATION:\s*([\s\S]*?)\nIDEAS:\s*([\s\S]*)/);
    const ideas = explMatch ? extractJson(explMatch[2]) : null;

    if (!explMatch || !Array.isArray(ideas)) {
      console.error("midweek-check: не смогла распознать ответ Клода:", result);
      await sendTelegramMessage(
        chatId,
        "⚠️ Заметила просадку в постах на этой неделе, но не смогла автоматически перестроить план (Клод ответил не в ожидаемом формате). Напиши «идеи», чтобы получить новые вручную."
      );
      return res.status(200).send("replan parse failed, notified");
    }

    const explanation = explMatch[1].trim();

    await clearQueuedIdeas();
    await addQueueIdeas(ideas);

    const list = ideas
      .map((i, idx) => `${idx + 1}. [${i.day_of_week || "?"} ${i.suggested_slot}] ${i.topic} — ${i.angle}`)
      .join("\n");

    await sendTelegramMessage(
      chatId,
      `⚠️ Меняю тактику на эту неделю\n\nПоследние посты дают ${recentAvgER.toFixed(
        1
      )}% ER против обычных ${overallAvgER.toFixed(1)}% — план перестал работать.\n\n${explanation}\n\nНовый план до конца недели:\n${list}`
    );

    res.status(200).send("replanned");
  } catch (err) {
    console.error("midweek-check: ошибка", err);
    try {
      await sendTelegramMessage(chatId, `⚠️ Проверка формы на неделе не удалась — ошибка: ${err.message}`);
    } catch (notifyErr) {
      console.error("midweek-check: не удалось даже уведомить об ошибке", notifyErr);
    }
    res.status(200).send("failed, notified if possible");
  }
}
