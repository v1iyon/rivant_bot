import { sendTelegramMessage } from "../lib/telegram.js";
import { nowParts } from "../lib/time.js";
import { getDueSlots, setSlotStatus } from "../lib/engage.js";

// sendTelegramMessage шлёт с parse_mode: "Markdown" — вычищаем спецсимволы,
// иначе сообщение может молча не дойти.
function stripMarkdown(text) {
  return String(text).replace(/[*_`\[\]]/g, "");
}

function buildMessage(slot) {
  const lines = [
    "💬 Пора отвечать под чужими постами",
    "",
    `Тема: ${slot.topic}`,
  ];
  if (slot.search_query) lines.push(`Что искать в X: ${slot.search_query}`);
  if (slot.angle) lines.push(`Как зайти в ответ: ${slot.angle}`);
  return stripMarkdown(lines.join("\n"));
}

export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  try {
    const { hour } = nowParts();
    const due = await getDueSlots(Number(hour));

    if (!due.length) {
      // Нет слота на этот час — молчим, как и remind.js
      return res.status(200).send(`no engage slot at ${hour}:00 local`);
    }

    let sent = 0;
    for (const slot of due) {
      try {
        await sendTelegramMessage(process.env.FOUNDER_CHAT_ID, buildMessage(slot));
        await setSlotStatus(slot.id, "reminded");
        sent += 1;
      } catch (err) {
        console.error("engage-remind: не удалось отправить напоминание", err);
        try {
          await sendTelegramMessage(
            process.env.FOUNDER_CHAT_ID,
            stripMarkdown(`⚠️ Не смогла отправить напоминание про ответы (тема: ${slot.topic}) — ошибка: ${err.message}`)
          );
        } catch (notifyErr) {
          console.error("engage-remind: не удалось даже уведомить об ошибке", notifyErr);
        }
      }
    }

    res.status(200).send(`reminded ${sent}`);
  } catch (err) {
    console.error("engage-remind: сбой", err);
    res.status(200).send("failed");
  }
}
