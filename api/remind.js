import { getIdeaForHour } from "../lib/db.js";
import { sendReminderForIdea } from "../lib/reminder.js";
import { sendTelegramMessage } from "../lib/telegram.js";
import { nowParts } from "../lib/time.js";

// Раньше этот файл сам генерировал текст и слал голое сообщение без кнопок,
// сразу помечая идею "sent" — в обход lib/reminder.js (кнопки "Запостила"/
// "Пропустить"/"Другую идею") и в обход lib/time.js (нормальная IANA-таймзона
// с автоучётом лета/зимы). Теперь используется тот же путь, что и везде
// в проекте — единая логика в одном месте.
export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const { hour: currentLocalHour, weekday: currentDayOfWeek } = nowParts();
  const idea = await getIdeaForHour(currentLocalHour, currentDayOfWeek);

  if (!idea) {
    // Нет идеи именно на этот час/день — молчим, ничего не шлём
    return res.status(200).send(`no idea matches ${currentDayOfWeek} ${currentLocalHour}:00 local`);
  }

  try {
    // Генерирует черновик, шлёт с кнопками "✅ Запостила"/"⏭ Пропустить"/
    // "🔁 Другую идею" и помечает идею "reminded" (не "sent") — идея больше
    // не сгорает молча, если напоминание проигнорировать.
    await sendReminderForIdea(idea, process.env.FOUNDER_CHAT_ID);
    res.status(200).send("reminded");
  } catch (err) {
    // Раньше сбой здесь означал, что напоминание просто не приходило без
    // единого следа — теперь хотя бы факт сбоя долетает в Telegram.
    console.error("remind: не удалось отправить напоминание", err);
    try {
      await sendTelegramMessage(
        process.env.FOUNDER_CHAT_ID,
        `⚠️ Не смогла отправить напоминание по идее "${idea.topic}" — ошибка: ${err.message}`
      );
    } catch (notifyErr) {
      console.error("remind: не удалось даже уведомить об ошибке", notifyErr);
    }
    res.status(200).send("failed, notified if possible");
  }
}
