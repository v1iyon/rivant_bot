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
  addQueueIdeas,
  addSingleQueueIdea,
  getQueueIdeaById,
  setIdeaStatus,
  getPendingAction,
  setPendingAction,
  getDraft,
  setDraft,
  clearFlow,
  getQueuedIdeas,
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
✍️ *Ответ на твит* — черновик ответа клиенту

В любой момент шаговых вопросов можно нажать другую кнопку меню — текущий ввод отменится.

Под каждым напоминанием "⏰ Пора постить" есть кнопки:
✅ *Запостила* — сразу перейдём к записи реального поста
⏭ *Пропустить* — идея не потеряна, просто помечается пропущенной
🔁 *Дай другую идею* — предложу другой угол на этот же слот`;

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

  // Нажатие инлайн-кнопки под напоминанием ("Запостила" / "Пропустить" / "Другую идею")
  if (update?.callback_query) {
    try {
      await handleIdeaCallback(update.callback_query);
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

  const MENU_BUTTONS = ["📊 Отчёт", "💡 Идеи", "➕ Новый пост", "✍️ Ответ на твит", "❓ Помощь"];

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
      } else if (text === "✍️ Ответ на твит") {
        await setPendingAction(chatId, "awaiting_tweet");
        await sendTelegramMessage(chatId, "Скинь текст твита, на который нужно ответить.", { keyboard: undefined });
      }
    } else if (text.trim().toLowerCase() === "план") {
      // Отдельная команда: показывает то, что УЖЕ есть в очереди, без
      // обращения к Claude — в отличие от handlePlan() (кнопка "Идеи").
      await clearFlow(chatId);
      await handleShowPlan(chatId);
    } else {
      const pending = await getPendingAction(chatId);

      if (pending === "awaiting_tweet") {
        await clearFlow(chatId);
        await handleReply(chatId, text);
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
      // Идея пришла из "✅ Запостила" под напоминанием — тема/формат уже
      // известны из плана, не переспрашиваем их заново.
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

  // ВАЖНО: план на неделю — это 20-25 объектов (см. prompts/system-prompt.md,
  // секция "plan"), при 3000 токенов ответ Claude обрезался на середине
  // массива и extractJson не мог распознать невалидный JSON. Подняли до 8000
  // с запасом.
  const ideasRaw = await askClaude({
    system: SYSTEM_PROMPT,
    userMessage: `task: plan\n\n${JSON.stringify(stats)}`,
    maxTokens: 8000,
  });

  const ideas = extractJson(ideasRaw);

  if (!Array.isArray(ideas)) {
    console.error("handlePlan: не смогла распознать JSON с идеями:", ideasRaw);
    await sendTelegramMessage(chatId, "Не получилось сгенерировать идеи, попробуй ещё раз через минуту.");
    return;
  }

  await addQueueIdeas(ideas);

  const list = ideas
    .map((i, idx) => `${idx + 1}. [${i.day_of_week || "?"} ${i.suggested_slot}] ${i.topic} — ${i.angle}\n почему: ${i.reasoning}`)
    .join("\n\n");

  await sendTelegramMessage(chatId, `Новые идеи в очереди:\n\n${list}`);
}

// Показывает уже существующие идеи в очереди (без генерации новых) —
// вызывается по команде "план", в отличие от handlePlan(), которая
// всегда обращается к Claude за свежими идеями.
async function handleShowPlan(chatId) {
  const ideas = await getQueuedIdeas();

  if (ideas.length === 0) {
    await sendTelegramMessage(
      chatId,
      "В очереди сейчас пусто. Нажми «💡 Идеи», чтобы сгенерировать новый план."
    );
    return;
  }

  const list = ideas
    .map(
      (i, idx) =>
        `${idx + 1}. [${i.day_of_week || "?"} ${i.suggested_slot}] ${i.topic} — ${i.angle}\n почему: ${i.reasoning}`
    )
    .join("\n\n");

  await sendTelegramMessage(chatId, `📋 Текущий план (${ideas.length} идей в очереди):\n\n${list}`);
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

    // Тема/формат/дата/время уже известны из плана — сразу просим сам текст,
    // не переспрашивая то, что бот уже знает.
    await setDraft(chatId, {
      date: todayLocal(),
      time: idea.suggested_slot,
      topic: idea.topic,
      format: idea.format,
    });
    await setPendingAction(chatId, "newpost:text");
    await sendTelegramMessage(
      chatId,
      "Отлично! Скинь точный текст поста, как он опубликован — это нужно для качественного анализа.",
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
