import { getAllPosts, addQueueIdeas } from "../lib/db.js";
import { computeStats } from "../lib/analytics.js";
import { barChart } from "../lib/charts.js";
import { askClaude } from "../lib/claude.js";
import { sendTelegramMessage, sendTelegramPhoto } from "../lib/telegram.js";
import { readFileSync } from "fs";
import { join } from "path";

const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), "prompts", "system-prompt.md"),
  "utf-8"
);

export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const posts = await getAllPosts();
  if (posts.length === 0) {
    return res.status(200).send("no posts yet");
  }

  const stats = computeStats(posts);
  const chatId = process.env.FOUNDER_CHAT_ID;

  // 1. Текстовый разбор от Клода, на основе реальных посчитанных цифр
  const report = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: analyze\n\n${JSON.stringify(stats)}`,
    maxTokens: 2000,
  });
  await sendTelegramMessage(chatId, `📊 Еженедельный отчёт (постов в базе: ${stats.totalPosts})\n\n${report}`);

  // 2. Графики картинками — по часам и по дням недели
  if (stats.byHour.length > 1) {
    await sendTelegramPhoto(chatId, barChart(stats.byHour, "ER по часам публикации"), "ER (%) по часам");
  }
  if (stats.byWeekday.length > 1) {
    await sendTelegramPhoto(chatId, barChart(stats.byWeekday, "ER по дням недели"), "ER (%) по дням недели");
  }
  if (stats.byTopic.length > 1) {
    await sendTelegramPhoto(chatId, barChart(stats.byTopic, "ER по темам"), "ER (%) по темам постов");
  }

  // 3. План на неделю — пополняет очередь, бот сам будет присылать по расписанию
  const ideasRaw = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: plan\n\n${JSON.stringify(stats)}`,
    maxTokens: 3000,
  });

  try {
    const ideas = JSON.parse(ideasRaw);
    await addQueueIdeas(ideas);
    const list = ideas
      .map((i, idx) => `${idx + 1}. [${i.day_of_week || "?"} ${i.suggested_slot}] ${i.topic} — ${i.angle}`)
      .join("\n");
    await sendTelegramMessage(
      chatId,
      `💡 План на неделю (буду сама напоминать в эти часы):\n\n${list}`
    );
  } catch {
    console.error("Failed to parse ideas in weekly-report");
  }

  res.status(200).send("sent");
}
