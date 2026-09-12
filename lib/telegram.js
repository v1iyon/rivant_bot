const TG_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Постоянное меню кнопок внизу экрана — видно всегда, не пропадает после ответа
export const MAIN_MENU = {
  keyboard: [
    [{ text: "📊 Отчёт" }, { text: "💡 Идеи" }],
    [{ text: "✍️ Ответ на твит" }, { text: "❓ Помощь" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
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
