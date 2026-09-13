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

export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const chatId = process.env.FOUNDER_CHAT_ID;

  try {
    const posts = await getAllPosts();
    if (posts.length === 0) {
      return res.status(200).send("no posts yet");
    }

    const stats = computeStats(posts);

    const ideasRaw = await askClaude({
      system: SYSTEM_PROMPT,
      userMessage: `task: plan\n\n${JSON.stringify(stats)}`,
      maxTokens: 3000,
    });

    const ideas = extractJson(ideasRaw);

    if (!Array.isArray(ideas)) {
      console.error("weekly-plan: не смогла распознать JSON с идеями:", ideasRaw);
      await sendTelegramMessage(
        chatId,
        "⚠️ План на неделю сгенерировать не смогла — Клод ответил не в ожидаемом формате. Напиши мне «идеи», чтобы попробовать ещё раз."
      );
      return res.status(200).send("ideas parse failed");
    }

    await addQueueIdeas(ideas);

    const list = ideas
      .map((i, idx) => `${idx + 1}. [${i.day_of_week || "?"} ${i.suggested_slot}] ${i.topic} — ${i.angle}`)
      .join("\n");

    await sendTelegramMessage(
      chatId,
      `💡 План на неделю (буду сама напоминать в эти часы):\n\n${list}`
    );

    res.status(200).send("plan sent");
  } catch (err) {
    console.error("weekly-plan: ошибка", err);
    try {
      await sendTelegramMessage(chatId, `⚠️ План на неделю не удалось сгенерировать — ошибка: ${err.message}`);
    } catch (notifyErr) {
      console.error("weekly-plan: не удалось даже уведомить об ошибке", notifyErr);
    }
    res.status(200).send("failed, notified if possible");
  }
}
