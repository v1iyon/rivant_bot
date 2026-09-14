import {
  getPendingPostsDueForMetrics,
  markMetricsRequested,
  setDraft,
  setPendingAction,
} from "../lib/db.js";
import { sendTelegramMessage } from "../lib/telegram.js";

// Через сколько часов после публикации имеет смысл спрашивать цифры —
// раньше просмотры/лайки ещё не устоялись и картина будет случайной.
// Можно переопределить переменной окружения METRICS_DELAY_HOURS на Vercel
// без правки кода.
const METRICS_DELAY_HOURS = Number(process.env.METRICS_DELAY_HOURS || 20);

export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const due = await getPendingPostsDueForMetrics(METRICS_DELAY_HOURS);

  if (due.length === 0) {
    return res.status(200).send("nothing due");
  }

  let asked = 0;

  for (const post of due) {
    try {
      // Подставляем в draft то, что уже знаем (дата/время/тема/формат/текст) —
      // дальше человек просто отвечает цифрами по уже существующему мастеру
      // (newpost:views -> likes -> replies -> retweets -> clicks), тому же,
      // что используется и в остальном боте. pendingPostId нужен, чтобы после
      // финального сохранения удалить строку из pending_posts.
      await setDraft(post.chat_id, {
        date: post.post_date,
        time: post.post_time,
        topic: post.topic,
        format: post.format,
        text: post.text_content,
        pendingPostId: post.id,
      });
      await setPendingAction(post.chat_id, "newpost:views");

      await sendTelegramMessage(
        post.chat_id,
        `📈 Как там пост "${post.topic}" (${post.post_date} ${post.post_time})? Пора глянуть цифры.\n\nСколько просмотров?`
      );

      await markMetricsRequested(post.id);
      asked++;
    } catch (err) {
      // Сбой по одному посту не должен блокировать остальные в этом же запуске.
      console.error("check-metrics: не удалось спросить метрики по посту", post.id, err);
    }
  }

  res.status(200).send(`asked for ${asked} of ${due.length}`);
}
