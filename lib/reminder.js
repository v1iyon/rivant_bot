import { readFileSync } from "fs";
import { join } from "path";
import { generateTweetUnder280 } from "./claude.js";
import { sendTelegramMessageWithInlineButtons } from "./telegram.js";
import { setIdeaStatus } from "./db.js";

const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), "prompts", "system-prompt.md"),
  "utf-8"
);

// Отправляет напоминание "пора постить" по конкретной идее из очереди, с
// кнопками "Запостила" / "Пропустить" / "Другую идею" под сообщением.
// Раньше идея сразу помечалась "sent" в момент отправки напоминания — теперь
// только "reminded": она не сгорает молча, если человек проигнорирует
// сообщение или явно скажет "пропускаю".
export async function sendReminderForIdea(idea, chatId) {
  const raw = await generateTweetUnder280({
    system: SYSTEM_PROMPT,
    userMessage: `task: reply\n\nGenerate a tweet draft for this idea, in English:\nTopic: ${idea.topic}\nAngle: ${idea.angle}\nFormat: ${idea.format}\nReasoning: ${idea.reasoning}\n\nRespond in EXACTLY this format, nothing else:\nTWEET: <the English tweet draft, under 280 characters>\nWHY: <short Russian explanation of why this idea and this time, following the "⏰ пора постить" style>`,
    maxTokens: 600,
    extractTweet: (text) => (text.match(/TWEET:\s*([\s\S]*?)(?:\nWHY:|$)/) || [])[1]?.trim(),
  });

  const tweetMatch = raw.match(/TWEET:\s*([\s\S]*?)\nWHY:\s*([\s\S]*)/);
  const extras = [];
  if (idea.include_media) extras.push("📷 Прикрепи фото или видео к этому посту");
  if (idea.include_poll) extras.push("📊 Сделай это опросом (poll), не обычным текстом");
  const extrasText = extras.length ? `\n\n${extras.join("\n")}` : "";

  const draft = tweetMatch
    ? `⏰ Пора постить\n\n${tweetMatch[2].trim()}\n\n📝 Черновик (EN):\n${tweetMatch[1].trim()}${extrasText}`
    : raw;

  await sendTelegramMessageWithInlineButtons(chatId, draft, [
    [
      { text: "✅ Запостила", callback_data: `idea_posted:${idea.id}` },
      { text: "⏭ Пропустить", callback_data: `idea_skip:${idea.id}` },
    ],
    [{ text: "🔁 Дай другую идею на этот слот", callback_data: `idea_other:${idea.id}` }],
  ]);

  await setIdeaStatus(idea.id, "reminded");
}