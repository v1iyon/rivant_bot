import { readFileSync } from "fs";
import { join } from "path";
import { generateTweetUnder280 } from "./claude.js";
import { sendTelegramMessageWithInlineButtons } from "./telegram.js";
import { setIdeaStatus } from "./db.js";

const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), "prompts", "system-prompt.md"),
  "utf-8"
);

// Длинные Premium-форматы (см. prompts/system-prompt.md) — им нужен другой
// лимит длины и больше токенов на ответ, чем обычным коротким постам.
const LONG_FORMATS = new Set(["long_story", "long_case", "long_pain_deepdive"]);

// Отправляет напоминание "пора постить" по конкретной идее из очереди, с
// кнопками "Запостила" / "Пропустить" / "Другую идею" под сообщением.
// Раньше идея сразу помечалась "sent" в момент отправки напоминания — теперь
// только "reminded": она не сгорает молча, если человек проигнорирует
// сообщение или явно скажет "пропускаю".
export async function sendReminderForIdea(idea, chatId) {
  const isLongForm = LONG_FORMATS.has(idea.format);
  const limit = isLongForm ? 2200 : 280;

  const raw = await generateTweetUnder280({
    system: SYSTEM_PROMPT,
    // Раньше тут был "task: reply" — задача, предназначенная для ответов
    // НЕЗНАКОМЦАМ, просто потому что её лимит в 250 символов случайно
    // подходил. С появлением Premium и длинных форматов это путает модель
    // (она отвечает как на чужой твит, а не пишет собственный пост) —
    // поэтому своя задача, "draft-post", прямо для этого случая.
    userMessage: `task: draft-post\n\nGenerate a post draft for this idea, in English:\nTopic: ${idea.topic}\nAngle: ${idea.angle}\nFormat: ${idea.format}\nReasoning: ${idea.reasoning}\n\nRespond in EXACTLY this format, nothing else:\nTWEET: <the English draft, under ${limit} effective characters>\nWHY: <short Russian explanation of why this idea and this time, following the "⏰ пора постить" style>`,
    maxTokens: isLongForm ? 2500 : 600,
    extractTweet: (text) => (text.match(/TWEET:\s*([\s\S]*?)(?:\nWHY:|$)/) || [])[1]?.trim(),
    limit,
  });

  const tweetMatch = raw.match(/TWEET:\s*([\s\S]*?)\nWHY:\s*([\s\S]*)/);
  const extras = [];
  if (idea.include_media) extras.push("📷 Прикрепи фото или видео к этому посту");
  if (idea.include_poll) extras.push("📊 Сделай это опросом (poll), не обычным текстом");
  const extrasText = extras.length ? `\n\n${extras.join("\n")}` : "";

  let draft = tweetMatch
    ? `⏰ Пора постить\n\n${tweetMatch[2].trim()}\n\n📝 Черновик (EN):\n${tweetMatch[1].trim()}${extrasText}`
    : raw;

  // Telegram не доставит сообщение длиннее 4096 символов. Длинный Premium-пост
  // (до ~2200) сам по себе в лимит укладывается, но вместе с русским
  // объяснением и обвязкой может вылезти за край. Если так — укорачиваем
  // только объяснение, сам черновик поста (то, что реально пойдёт в X)
  // никогда не трогаем.
  const TELEGRAM_LIMIT = 4096;
  if (draft.length > TELEGRAM_LIMIT && tweetMatch) {
    const overhead = draft.length - tweetMatch[2].trim().length;
    const whyBudget = Math.max(TELEGRAM_LIMIT - overhead, 0);
    const trimmedWhy =
      tweetMatch[2].trim().slice(0, whyBudget - 20).trim() + "… (объяснение урезано)";
    draft = `⏰ Пора постить\n\n${trimmedWhy}\n\n📝 Черновик (EN):\n${tweetMatch[1].trim()}${extrasText}`;
  }

  await sendTelegramMessageWithInlineButtons(chatId, draft, [
    [
      { text: "✅ Запостила", callback_data: `idea_posted:${idea.id}` },
      { text: "⏭ Пропустить", callback_data: `idea_skip:${idea.id}` },
    ],
    [{ text: "🔁 Дай другую идею на этот слот", callback_data: `idea_other:${idea.id}` }],
  ]);

  await setIdeaStatus(idea.id, "reminded");
}