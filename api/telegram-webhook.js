import { readFileSync } from "fs";
import { join } from "path";
import { askClaude } from "../lib/claude.js";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  answerCallbackQuery,
  clearInlineButtons,
  MAIN_MENU,
} from "../lib/telegram.js";
import { computeStats } from "../lib/analytics.js";
import { barChart } from "../lib/charts.js";
import { sendReminderForIdea } from "../lib/reminder.js";
import { hoursSincePost, todayLocal } from "../lib/time.js";
import { extractJson } from "../lib/parse.js";
import {
  savePost,
  getAllPosts,
  getRecentPosts,
  getPostById,
  updatePostField,
  addQueueIdeas,
  clearQueuedIdeas,
  addSingleQueueIdea,
  getQueueIdeaById,
  setIdeaStatus,
  getPendingAction,
  setPendingAction,
  getDraft,
  setDraft,
  clearFlow,
  getQueuedIdeas,
  addPendingPost,
  deletePendingPost,
  clearQueuedEngagementIdeas,
  addEngagementIdeas,
  getEngagementIdeaById,
  setEngagementStatus,
  getQueuedEngagementIdeas,
} from "../lib/db.js";

const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), "prompts", "system-prompt.md"),
  "utf-8"
);

const HELP_TEXT = `Вот что я умею:

📊 *Отчёт* — анализ всех твоих постов
💡 *Идеи* — новые идеи постов на основе данных
📋 *План* — покажу, что уже в очереди на публикацию
➕ *Новый пост* — запишу пост в базу, спрошу всё по шагам
✏️ *Исправить* — поправлю цифры или текст в уже сохранённом посте
✍️ *Ответ на твит* — черновик ответа клиенту

В любой момент шаговых вопросов можно нажать другую кнопку меню — текущий ввод отменится.

Под каждым напоминанием "⏰ Пора постить" есть кнопки:
✅ *Запостила* — сохраню текст поста, а цифры сама спрошу через ~20 часов, когда будет что показывать
⏭ *Пропустить* — идея не потеряна, просто помечается пропущенной
🔁 *Дай другую идею* — предложу другой угол на этот же слот

Раз в неделю (вместе с планом постов) я также планирую, когда тебе стоит отвечать на чужие твиты — раз в день пришлю "💬 Пора отвечать на чужие твиты" с 2-3 поисковыми запросами и тем, скольким людям стоит ответить. Кнопки под этим напоминанием:
✅ *Сделала* — отмечу сессию выполненной
⏭ *Пропустить* — сессия не потеряна, просто помечается пропущенной`;

const TOPIC_KEYBOARD = {
  keyboard: [
    [{ text: "Боль" }, { text: "Продукт" }],
    [{ text: "Кейс" }, { text: "Мнение" }],
    [{ text: "Новость" }],
  ],
  resize_keyboard: true,
};

const YES_NO_KEYBOARD = {
  keyboard: [[{ text: "Да" }, { text: "Нет" }]],
  resize_keyboard: true,
};

const FIELD_KEYBOARD = {
  keyboard: [
    [{ text: "Просмотры" }, { text: "Лайки" }],
    [{ text: "Ответы" }, { text: "Ретвиты" }],
    [{ text: "Клики" }, { text: "Текст" }],
    [{ text: "Отмена" }],
  ],
  resize_keyboard: true,
};

const FIELD_MAP = {
  "просмотры": "views",
  "лайки": "likes",
  "ответы": "replies",
  "ретвиты": "retweets",
  "клики": "clicks",
  "текст": "text_content",
};

const FIELD_LABELS = {
  views: "просмотры",
  likes: "лайки",
  replies: "ответы",
  retweets: "ретвиты",
  clicks: "клики",
  text_content: "текст",
};

const TOPIC_MAP = {
  "боль": "pain",
  "продукт": "product",
  "кейс": "case",
  "мнение": "opinion",
  "новость": "news",
};

const RU_MONTHS = {
  "январ": "01", "феврал": "02", "март": "03", "апрел": "04",
  "ма": "05", "июн": "06", "июл": "07", "август": "08",
  "сентябр": "09", "октябр": "10", "ноябр": "11", "декабр": "12",
};

function parseRuDate(text) {
  const t = text.trim().toLowerCase();

  // формат 10.09 или 10/09 или 2026-09-10
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = t.match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{4}))?$/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    const year = m[3] || "2026";
    return `${year}-${month}-${day}`;
  }

  // формат "10 сентября"
  m = t.match(/^(\d{1,2})\s+([а-я]+)/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const monthWord = m[2];
    const monthKey = Object.keys(RU_MONTHS).find((k) => monthWord.startsWith(k));
    if (monthKey) return `2026-${RU_MONTHS[monthKey]}-${day}`;
  }

  return null;
}

function parseTime(text) {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = m[1].padStart(2, "0");
  return `${h}:${m[2]}`;
}

function parseNumber(text) {
  const cleaned = text.trim().replace(/\s/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export default async function handler(req, res) {
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const update = req.body;

  // Нажатие инлайн-кнопки под напоминанием: либо про пост ("Запостила" /
  // "Пропустить" / "Другую идею"), либо про сессию вовлечения ("Сделала" /
  // "Пропустить") — различаем по префиксу callback_data.
  if (update?.callback_query) {
    try {
      const action = (update.callback_query.data || "").split(":")[0];
      if (action.startsWith("engagement_")) {
        await handleEngagementCallback(update.callback_query);
      } else {
        await handleIdeaCallback(update.callback_query);
      }
    } catch (err) {
      console.error(err);
    }
    return res.status(200).send("ok");
  }

  const message = update?.message;
  if (!message || !message.text) {
    return res.status(200).send("ok");
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  // Момент, когда человек фактически отправил это сообщение — используем как
  // "когда смотрели статистику" при записи поста, без лишнего вопроса боту.
  const messageAtMs = message.date ? message.date * 1000 : Date.now();

  const MENU_BUTTONS = ["📊 Отчёт", "💡 Идеи", "➕ Новый пост", "✏️ Исправить", "✍️ Ответ на твит", "❓ Помощь"];

  try {
    if (text === "/start") {
      await clearFlow(chatId);
      await sendTelegramMessage(chatId, "Привет! Я твой аналитик и контент-стратег для X.\n\n" + HELP_TEXT);
    } else if (MENU_BUTTONS.includes(text)) {
      // Любая кнопка меню сбрасывает текущий мастер ввода
      await clearFlow(chatId);

      if (text === "❓ Помощь") {
        await sendTelegramMessage(chatId, HELP_TEXT);
      } else if (text === "📊 Отчёт") {
        await handleAnalyze(chatId);
      } else if (text === "💡 Идеи") {
        await handlePlan(chatId);
      } else if (text === "➕ Новый пост") {
        await setDraft(chatId, {});
        await setPendingAction(chatId, "newpost:date");
        await sendTelegramMessage(chatId, "Дата поста? (например: 10 сентября, или 10.09)");
      } else if (text === "✏️ Исправить") {
        await handleFixStart(chatId);
      } else if (text === "✍️ Ответ на твит") {
        await setPendingAction(chatId, "awaiting_tweet");
        await sendTelegramMessage(chatId, "Скинь текст твита, на который нужно ответить.", { keyboard: undefined });
      }
    } else if (text.trim().toLowerCase() === "план") {
      // Отдельная команда: показывает то, что УЖЕ есть в очереди, без
      // обращения к Claude — в отличие от handlePlan() (кнопка "Идеи").
      await clearFlow(chatId);
      await handleShowPlan(chatId);
    } else if (text.trim().toLowerCase() === "исправить") {
      await handleFixStart(chatId);
    } else {
      const pending = await getPendingAction(chatId);

      if (pending === "awaiting_tweet") {
        await clearFlow(chatId);
        await handleReply(chatId, text);
      } else if (pending === "newpost:text-onpost") {
        // Особая ветка мастера: пост ТОЛЬКО ЧТО опубликован (кнопка
        // "Запостила"), просмотров ещё физически быть не может — сохраняем
        // факт публикации + текст в pending_posts и НЕ спрашиваем цифры
        // сейчас. Цифры спросит api/check-metrics.js сам, через ~20 часов.
        await handlePostedNow(chatId, pending, text);
      } else if (pending && pending.startsWith("fix:")) {
        await handleFixStep(chatId, pending, text);
      } else if (pending && pending.startsWith("newpost:")) {
        await handlePostWizardStep(chatId, pending, text, messageAtMs);
      } else {
        // Никакого мастера не идёт — по умолчанию считаем это старым способом (весь пост одним сообщением)
        await handleIngest(chatId, text, messageAtMs);
      }
    }
  } catch (err) {
    console.error(err);
    await clearFlow(chatId);

    const msg = err.message || "";
    let userMessage;

    if (err.name === "AbortError" || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)) {
      // Claude API долго не отвечал (обе попытки, см. lib/claude.js) — не наша
      // проблема, но пользователю это должно звучать по-человечески.
      userMessage = "Claude сейчас отвечает медленнее обычного, попробуй, пожалуйста, ещё раз через минуту.";
    } else if (/credit balance is too low/i.test(msg)) {
      userMessage = "На балансе Anthropic закончились кредиты — это по моей части, уже разбираюсь.";
    } else {
      // Неожиданная ошибка — оставляем как есть, это помогает при отладке.
      userMessage = `Ошибка: ${msg}`;
    }

    await sendTelegramMessage(chatId, userMessage);
  }

  res.status(200).send("ok");
}

// --- Редактирование уже сохранённого поста ("✏️ Исправить" / команда "исправить") ---

async function handleFixStart(chatId) {
  await clearFlow(chatId);

  const posts = await getRecentPosts(5);
  if (posts.length === 0) {
    await sendTelegramMessage(chatId, "Пока нет ни одного сохранённого поста, нечего исправлять.");
    return;
  }

  const list = posts
    .map((p, idx) => `${idx + 1}. ${p.post_date} ${p.post_time} — "${p.topic || "?"}", ${p.views} просм., ${p.likes} лайков`)
    .join("\n");

  // Запоминаем id-шники по номеру, чтобы на следующем шаге не гадать по тексту.
  await setDraft(chatId, { fixCandidates: posts.map((p) => p.id) });
  await setPendingAction(chatId, "fix:select");
  await sendTelegramMessage(chatId, `Какой пост поправить? Напиши номер:\n\n${list}`, { keyboard: undefined });
}

async function handleFixStep(chatId, step, text) {
  const draft = await getDraft(chatId);

  if (step === "fix:select") {
    const n = Number(text.trim());
    const postId = draft.fixCandidates?.[n - 1];
    if (!postId) {
      await sendTelegramMessage(chatId, "Не поняла номер. Напиши цифру из списка выше.");
      return;
    }
    await setDraft(chatId, { fixPostId: postId });
    await setPendingAction(chatId, "fix:field");
    await sendTelegramMessage(chatId, "Что поправить?", { keyboard: FIELD_KEYBOARD });
  } else if (step === "fix:field") {
    const t = text.trim().toLowerCase();
    if (t === "отмена") {
      await clearFlow(chatId);
      await sendTelegramMessage(chatId, "Ок, отменила.", { keyboard: undefined });
      return;
    }
    const field = FIELD_MAP[t];
    if (!field) {
      await sendTelegramMessage(chatId, "Выбери одну из кнопок ниже.", { keyboard: FIELD_KEYBOARD });
      return;
    }
    await setDraft(chatId, { ...draft, fixField: field });
    await setPendingAction(chatId, "fix:value");
    const prompt = field === "text_content" ? "Пришли новый текст поста." : `Новое значение для "${FIELD_LABELS[field]}"?`;
    await sendTelegramMessage(chatId, prompt, { keyboard: undefined });
  } else if (step === "fix:value") {
    const { fixPostId, fixField } = draft;
    let value;

    if (fixField === "text_content") {
      value = text;
    } else {
      value = parseNumber(text);
      if (value === null) {
        await sendTelegramMessage(chatId, "Введи число, например 4200");
        return;
      }
    }

    const updated = await updatePostField(fixPostId, fixField, value);
    await clearFlow(chatId);

    await sendTelegramMessage(
      chatId,
      `✅ Поправила: у поста от ${updated.post_date} ${updated.post_time} теперь "${FIELD_LABELS[fixField]}" = ${fixField === "text_content" ? `"${value}"` : value}. Новый ER: ${updated.engagement_rate.toFixed(1)}%`
    );
  }
}

// Сохраняет только что опубликованный пост (текст + факт публикации) в
// pending_posts, БЕЗ вопросов про просмотры/лайки — им ещё физически рано
// быть значимыми. Метрики бот спросит сам позже, см. api/check-metrics.js.
async function handlePostedNow(chatId, step, text) {
  const draft = await getDraft(chatId);

  await addPendingPost({
    chatId,
    date: draft.date,
    time: draft.time,
    topic: draft.topic,
    format: draft.format,
    text,
  });

  await clearFlow(chatId);

  await sendTelegramMessage(
    chatId,
    `✅ Записала, что запостила: "${draft.topic}" в ${draft.time}. Через ~20 часов сама спрошу, как там цифры.`
  );
}

async function handlePostWizardStep(chatId, step, text, messageAtMs) {
  const draft = await getDraft(chatId);

  if (step === "newpost:date") {
    const date = parseRuDate(text);
    if (!date) {
      await sendTelegramMessage(chatId, "Не поняла дату. Напиши так: 10 сентября или 10.09");
      return;
    }
    draft.date = date;
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:time");
    await sendTelegramMessage(chatId, "Время? (например: 15:00)");
  } else if (step === "newpost:time") {
    const time = parseTime(text);
    if (!time) {
      await sendTelegramMessage(chatId, "Не поняла время. Формат ЧЧ:ММ, например 15:00");
      return;
    }
    draft.time = time;
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:text");
    await sendTelegramMessage(chatId, "Скинь точный текст поста, как он опубликован (не пересказ) — это нужно для качественного анализа, что именно сработало.");
  } else if (step === "newpost:text") {
    // Просим ИМЕННО опубликованный текст, не пересказ — качественный анализ
    // (хук, структура, CTA) возможен только по реальному тексту поста.
    draft.text = text;
    await setDraft(chatId, draft);

    if (draft.topic && draft.format) {
      // Такое бывает, если пришли сюда не через "Запостила", а вручную
      // указали тему/формат заранее — сразу к цифрам.
      await setPendingAction(chatId, "newpost:views");
      await sendTelegramMessage(chatId, "Сколько просмотров?", { keyboard: undefined });
    } else {
      await setPendingAction(chatId, "newpost:topic");
      await sendTelegramMessage(chatId, "Какая это категория?", { keyboard: TOPIC_KEYBOARD });
    }
  } else if (step === "newpost:topic") {
    const topic = TOPIC_MAP[text.trim().toLowerCase()];
    if (!topic) {
      await sendTelegramMessage(chatId, "Выбери одну из кнопок ниже.", { keyboard: TOPIC_KEYBOARD });
      return;
    }
    draft.topic = topic;
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:link");
    await sendTelegramMessage(chatId, "Была ссылка в посте?", { keyboard: YES_NO_KEYBOARD });
  } else if (step === "newpost:link") {
    const t = text.trim().toLowerCase();
    if (t !== "да" && t !== "нет") {
      await sendTelegramMessage(chatId, "Ответь Да или Нет.", { keyboard: YES_NO_KEYBOARD });
      return;
    }
    draft.had_link = t === "да";
    draft.format = draft.had_link ? "text_link" : (draft.text.trim().endsWith("?") ? "question" : "text");
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:media");
    await sendTelegramMessage(chatId, "Было фото или видео в посте?", { keyboard: YES_NO_KEYBOARD });
  } else if (step === "newpost:media") {
    const t = text.trim().toLowerCase();
    if (t !== "да" && t !== "нет") {
      await sendTelegramMessage(chatId, "Ответь Да или Нет.", { keyboard: YES_NO_KEYBOARD });
      return;
    }
    draft.had_media = t === "да";
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:poll");
    await sendTelegramMessage(chatId, "Был опрос (poll) в посте?", { keyboard: YES_NO_KEYBOARD });
  } else if (step === "newpost:poll") {
    const t = text.trim().toLowerCase();
    if (t !== "да" && t !== "нет") {
      await sendTelegramMessage(chatId, "Ответь Да или Нет.", { keyboard: YES_NO_KEYBOARD });
      return;
    }
    draft.had_poll = t === "да";
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:views");
    await sendTelegramMessage(chatId, "Сколько просмотров?", { keyboard: undefined });
  } else if (step === "newpost:views") {
    const n = parseNumber(text);
    if (n === null) {
      await sendTelegramMessage(chatId, "Введи число, например 4200");
      return;
    }
    draft.views = n;
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:likes");
    await sendTelegramMessage(chatId, "Сколько лайков?");
  } else if (step === "newpost:likes") {
    const n = parseNumber(text);
    if (n === null) {
      await sendTelegramMessage(chatId, "Введи число, например 87");
      return;
    }
    draft.likes = n;
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:replies");
    await sendTelegramMessage(chatId, "Сколько ответов (реплаев)?");
  } else if (step === "newpost:replies") {
    const n = parseNumber(text);
    if (n === null) {
      await sendTelegramMessage(chatId, "Введи число, например 12");
      return;
    }
    draft.replies = n;
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:retweets");
    await sendTelegramMessage(chatId, "Сколько ретвитов?");
  } else if (step === "newpost:retweets") {
    const n = parseNumber(text);
    if (n === null) {
      await sendTelegramMessage(chatId, "Введи число, например 3");
      return;
    }
    draft.retweets = n;
    await setDraft(chatId, draft);
    await setPendingAction(chatId, "newpost:clicks");
    await sendTelegramMessage(chatId, "Сколько переходов по ссылке? (0, если не считала)");
  } else if (step === "newpost:clicks") {
    const n = parseNumber(text);
    if (n === null) {
      await sendTelegramMessage(chatId, "Введи число, например 5 (или 0)");
      return;
    }
    draft.clicks = n;

    // Финал — сохраняем. hours_since_post считаем автоматически по моменту
    // отправки ЭТОГО сообщения (messageAtMs) относительно даты+времени поста —
    // без лишнего вопроса "через сколько часов ты смотришь статистику".
    const hoursSince = hoursSincePost(draft.date, draft.time, messageAtMs);
    draft.hours_since_post = hoursSince;
    draft.metrics_checked_at = new Date(messageAtMs).toISOString();

    try {
      await savePost(draft);
    } catch (err) {
      if (err.code === "DUPLICATE_POST") {
        // Не сбрасываем draft — человек может просто прислать новое время,
        // не заполняя весь мастер заново с нуля.
        await setPendingAction(chatId, "newpost:time");
        await sendTelegramMessage(chatId, `${err.message}\n\nПришли другое время для этого же поста.`, { keyboard: undefined });
        return;
      }
      throw err;
    }

    // Если это был отложенный запрос метрик из api/check-metrics.js — строка
    // в pending_posts своё дело сделала, удаляем.
    if (draft.pendingPostId) {
      await deletePendingPost(draft.pendingPostId);
    }

    const er = ((draft.likes + draft.replies + draft.retweets) / (draft.views || 1)) * 100;
    await clearFlow(chatId);

    const timingNote =
      hoursSince !== null
        ? ` (замер через ~${hoursSince}ч после поста)`
        : "";

    await sendTelegramMessage(
      chatId,
      `✅ Записала: ${draft.date} ${draft.time}, тема "${draft.topic}", ${draft.views} просмотров, ER ${er.toFixed(1)}%${timingNote}`
    );
  }
}

async function handleIngest(chatId, text, messageAtMs) {
  const raw = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: ingest\n\n${text}`,
  });

  const parsed = extractJson(raw);

  if (!parsed || typeof parsed !== "object") {
    await sendTelegramMessage(
      chatId,
      "Не смогла разобрать это как данные поста. Проще нажми «➕ Новый пост» — спрошу всё по шагам."
    );
    return;
  }

  if (parsed.missing_fields?.length) {
    await sendTelegramMessage(chatId, `Не хватает: ${parsed.missing_fields.join(", ")}. Или нажми «➕ Новый пост» — так проще.`);
    return;
  }

  // Момент отправки этого сообщения = момент, когда смотрели статистику.
  const hoursSince = hoursSincePost(parsed.date, parsed.time, messageAtMs);
  parsed.hours_since_post = hoursSince;
  parsed.metrics_checked_at = new Date(messageAtMs).toISOString();

  try {
    await savePost(parsed);
  } catch (err) {
    if (err.code === "DUPLICATE_POST") {
      await sendTelegramMessage(chatId, err.message);
      return;
    }
    throw err;
  }

  const er = ((parsed.likes + parsed.replies + parsed.retweets) / (parsed.views || 1)) * 100;
  const timingNote = hoursSince !== null ? ` (замер через ~${hoursSince}ч после поста)` : "";

  await sendTelegramMessage(
    chatId,
    `✅ Записала: ${parsed.date} ${parsed.time}, тема "${parsed.topic}", ${parsed.views} просмотров, ER ${er.toFixed(1)}%${timingNote}`
  );
}

async function handleAnalyze(chatId) {
  const posts = await getAllPosts();

  if (posts.length === 0) {
    await sendTelegramMessage(chatId, "Пока нет ни одного поста в базе. Нажми «➕ Новый пост», чтобы начать собирать.");
    return;
  }

  await sendTelegramMessage(chatId, "Считаю отчёт, секунду...");

  const stats = computeStats(posts);

  const report = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: analyze\n\n${JSON.stringify(stats)}`,
    maxTokens: 2000,
  });

  await sendTelegramMessage(chatId, `Постов в базе: ${stats.totalPosts}\n\n${report}`);

  if (stats.byHour.length > 1) {
    await sendTelegramPhoto(chatId, barChart(stats.byHour, "ER по часам публикации"), "ER (%) по часам");
  }
  if (stats.byWeekday.length > 1) {
    await sendTelegramPhoto(chatId, barChart(stats.byWeekday, "ER по дням недели"), "ER (%) по дням недели");
  }
}

async function handlePlan(chatId) {
  const posts = await getAllPosts();
  const stats = computeStats(posts);

  // Контент-план и engagement-план генерируются ДВУМЯ отдельными вызовами
  // Claude (разные форматы вывода, system-prompt.md явно требует не
  // смешивать задачи в одном ответе), но ПАРАЛЛЕЛЬНО через Promise.all —
  // не последовательно, иначе суммарное время легко упрётся в 60-секундный
  // лимит Vercel (см. lib/claude.js про TIMEOUT_MS=42000 на один вызов).
  const [ideasRaw, engagementRaw] = await Promise.all([
    // ВАЖНО: план на неделю — это ~29 объектов (см. prompts/system-prompt.md,
    // секция "plan"), при 3000 токенов ответ Claude обрезался на середине
    // массива и extractJson не мог распознать невалидный JSON. Подняли до 8000
    // с запасом.
    askClaude({
      system: SYSTEM_PROMPT,
      userMessage: `task: plan\n\n${JSON.stringify(stats)}`,
      maxTokens: 8000,
    }),
    askClaude({
      system: SYSTEM_PROMPT,
      userMessage: `task: engagement-plan\n\n${JSON.stringify(stats)}`,
      maxTokens: 2500,
    }),
  ]);

  const ideas = extractJson(ideasRaw);
  const engagementSessions = extractJson(engagementRaw);

  if (!Array.isArray(ideas)) {
    console.error("handlePlan: не смогла распознать JSON с идеями:", ideasRaw);
    await sendTelegramMessage(chatId, "Не получилось сгенерировать идеи, попробуй ещё раз через минуту.");
    return;
  }

  // Новый план ЗАМЕНЯЕТ старый, а не складывается поверх него — иначе при
  // повторном нажатии "Идеи" очередь удваивается: одни и те же слоты
  // получают по 2-3 конкурирующие идеи, и часть из них никогда не будет
  // использована, просто засоряя очередь.
  await clearQueuedIdeas();
  await addQueueIdeas(ideas);

  const list = ideas
    .map((i, idx) => `${idx + 1}. [${i.day_of_week || "?"} ${i.suggested_slot}] ${i.topic} — ${i.angle}\n почему: ${i.reasoning}`)
    .join("\n\n");

  await sendTelegramMessage(chatId, `Новые идеи в очереди:\n\n${list}`);

  if (Array.isArray(engagementSessions)) {
    await clearQueuedEngagementIdeas();
    await addEngagementIdeas(engagementSessions);

    const engList = engagementSessions
      .map((s, idx) => {
        const topics = (s.topics || []).map((t) => `«${t.search_query}»`).join(", ");
        return `${idx + 1}. [${s.day_of_week || "?"} ${s.suggested_slot}] ${topics} — ответить ~${s.target_count} людям\n почему: ${s.reasoning}`;
      })
      .join("\n\n");

    await sendTelegramMessage(chatId, `💬 План ответов на чужие твиты на неделю:\n\n${engList}`);
  } else {
    console.error("handlePlan: не смогла распознать JSON с engagement-планом:", engagementRaw);
    await sendTelegramMessage(
      chatId,
      "⚠️ План ответов на чужие твиты сгенерировать не смогла — Клод ответил не в ожидаемом формате. Напиши «идеи» ещё раз, чтобы попробовать снова."
    );
  }
}

// Показывает уже существующие идеи в очереди (без генерации новых) —
// вызывается по команде "план", в отличие от handlePlan(), которая
// всегда обращается к Claude за свежими идеями.
async function handleShowPlan(chatId) {
  const [ideas, engagementSessions] = await Promise.all([
    getQueuedIdeas(),
    getQueuedEngagementIdeas(),
  ]);

  if (ideas.length === 0 && engagementSessions.length === 0) {
    await sendTelegramMessage(
      chatId,
      "В очереди сейчас пусто. Нажми «💡 Идеи», чтобы сгенерировать новый план."
    );
    return;
  }

  if (ideas.length > 0) {
    const list = ideas
      .map(
        (i, idx) =>
          `${idx + 1}. [${i.day_of_week || "?"} ${i.suggested_slot}] ${i.topic} — ${i.angle}\n почему: ${i.reasoning}`
      )
      .join("\n\n");

    await sendTelegramMessage(chatId, `📋 Текущий план постов (${ideas.length} идей в очереди):\n\n${list}`);
  }

  if (engagementSessions.length > 0) {
    const engList = engagementSessions
      .map((s, idx) => {
        const topics = (s.topics || []).map((t) => `«${t.search_query}»`).join(", ");
        return `${idx + 1}. [${s.day_of_week || "?"} ${s.suggested_slot}] ${topics} — ответить ~${s.target_count} людям\n почему: ${s.reasoning}`;
      })
      .join("\n\n");

    await sendTelegramMessage(
      chatId,
      `💬 Текущий план ответов на чужие твиты (${engagementSessions.length} сессий в очереди):\n\n${engList}`
    );
  }
}

async function handleReply(chatId, tweetText) {
  const result = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: reply\n\n${tweetText}`,
    maxTokens: 800,
  });

  await sendTelegramMessage(chatId, result);
}

// Обрабатывает нажатие одной из трёх кнопок под напоминанием "⏰ Пора постить":
// idea_posted:<id> / idea_skip:<id> / idea_other:<id>
async function handleIdeaCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const [action, idStr] = (callbackQuery.data || "").split(":");
  const ideaId = Number(idStr);

  const idea = await getQueueIdeaById(ideaId);

  if (!idea) {
    await answerCallbackQuery(callbackQuery.id, "Эта идея уже неактуальна");
    await clearInlineButtons(chatId, messageId);
    return;
  }

  if (action === "idea_posted") {
    await setIdeaStatus(ideaId, "sent");
    await clearInlineButtons(chatId, messageId);
    await answerCallbackQuery(callbackQuery.id, "Записываю пост");

    // Тема/формат/дата/время уже известны из плана — сохраняем в draft, чтобы
    // не переспрашивать их. ВАЖНО: дальше идёт особая ветка "newpost:text-onpost"
    // (не "newpost:text") — она просит только текст и НЕ спрашивает цифры,
    // потому что пост только что вышел и метрик по нему ещё физически нет.
    await setDraft(chatId, {
      date: todayLocal(),
      time: idea.suggested_slot,
      topic: idea.topic,
      format: idea.format,
    });
    await setPendingAction(chatId, "newpost:text-onpost");
    await sendTelegramMessage(
      chatId,
      "Отлично! Скинь точный текст поста, как он опубликован — сохраню его, а цифры сама спрошу через ~20 часов, когда будет что показывать.",
      { keyboard: undefined }
    );
  } else if (action === "idea_skip") {
    await setIdeaStatus(ideaId, "skipped");
    await clearInlineButtons(chatId, messageId);
    await answerCallbackQuery(callbackQuery.id, "Пропущено");
    await sendTelegramMessage(chatId, "Ок, пропускаю. Идея не сгорела молча — учту при следующем анализе, если пропуски повторяются по одной теме или формату.");
  } else if (action === "idea_other") {
    await setIdeaStatus(ideaId, "skipped");
    await clearInlineButtons(chatId, messageId);
    await answerCallbackQuery(callbackQuery.id, "Ищу другой угол...");

    const posts = await getAllPosts();
    const stats = computeStats(posts);

    const raw = await askClaude({
      system: SYSTEM_PROMPT,
      userMessage: `task: replan-slot\n\nSkipped idea: ${JSON.stringify({
        topic: idea.topic,
        angle: idea.angle,
        format: idea.format,
        suggested_slot: idea.suggested_slot,
        day_of_week: idea.day_of_week,
        reasoning: idea.reasoning,
      })}\n\nStats:\n${JSON.stringify(stats)}`,
      maxTokens: 800,
    });

    const newIdea = extractJson(raw);

    if (!newIdea || typeof newIdea !== "object") {
      console.error("idea_other: не смогла распознать JSON с идеей:", raw);
      await sendTelegramMessage(chatId, "Не получилось придумать замену, попробуй ещё раз через минуту.");
      return;
    }

    const newId = await addSingleQueueIdea(newIdea);
    const fullIdea = await getQueueIdeaById(newId);

    await sendTelegramMessage(chatId, `💡 Другой угол на тот же слот:\n${newIdea.topic} — ${newIdea.angle}\nпочему: ${newIdea.reasoning}`);
    await sendReminderForIdea(fullIdea, chatId);
  }
}

// Обрабатывает нажатие одной из двух кнопок под напоминанием
// "💬 Пора отвечать на чужие твиты": engagement_done:<id> / engagement_skip:<id>.
// Проще, чем handleIdeaCallback — тут нет "другого угла" и нет отдельного
// мастера сохранения поста, просто фиксируем статус сессии.
async function handleEngagementCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const [action, idStr] = (callbackQuery.data || "").split(":");
  const sessionId = Number(idStr);

  const session = await getEngagementIdeaById(sessionId);

  if (!session) {
    await answerCallbackQuery(callbackQuery.id, "Эта сессия уже неактуальна");
    await clearInlineButtons(chatId, messageId);
    return;
  }

  if (action === "engagement_done") {
    await setEngagementStatus(sessionId, "done");
    await clearInlineButtons(chatId, messageId);
    await answerCallbackQuery(callbackQuery.id, "Отметила как сделано");
    await sendTelegramMessage(chatId, "🙌 Записала. Если найдёшь твит, на который стоит ответить — кидай его текст, предложу черновик.");
  } else if (action === "engagement_skip") {
    await setEngagementStatus(sessionId, "skipped");
    await clearInlineButtons(chatId, messageId);
    await answerCallbackQuery(callbackQuery.id, "Пропущено");
    await sendTelegramMessage(chatId, "Ок, пропускаю эту сессию вовлечения.");
  }
}