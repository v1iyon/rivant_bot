import { getAllPosts } from "../lib/db.js";
import { askClaude } from "../lib/claude.js";
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

  const posts = await getAllPosts();
  if (posts.length === 0) {
    return res.status(200).send("no posts yet");
  }

  const report = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: analyze\n\n${JSON.stringify(posts)}`,
    maxTokens: 2000,
  });

  await sendTelegramMessage(process.env.FOUNDER_CHAT_ID, `📊 Еженедельный отчёт\n\n${report}`);
  res.status(200).send("sent");
}
