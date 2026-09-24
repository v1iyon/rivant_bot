import { createClient } from "@libsql/client";

let client;

export function getDb() {
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return client;
}

// force=true — сознательно разрешить второй пост на ту же дату+время
// (например, если человек правда опубликовала два поста в один слот).
export async function savePost(post, { force = false } = {}) {
  const db = getDb();

  if (!force) {
    const existing = await db.execute({
      sql: "SELECT id, views, likes FROM posts WHERE post_date = ? AND post_time = ? LIMIT 1",
      args: [post.date, post.time],
    });

    if (existing.rows[0]) {
      const e = existing.rows[0];
      // Бросаем понятную ошибку на русском — она долетит до человека как есть
      // через уже существующий общий catch в telegram-webhook.js, без
      // молчаливой порчи статистики задвоенным постом.
      const err = new Error(
        `Пост на ${post.date} ${post.time} уже есть в базе (id ${e.id}, ${e.views} просмотров, ${e.likes} лайков). Если это правда другой пост — укажи другое время (хотя бы на минуту).`
      );
      err.code = "DUPLICATE_POST";
      throw err;
    }
  }

  const er =
    post.views > 0
      ? ((post.likes + post.replies + post.retweets) / post.views) * 100
      : 0;

  await db.execute({
    sql: `INSERT INTO posts
      (post_date, post_time, topic, format, text_content, views, likes, replies, retweets, clicks, had_link, had_media, had_poll, engagement_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      post.date,
      post.time,
      post.topic || null,
      post.format || null,
      post.text || null,
      post.views || 0,
      post.likes || 0,
      post.replies || 0,
      post.retweets || 0,
      post.clicks || 0,
      post.had_link ? 1 : 0,
      post.had_media ? 1 : 0,
      post.had_poll ? 1 : 0,
      er,
    ],
  });
}

export async function getAllPosts() {
  const db = getDb();
  const res = await db.execute("SELECT * FROM posts ORDER BY post_date, post_time");
  return res.rows;
}

export async function getRecentPosts(limit = 5) {
  const db = getDb();
  const res = await db.execute({
    sql: "SELECT * FROM posts ORDER BY post_date DESC, post_time DESC LIMIT ?",
    args: [limit],
  });
  return res.rows;
}

export async function getPostById(id) {
  const db = getDb();
  const res = await db.execute({ sql: "SELECT * FROM posts WHERE id = ?", args: [id] });
  return res.rows[0] || null;
}

const EDITABLE_POST_FIELDS = new Set(["views", "likes", "replies", "retweets", "clicks", "text_content"]);

// Правит одно поле уже сохранённого поста (команда "исправить" в
// telegram-webhook.js) — перезаписывает все счётчики и пересчитывает
// engagement_rate заново, а не просто UPDATE одного столбца, чтобы ER
// никогда не разъехался с реальными цифрами после правки.
export async function updatePostField(id, field, value) {
  if (!EDITABLE_POST_FIELDS.has(field)) {
    throw new Error(`Поле "${field}" нельзя редактировать этой командой.`);
  }

  const post = await getPostById(id);
  if (!post) {
    throw new Error(`Пост с id ${id} не найден.`);
  }

  const updated = { ...post, [field]: value };
  const er =
    updated.views > 0
      ? ((updated.likes + updated.replies + updated.retweets) / updated.views) * 100
      : 0;

  const db = getDb();
  await db.execute({
    sql: `UPDATE posts SET views = ?, likes = ?, replies = ?, retweets = ?, clicks = ?, text_content = ?, engagement_rate = ? WHERE id = ?`,
    args: [updated.views, updated.likes, updated.replies, updated.retweets, updated.clicks, updated.text_content, er, id],
  });

  return { ...updated, engagement_rate: er };
}

export async function clearQueuedIdeas() {
  const db = getDb();
  await db.execute("UPDATE content_queue SET status = 'skipped' WHERE status = 'queued'");
}

export async function addQueueIdeas(ideas) {
  const db = getDb();
  // Параллельно, а не по одной штуке за раз — 20-30 идей последовательными
  // await-ами внутри 60-секундного окна Vercel уже съедали заметный кусок
  // бюджета времени после долгого вызова Claude, из-за чего вся функция
  // иногда обрывалась целиком. Turso спокойно выдерживает параллельные запросы.
  await Promise.all(
    ideas.map((idea) =>
      db.execute({
        sql: `INSERT INTO content_queue (topic, angle, format, suggested_slot, day_of_week, include_media, include_poll, reasoning)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          idea.topic,
          idea.angle,
          idea.format,
          idea.suggested_slot,
          idea.day_of_week || null,
          idea.include_media ? 1 : 0,
          idea.include_poll ? 1 : 0,
          idea.reasoning,
        ],
      })
    )
  );
}

// Добавляет одну идею в очередь (используется в telegram-webhook.js при "Дай
// другую идею" — замена одной идеи, в отличие от addQueueIdeas, который сразу
// пишет пачку). Возвращает id новой строки, чтобы сразу забрать её обратно
// через getQueueIdeaById.
export async function addSingleQueueIdea(idea) {
  const db = getDb();
  const res = await db.execute({
    sql: `INSERT INTO content_queue (topic, angle, format, suggested_slot, day_of_week, include_media, include_poll, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      idea.topic,
      idea.angle,
      idea.format,
      idea.suggested_slot,
      idea.day_of_week || null,
      idea.include_media ? 1 : 0,
      idea.include_poll ? 1 : 0,
      idea.reasoning,
    ],
  });
  return Number(res.lastInsertRowid);
}

export async function getQueueIdeaById(id) {
  const db = getDb();
  const res = await db.execute({
    sql: "SELECT * FROM content_queue WHERE id = ?",
    args: [id],
  });
  return res.rows[0] || null;
}

export async function getNextQueuedIdea() {
  const db = getDb();
  const res = await db.execute(
    "SELECT * FROM content_queue WHERE status = 'queued' ORDER BY id LIMIT 1"
  );
  return res.rows[0] || null;
}

// Возвращает все ещё не отправленные идеи из очереди (то, что бот уже
// придумал ранее и планирует напомнить) — используется командой "план" в
// telegram-webhook.js, в отличие от handlePlan(), которая генерирует новые.
export async function getQueuedIdeas() {
  const db = getDb();
  const res = await db.execute(
    "SELECT * FROM content_queue WHERE status = 'queued' ORDER BY id"
  );
  return res.rows;
}

export async function getIdeaForHour(hour, dayOfWeek) {
  const db = getDb();
  // hour — число 0-23, dayOfWeek — 'Mon'..'Sun'. Идеи без указанного дня (старые/ручные) тоже подходят.
  const hourStr = String(hour).padStart(2, "0");
  const res = await db.execute({
    sql: `SELECT * FROM content_queue WHERE status = 'queued' AND suggested_slot LIKE ? AND (day_of_week = ? OR day_of_week IS NULL) ORDER BY id LIMIT 1`,
    args: [`${hourStr}:%`, dayOfWeek],
  });
  return res.rows[0] || null;
}

export async function markIdeaSent(id) {
  return setIdeaStatus(id, "sent");
}

// Универсальная смена статуса идеи в очереди: 'queued' -> 'reminded' -> 'sent' / 'skipped'.
// Используется в lib/reminder.js (при отправке напоминания) и в
// api/telegram-webhook.js (при нажатии кнопок "Запостила" / "Пропустить" / "Другую идею").
export async function setIdeaStatus(id, status) {
  const db = getDb();
  await db.execute({
    sql: "UPDATE content_queue SET status = ? WHERE id = ?",
    args: [status, id],
  });
}

// --- pending_posts: пост уже опубликован, но метрики ещё рано спрашивать ---
// (см. schema.sql). Отдельная таблица, а не сразу posts — потому что views/
// likes/etc у только что опубликованного поста бессмысленны, и в posts.
// строка появляется только когда цифры реально есть.

export async function addPendingPost(post) {
  const db = getDb();
  const res = await db.execute({
    sql: `INSERT INTO pending_posts (chat_id, post_date, post_time, topic, format, text_content)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: [String(post.chatId), post.date, post.time, post.topic || null, post.format || null, post.text || null],
  });
  return Number(res.lastInsertRowid);
}

// Возвращает посты, опубликованные >= hoursThreshold часов назад, по которым
// ещё ни разу не спрашивали метрики — используется в api/check-metrics.js.
// Сортировка по posted_at ASC — старые посты спрашиваем первыми, по очереди.
export async function getPendingPostsDueForMetrics(hoursThreshold) {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM pending_posts WHERE metrics_requested = 0 AND posted_at <= datetime('now', ?) ORDER BY posted_at ASC`,
    args: [`-${hoursThreshold} hours`],
  });
  return res.rows;
}

export async function markMetricsRequested(id) {
  const db = getDb();
  await db.execute({
    sql: "UPDATE pending_posts SET metrics_requested = 1 WHERE id = ?",
    args: [id],
  });
}

// Вызывается после того, как цифры по посту успешно записаны в posts —
// строка в pending_posts больше не нужна.
export async function deletePendingPost(id) {
  const db = getDb();
  await db.execute({ sql: "DELETE FROM pending_posts WHERE id = ?", args: [id] });
}

// --- engagement_queue: "пора отвечать на чужие твиты" (см. schema.sql) ---
// Та же логика статусов, что и у content_queue (queued -> reminded ->
// done/skipped), но своя таблица и свой набор полей — сессия вовлечения
// это не пост, а пачка из 2-3 поисковых запросов + сколько людям ответить.

export async function clearQueuedEngagementIdeas() {
  const db = getDb();
  await db.execute("UPDATE engagement_queue SET status = 'skipped' WHERE status = 'queued'");
}

export async function addEngagementIdeas(sessions) {
  const db = getDb();
  await Promise.all(
    sessions.map((s) =>
      db.execute({
        sql: `INSERT INTO engagement_queue (day_of_week, suggested_slot, topics, target_count, reasoning)
          VALUES (?, ?, ?, ?, ?)`,
        args: [
          s.day_of_week || null,
          s.suggested_slot,
          JSON.stringify(s.topics || []),
          s.target_count || 7,
          s.reasoning || null,
        ],
      })
    )
  );
}

// Строки из Turso отдают topics как обычную строку — распаковываем JSON тут
// же, в одном месте, чтобы вызывающему коду не приходилось помнить об этом
// на каждом сайте использования.
function hydrateEngagementRow(row) {
  if (!row) return row;
  let topics = [];
  try {
    topics = JSON.parse(row.topics || "[]");
  } catch {
    topics = [];
  }
  return { ...row, topics };
}

export async function getEngagementIdeaForHour(hour, dayOfWeek) {
  const db = getDb();
  const hourStr = String(hour).padStart(2, "0");
  const res = await db.execute({
    sql: `SELECT * FROM engagement_queue WHERE status = 'queued' AND suggested_slot LIKE ? AND (day_of_week = ? OR day_of_week IS NULL) ORDER BY id LIMIT 1`,
    args: [`${hourStr}:%`, dayOfWeek],
  });
  return hydrateEngagementRow(res.rows[0] || null);
}

export async function getEngagementIdeaById(id) {
  const db = getDb();
  const res = await db.execute({ sql: "SELECT * FROM engagement_queue WHERE id = ?", args: [id] });
  return hydrateEngagementRow(res.rows[0] || null);
}

export async function getQueuedEngagementIdeas() {
  const db = getDb();
  const res = await db.execute("SELECT * FROM engagement_queue WHERE status = 'queued' ORDER BY id");
  return res.rows.map(hydrateEngagementRow);
}

export async function setEngagementStatus(id, status) {
  const db = getDb();
  await db.execute({
    sql: "UPDATE engagement_queue SET status = ? WHERE id = ?",
    args: [status, id],
  });
}

export async function getPendingAction(chatId) {
  const db = getDb();
  const res = await db.execute({
    sql: "SELECT pending_action FROM chat_state WHERE chat_id = ?",
    args: [String(chatId)],
  });
  return res.rows[0]?.pending_action || null;
}

export async function setPendingAction(chatId, action) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO chat_state (chat_id, pending_action) VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET pending_action = excluded.pending_action`,
    args: [String(chatId), action],
  });
}

export async function getDraft(chatId) {
  const db = getDb();
  const res = await db.execute({
    sql: "SELECT draft_data FROM chat_state WHERE chat_id = ?",
    args: [String(chatId)],
  });
  const raw = res.rows[0]?.draft_data;
  return raw ? JSON.parse(raw) : {};
}

export async function setDraft(chatId, draftObj) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO chat_state (chat_id, draft_data) VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET draft_data = excluded.draft_data`,
    args: [String(chatId), JSON.stringify(draftObj)],
  });
}

export async function clearFlow(chatId) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO chat_state (chat_id, pending_action, draft_data) VALUES (?, NULL, NULL)
      ON CONFLICT(chat_id) DO UPDATE SET pending_action = NULL, draft_data = NULL`,
    args: [String(chatId)],
  });
}