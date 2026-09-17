CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_date TEXT NOT NULL,       -- '2026-09-10'
  post_time TEXT NOT NULL,       -- '15:00'
  topic TEXT,                    -- pain / product / case / opinion / news
  format TEXT,                   -- text / text_link / question / list / story
  text_content TEXT,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  retweets INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  had_link INTEGER DEFAULT 0,    -- 0/1
  had_media INTEGER DEFAULT 0,   -- 0/1 — было фото или видео
  had_poll INTEGER DEFAULT 0,    -- 0/1 — был опрос
  engagement_rate REAL,
  hours_since_post REAL,         -- сколько часов прошло между публикацией и моментом,
                                  -- когда цифры занесли в бота (NULL, если не удалось посчитать)
  metrics_checked_at TEXT,       -- когда именно смотрели статистику (UTC, ISO), для прозрачности
  created_at TEXT DEFAULT (datetime('now'))
);

-- Страховка на уровне БД: даже если проверка в коде почему-то не сработает,
-- вставить два поста на одну дату+время не получится.
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_date_time ON posts(post_date, post_time);

CREATE TABLE IF NOT EXISTS content_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT,
  angle TEXT,
  format TEXT,
  suggested_slot TEXT,           -- e.g. '15:00'
  day_of_week TEXT,               -- 'Mon'..'Sun'
  include_media INTEGER DEFAULT 0,
  include_poll INTEGER DEFAULT 0,
  reasoning TEXT,
  status TEXT DEFAULT 'queued',  -- queued / reminded / sent / used / skipped
  created_at TEXT DEFAULT (datetime('now'))
);

-- Очередь "сессий вовлечения" — раз в неделю Клод решает, в какой день/час
-- лучше поискать чужие твиты потенциальных клиентов и ответить на них.
-- Одна строка = одна сессия на один день (в отличие от content_queue, где
-- строка = один пост) — потому что человек ищет и отвечает пачкой за один
-- присест, а не по одному запросу за раз.
CREATE TABLE IF NOT EXISTS engagement_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week TEXT,               -- 'Mon'..'Sun'
  suggested_slot TEXT,            -- 'HH:MM', локальное время автора
  topics TEXT NOT NULL,           -- JSON: [{"search_query":"shopify cash flow","angle":"..."}, ...]
  target_count INTEGER DEFAULT 7, -- скольким людям ответить за эту сессию
  reasoning TEXT,
  status TEXT DEFAULT 'queued',   -- queued / reminded / done / skipped
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_state (
  chat_id TEXT PRIMARY KEY,
  last_report_at TEXT,
  timezone TEXT DEFAULT 'Europe/Kyiv',
  pending_action TEXT,
  draft_data TEXT
);