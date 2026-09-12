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
      (post_date, post_time, topic, format, text_content, views, likes, replies, retweets, clicks, had_link, engagement_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      er,
    ],
  });
}

export async function getAllPosts() {
  const db = getDb();
  const res = await db.execute("SELECT * FROM posts ORDER BY post_date, post_time");
  return res.rows;
}

export async function addQueueIdeas(ideas) {
  const db = getDb();
  for (const idea of ideas) {
    await db.execute({
      sql: `INSERT INTO content_queue (topic, angle, format, suggested_slot, reasoning)
            VALUES (?, ?, ?, ?, ?)`,
      args: [idea.topic, idea.angle, idea.format, idea.suggested_slot, idea.reasoning],
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

export async function markIdeaSent(id) {
  const db = getDb();
  await db.execute({
    sql: "UPDATE content_queue SET status = 'sent' WHERE id = ?",
    args: [id],
  });
}
