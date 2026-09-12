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

CREATE TABLE IF NOT EXISTS chat_state (
  chat_id TEXT PRIMARY KEY,
  last_report_at TEXT,
  timezone TEXT DEFAULT 'Europe/Kyiv',
  pending_action TEXT,
  draft_data TEXT
);
