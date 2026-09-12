const TG_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Постоянное меню кнопок внизу экрана — видно всегда, не пропадает после ответа
export const MAIN_MENU = {
  keyboard: [
    [{ text: "📊 Отчёт" }, { text: "💡 Идеи" }],
    [{ text: "➕ Новый пост" }, { text: "✍️ Ответ на твит" }],
    [{ text: "❓ Помощь" }],
  ],
  resize_keyboard: true,
};

export async function sendTelegramMessage(chatId, text, options = {}) {
  const { keyboard = MAIN_MENU, removeKeyboard = false } = options;

  const reply_markup = removeKeyboard
    ? { remove_keyboard: true }
    : keyboard;

  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup,
    }),
  });
}

export async function sendTelegramPhoto(chatId, photoUrl, caption = "") {
  await fetch(`${TG_API}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoUrl,
      caption,
    }),
  });
}

// Инлайн-кнопки под конкретным сообщением (не путать с постоянным нижним
// меню MAIN_MENU) — используются, например, под напоминанием "пора постить":
// "✅ Запостила" / "⏭ Пропустить" / "🔁 Другую идею".
export async function sendTelegramMessageWithInlineButtons(chatId, text, inlineKeyboard) {
  const res = await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: inlineKeyboard },
    }),
  });
  return res.json();
}

// Telegram требует "ответить" на нажатие инлайн-кнопки (callback_query),
// иначе у человека крутится бесконечный спиннер на кнопке.
export async function answerCallbackQuery(callbackQueryId, text = "") {
  await fetch(`${TG_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

// Убирает инлайн-кнопки из уже отправленного сообщения (например, после того
// как человек нажал "Пропустить") — чтобы нельзя было нажать дважды и не
// путаться, какая кнопка ещё активна.
export async function clearInlineButtons(chatId, messageId) {
  await fetch(`${TG_API}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }),
  });
}
