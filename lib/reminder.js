import { getIdeaForHour, getEngagementIdeaForHour } from "../lib/db.js";
import { sendReminderForIdea } from "../lib/reminder.js";
import { sendEngagementReminder } from "../lib/engagement-reminder.js";
import { sendTelegramMessage } from "../lib/telegram.js";
import { nowParts } from "../lib/time.js";

// Раньше этот файл сам генерировал текст и слал голое сообщение без кнопок,
// сразу помечая идею "sent" — в обход lib/reminder.js (кнопки "Запостила"/
// "Пропустить"/"Другую идею") и в обход lib/time.js (нормальная IANA-таймзона
// с автоучётом лета/зимы). Теперь используется тот же путь, что и везде
// в проекте — единая логика в одном месте.
//
// Один и тот же почасовой крон отвечает и за "пора постить" (content_queue),
// и за "пора отвечать на чужие твиты" (engagement_queue) — это два разных
// напоминания, которые могут в теории совпасть по часу (тогда придут оба
// сообщения отдельно), новая настройка на cron-job.org для этого не нужна.
export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const { hour: currentLocalHour, weekday: currentDayOfWeek } = nowParts();
  const chatId = process.env.FOUNDER_CHAT_ID;

  const [idea, engagementSession] = await Promise.all([
    getIdeaForHour(currentLocalHour, currentDayOfWeek),
    getEngagementIdeaForHour(currentLocalHour, currentDayOfWeek),
  ]);

  const results = [];

  if (idea) {
    try {
      // Генерирует черновик, шлёт с кнопками "✅ Запостила"/"⏭ Пропустить"/
      // "🔁 Другую идею" и помечает идею "reminded" (не "sent") — идея больше
      // не сгорает молча, если напоминание проигнорировать.
      await sendReminderForIdea(idea, chatId);
      results.push("post idea reminded");
    } catch (err) {
      console.error("remind: не удалось отправить напоминание по посту", err);
      try {
        await sendTelegramMessage(
          chatId,
          `⚠️ Не смогла отправить напоминание по идее "${idea.topic}" — ошибка: ${err.message}`
        );
      } catch (notifyErr) {
        console.error("remind: не удалось даже уведомить об ошибке", notifyErr);
      }
      results.push("post idea failed, notified if possible");
    }
  }

  if (engagementSession) {
    try {
      await sendEngagementReminder(engagementSession, chatId);
      results.push("engagement session reminded");
    } catch (err) {
      console.error("remind: не удалось отправить напоминание про вовлечение", err);
      try {
        await sendTelegramMessage(
          chatId,
          `⚠️ Не смогла отправить напоминание про ответы на чужие твиты — ошибка: ${err.message}`
        );
      } catch (notifyErr) {
        console.error("remind: не удалось даже уведомить об ошибке", notifyErr);
      }
      results.push("engagement session failed, notified if possible");
    }
  }

  if (results.length === 0) {
    // Ни поста, ни сессии вовлечения именно на этот час/день — молчим, ничего не шлём
    return res.status(200).send(`nothing matches ${currentDayOfWeek} ${currentLocalHour}:00 local`);
  }

  res.status(200).send(results.join("; "));
}