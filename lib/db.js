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

export async function savePost(post) {
  const db = getDb();
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

export async function clearQueuedIdeas() {
  const db = getDb();
  await db.execute("UPDATE content_queue SET status = 'skipped' WHERE status = 'queued'");
}

export async function addQueueIdeas(ideas) {
  const db = getDb();
  for (const idea of ideas) {
    await db.execute({
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
  }
}

export async function getNextQueuedIdea() {
  const db = getDb();
  const res = await db.execute(
    "SELECT * FROM content_queue WHERE status = 'queued' ORDER BY id LIMIT 1"
  );
  return res.rows[0] || null;
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
  const db = getDb();
  await db.execute({
    sql: "UPDATE content_queue SET status = 'sent' WHERE id = ?",
    args: [id],
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
