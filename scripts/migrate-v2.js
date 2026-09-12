// Миграция для БАЗЫ, В КОТОРОЙ УЖЕ ЕСТЬ ДАННЫЕ (например, твои 9+ постов).
// schema.sql с CREATE TABLE IF NOT EXISTS не добавляет новые колонки в уже
// существующие таблицы — для этого нужен отдельный ALTER TABLE, вот он.
// Скрипт безопасно перезапускать сколько угодно раз — уже существующие
// колонки просто пропускаются.
import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ALTERS = [
  "ALTER TABLE posts ADD COLUMN hours_since_post REAL",
  "ALTER TABLE posts ADD COLUMN metrics_checked_at TEXT",
];

for (const sql of ALTERS) {
  try {
    await client.execute(sql);
    console.log("OK:", sql);
  } catch (err) {
    if (String(err.message || err).toLowerCase().includes("duplicate column")) {
      console.log("уже есть, пропускаю:", sql);
    } else {
      throw err;
    }
  }
}

console.log("\nГотово. Старые посты (без hours_since_post) не потеряны —");
console.log("просто для них это поле будет NULL, и отчёт будет честно");
console.log("считать их данными без поправки на скорость набора просмотров,");
console.log("без ошибки и без пересчёта задним числом.");
