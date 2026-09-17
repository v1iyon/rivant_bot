import { sendTelegramMessageWithInlineButtons } from "./telegram.js";
import { setEngagementStatus } from "./db.js";

// Отправляет напоминание "пора отвечать на чужие твиты" по конкретной сессии
// из engagement_queue, с кнопками "✅ Сделала" / "⏭ Пропустить" под сообщением —
// та же логика трекинга, что и у content-плана (lib/reminder.js), но своя
// таблица и свой текст: тут не черновик поста, а список поисковых запросов.
export async function sendEngagementReminder(session, chatId) {
  const topicsList = session.topics
    .map((t) => `🔍 *${t.search_query}*\n   ${t.angle}`)
    .join("\n\n");

  const text = `💬 Пора отвечать на чужие твиты\n\nСегодняшние темы для поиска:\n\n${topicsList}\n\nОтветь примерно ${session.target_count} людям по этим запросам. Как найдёшь подходящий твит — кидай мне его текст (кнопка «✍️ Ответ на твит» или просто "ответ: <текст>"), я предложу черновик ответа под RIVANT.`;

  await sendTelegramMessageWithInlineButtons(chatId, text, [
    [
      { text: "✅ Сделала", callback_data: `engagement_done:${session.id}` },
      { text: "⏭ Пропустить", callback_data: `engagement_skip:${session.id}` },
    ],
  ]);

  await setEngagementStatus(session.id, "reminded");
}