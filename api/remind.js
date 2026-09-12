import { getIdeaForHour, markIdeaSent } from "../lib/db.js";
import { generateTweetUnder280 } from "../lib/claude.js";
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

  const offsetHours = Number(process.env.LOCAL_UTC_OFFSET || 0);
  const currentHourUTC = new Date().getUTCHours();
  const currentLocalHour = (currentHourUTC + offsetHours + 24) % 24;
  const idea = await getIdeaForHour(currentLocalHour);

  if (!idea) {
    // Нет идеи именно на этот час — молчим, ничего не шлём
    return res.status(200).send(`no idea matches local hour ${currentLocalHour}`);
  }

  const raw = await generateTweetUnder280({
    system: SYSTEM_PROMPT,
    userMessage: `task: reply\n\nGenerate a tweet draft for this idea, in English:\nTopic: ${idea.topic}\nAngle: ${idea.angle}\nFormat: ${idea.format}\nReasoning: ${idea.reasoning}\n\nRespond in EXACTLY this format, nothing else:\nTWEET: <the English tweet draft, under 280 characters>\nWHY: <short Russian explanation of why this idea and this time, following the "⏰ пора постить" style>`,
    maxTokens: 600,
    extractTweet: (text) => (text.match(/TWEET:\s*([\s\S]*?)(?:\nWHY:|$)/) || [])[1]?.trim(),
  });

  const tweetMatch = raw.match(/TWEET:\s*([\s\S]*?)\nWHY:\s*([\s\S]*)/);
  const draft = tweetMatch
    ? `⏰ Пора постить\n\n${tweetMatch[2].trim()}\n\n📝 Черновик (EN):\n${tweetMatch[1].trim()}`
    : raw; // на всякий случай, если формат не распознался

  await sendTelegramMessage(process.env.FOUNDER_CHAT_ID, draft);
  await markIdeaSent(idea.id);

  res.status(200).send("sent");
}
