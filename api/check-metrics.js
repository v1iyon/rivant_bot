import {
  getPendingPostsDueForMetrics,
  markMetricsRequested,
  setDraft,
  setPendingAction,
  getPendingAction,
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

  const chatId = due[0].chat_id;

  // Черновик (draft) и pending_action в базе — ОДИН на весь чат, общий с
  // обычным мастером "➕ Новый пост". Раньше этот файл в цикле спрашивал
  // сразу про ВСЕ due-посты подряд: каждый следующий setDraft/setPendingAction
  // затирал предыдущий, поэтому ответ человека на самый первый вопрос
  // "Сколько просмотров?" на самом деле улетал в данные совсем другого,
  // последнего в списке поста — и все посты, кроме последнего, оставались
  // помеченными metrics_requested=1 и больше никогда не спрашивались.
  // Теперь: если чат уже занят каким-то мастером (в том числе этим же —
  // ответом на предыдущий вопрос про метрики), просто молчим в этот прогон.
  // Due-посты остаются metrics_requested=0, следующий часовой запуск спросит
  // снова, как только мастер освободится.
  const currentAction = await getPendingAction(chatId);
  if (currentAction) {
    return res
      .status(200)
      .send(`chat busy (${currentAction}), postponing ${due.length} due post(s)`);
  }

  // Спрашиваем строго про ОДИН пост за раз — самый старый по дате публикации
  // (due отсортирован по posted_at в lib/db.js). Как только человек пройдёт
  // весь мастер до конца, черновик очистится и pending_action станет пустым —
  // следующий часовой прогон подхватит следующий пост по очереди сам.
  const post = due[0];

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

    const queueNote =
      due.length > 1 ? `\n\n(в очереди на метрики ещё ${due.length - 1})` : "";

    await sendTelegramMessage(
      post.chat_id,
      `📈 Как там пост "${post.topic}" (${post.post_date} ${post.post_time})? Пора глянуть цифры.${queueNote}\n\nСколько просмотров?`
    );

    await markMetricsRequested(post.id);
    res.status(200).send(`asked about post ${post.id}, ${due.length - 1} left in queue`);
  } catch (err) {
    console.error("check-metrics: не удалось спросить метрики по посту", post.id, err);
    try {
      await sendTelegramMessage(
        post.chat_id,
        `⚠️ Не смогла спросить метрики по посту "${post.topic}" — ошибка: ${err.message}`
      );
    } catch (notifyErr) {
      console.error("check-metrics: не удалось даже уведомить об ошибке", notifyErr);
    }
    res.status(200).send("failed, notified if possible");
  }
}
