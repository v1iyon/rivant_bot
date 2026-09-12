import { readFileSync } from "fs";
import { join } from "path";
import { askClaude } from "../lib/claude.js";
import { sendTelegramMessage } from "../lib/telegram.js";
import { savePost, getAllPosts, addQueueIdeas, getNextQueuedIdea, markIdeaSent } from "../lib/db.js";

const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), "prompts", "system-prompt.md"),
  "utf-8"
);

export default async function handler(req, res) {
  // Проверка секрета Telegram (защита от чужих запросов)
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
    if (text.toLowerCase() === "идеи") {
      await handlePlan(chatId);
    } else if (text.toLowerCase().startsWith("ответ:")) {
      await handleReply(chatId, text.slice(6).trim());
    } else if (text.toLowerCase() === "отчёт" || text.toLowerCase() === "отчет") {
      await handleAnalyze(chatId);
    } else {
      await handleIngest(chatId, text);
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
    await sendTelegramMessage(chatId, "Не смогла разобрать сообщение. Напиши, пожалуйста, ещё раз с датой, временем и метриками.");
    return;
  }

  if (parsed.missing_fields?.length) {
    await sendTelegramMessage(
      chatId,
      `Не хватает: ${parsed.missing_fields.join(", ")}. Дошли, пожалуйста.`
    );
    return;
  }

  await savePost(parsed);
  await sendTelegramMessage(
    chatId,
    `Записала: ${parsed.date} ${parsed.time}, тема "${parsed.topic}", ${parsed.views} просмотров, ER ${(
      ((parsed.likes + parsed.replies + parsed.retweets) / (parsed.views || 1)) * 100
    ).toFixed(1)}%`
  );
}

async function handleAnalyze(chatId) {
  const posts = await getAllPosts();
  if (posts.length === 0) {
    await sendTelegramMessage(chatId, "Пока нет ни одного поста в базе. Скинь данные — начнём собирать.");
    return;
  }
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
