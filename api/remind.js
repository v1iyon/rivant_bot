import { getNextQueuedIdea, markIdeaSent } from "../lib/db.js";
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

  const idea = await getNextQueuedIdea();
  if (!idea) {
    return res.status(200).send("no idea queued");
  }

  const draft = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: reply\n\nGenerate a tweet draft for this idea, in English:\nTopic: ${idea.topic}\nAngle: ${idea.angle}\nFormat: ${idea.format}\nReasoning: ${idea.reasoning}\n\nThen give a short Russian intro explaining why now, following the "⏰ пора постить" format.`,
    maxTokens: 600,
  });

  await sendTelegramMessage(process.env.FOUNDER_CHAT_ID, draft);
  await markIdeaSent(idea.id);

  res.status(200).send("sent");
}
