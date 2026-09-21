import { getDb } from "./db.js";

// Таблица создаётся при первом обращении — отдельной миграции и правки
// schema.sql / init-db.js не нужно.
let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await getDb().execute(`CREATE TABLE IF NOT EXISTS engage_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_hour INTEGER NOT NULL,
    topic TEXT NOT NULL,
    search_query TEXT,
    angle TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  tableReady = true;
}

// Статусы: 'queued' -> 'reminded' | 'skipped'.
// Вчерашние слоты, до которых дело не дошло, помечаются 'skipped' при новом плане.
export async function skipQueuedSlots() {
  await ensureTable();
  await getDb().execute(
    "UPDATE engage_queue SET status = 'skipped' WHERE status = 'queued'"
  );
}

export async function addEngageSlots(slots) {
  await ensureTable();
  const db = getDb();
  for (const s of slots) {
    await db.execute({
      sql: `INSERT INTO engage_queue (slot_hour, topic, search_query, angle)
            VALUES (?, ?, ?, ?)`,
      args: [s.hour, s.topic, s.query || null, s.angle || null],
    });
  }
}

export async function getDueSlots(hour) {
  await ensureTable();
  const res = await getDb().execute({
    sql: "SELECT * FROM engage_queue WHERE status = 'queued' AND slot_hour = ? ORDER BY id",
    args: [hour],
  });
  return res.rows;
}

export async function setSlotStatus(id, status) {
  await ensureTable();
  await getDb().execute({
    sql: "UPDATE engage_queue SET status = ? WHERE id = ?",
    args: [status, id],
  });
}

// Последние темы — чтобы планировщик не предлагал одно и то же каждый день.
export async function getRecentEngageTopics(limit = 12) {
  await ensureTable();
  const res = await getDb().execute({
    sql: "SELECT topic FROM engage_queue ORDER BY id DESC LIMIT ?",
    args: [limit],
  });
  return res.rows.map((r) => r.topic);
}
