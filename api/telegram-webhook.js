import { readFileSync } from "fs";
import { join } from "path";
import { askClaude } from "../lib/claude.js";
import { sendTelegramMessage, MAIN_MENU } from "../lib/telegram.js";
import {
  savePost,
  getAllPosts,
  addQueueIdeas,
  getPendingAction,
  setPendingAction,
} from "../lib/db.js";

const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), "prompts", "system-prompt.md"),
  "utf-8"
);

const HELP_TEXT = `Вот что я умею:

📊 *Отчёт* — анализ всех твоих постов: что заходит, что нет, паттерны
💡 *Идеи* — новые идеи постов на основе данных
✍️ *Ответ на твит* — пришлю черновик ответа клиенту

Чтобы записать новый пост — просто напиши мне про него в свободной форме: дата, время, тема, просмотры, лайки и т.д. Я сам разберу.`;

export default async function handler(req, res) {
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const update = req.body;
  const message = update?.message;
  if (!message || !message.text) {
    return res.status(200).send("ok");
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  try {
    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "Привет! Я твой аналитик и контент-стратег для X.\n\n" + HELP_TEXT
      );
    } else if (text === "❓ Помощь") {
      await sendTelegramMessage(chatId, HELP_TEXT);
    } else if (text === "📊 Отчёт") {
      await handleAnalyze(chatId);
    } else if (text === "💡 Идеи") {
      await handlePlan(chatId);
    } else if (text === "✍️ Ответ на твит") {
      await setPendingAction(chatId, "awaiting_tweet");
      await sendTelegramMessage(chatId, "Скинь текст твита, на который нужно ответить.");
    } else {
      // Проверяем, не ждём ли мы от этого чата что-то конкретное
      const pending = await getPendingAction(chatId);

      if (pending === "awaiting_tweet") {
        await setPendingAction(chatId, null);
        await handleReply(chatId, text);
      } else {
        // Обычное сообщение — считаем, что это данные поста
        await handleIngest(chatId, text);
      }
    }
  } catch (err) {
    console.error(err);
    await sendTelegramMessage(chatId, `Ошибка: ${err.message}`);
  }

  res.status(200).send("ok");
}

async function handleIngest(chatId, text) {
  const raw = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: ingest\n\n${text}`,
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await sendTelegramMessage(
      chatId,
      "Не смогла разобрать сообщение как данные поста. Если хотела что-то другое — используй кнопки внизу."
    );
    return;
  }

  if (parsed.missing_fields?.length) {
    await sendTelegramMessage(chatId, `Не хватает: ${parsed.missing_fields.join(", ")}. Дошли, пожалуйста.`);
    return;
  }

  await savePost(parsed);
  const er = ((parsed.likes + parsed.replies + parsed.retweets) / (parsed.views || 1)) * 100;
  await sendTelegramMessage(
    chatId,
    `✅ Записала: ${parsed.date} ${parsed.time}, тема "${parsed.topic}", ${parsed.views} просмотров, ER ${er.toFixed(1)}%`
  );
}

async function handleAnalyze(chatId) {
  const posts = await getAllPosts();
  if (posts.length === 0) {
    await sendTelegramMessage(chatId, "Пока нет ни одного поста в базе. Пришли данные — начнём собирать.");
    return;
  }
  await sendTelegramMessage(chatId, "Считаю отчёт, секунду...");
  const report = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: analyze\n\n${JSON.stringify(posts)}`,
    maxTokens: 2000,
  });
  await sendTelegramMessage(chatId, report);
}

async function handlePlan(chatId) {
  const posts = await getAllPosts();
  const ideasRaw = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: plan\n\nposts: ${JSON.stringify(posts)}`,
    maxTokens: 1500,
  });

  let ideas;
  try {
    ideas = JSON.parse(ideasRaw);
  } catch {
    await sendTelegramMessage(chatId, "Не получилось сгенерировать идеи, попробуй ещё раз через минуту.");
    return;
  }

  await addQueueIdeas(ideas);
  const list = ideas
    .map((i, idx) => `${idx + 1}. [${i.suggested_slot}] ${i.topic} — ${i.angle}\n   почему: ${i.reasoning}`)
    .join("\n\n");
  await sendTelegramMessage(chatId, `Новые идеи в очереди:\n\n${list}`);
}

async function handleReply(chatId, tweetText) {
  const result = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: reply\n\n${tweetText}`,
    maxTokens: 800,
  });
  await sendTelegramMessage(chatId, result);
}
