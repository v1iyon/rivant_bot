import { getAllPosts } from "../lib/db.js";
import { askClaude } from "../lib/claude.js";
import { sendTelegramMessage } from "../lib/telegram.js";
import { nowParts } from "../lib/time.js";
import {
  skipQueuedSlots,
  addEngageSlots,
  getRecentEngageTopics,
} from "../lib/engage.js";

// ---- Настройки (меняй прямо здесь) ----------------------------------------
const MAX_SLOTS = 3; // сколько напоминаний «пора отвечать» в день
const WINDOW_FIRST = 9; // не раньше этого часа (по твоему местному времени)
const WINDOW_LAST = 21; // не позже этого часа
const PRODUCT = "RIVANT — SaaS-платформа аналитики для e-commerce";
const AUDIENCE = "основатели и операторы e-commerce / DTC-магазинов в X";
// ---------------------------------------------------------------------------

// sendTelegramMessage шлёт с parse_mode: "Markdown" и не проверяет ответ Telegram:
// одна незакрытая * или _ — и сообщение молча не придёт. Вычищаем эти символы.
function stripMarkdown(text) {
  return String(text).replace(/[*_`\[\]]/g, "");
}

function hh(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

// Средний ER твоих постов по часам публикации — единственные реальные данные о
// "хорошем времени", которые есть у бота.
function hourStats(posts) {
  const byHour = {};
  for (const p of posts) {
    const h = parseInt(String(p.post_time || "").split(":")[0], 10);
    if (Number.isNaN(h)) continue;
    if (!byHour[h]) byHour[h] = { n: 0, sum: 0 };
    byHour[h].n += 1;
    byHour[h].sum += Number(p.engagement_rate || 0);
  }
  return Object.entries(byHour)
    .map(([h, v]) => ({ hour: Number(h), posts: v.n, avgER: v.sum / v.n }))
    .sort((a, b) => b.avgER - a.avgER);
}

function describePost(p) {
  const er = Number(p.engagement_rate || 0).toFixed(1);
  return `- ${p.topic} (${p.post_date} ${p.post_time}, просмотры: ${p.views}, лайки: ${p.likes}, ответы: ${p.replies}, ER: ${er}%)`;
}

function buildSystemPrompt() {
  return `Ты помощник основателя SaaS-продукта, который растит аккаунт в X.
Продукт: ${PRODUCT}.
Аудитория: ${AUDIENCE}.

Задача: составить план на СЕГОДНЯ — в какие часы и на какие темы ей стоит идти отвечать под чужими постами в X.

Верни ТОЛЬКО JSON, без пояснений и без markdown-обёртки, строго такого вида:
{"slots":[{"hour":12,"topic":"...","query":"...","angle":"..."}]}

Поля:
- hour — целое число, час в её местном времени;
- topic — тема по-русски, коротко;
- query — поисковый запрос для X на английском, одной строкой (можно с операторами lang:en и -filter:replies);
- angle — по-русски, одна фраза: какую пользу или мысль добавить в ответ.

Правила:
- Слотов: от 2 до ${MAX_SLOTS}. Часы разные и только из разрешённых, они указаны в данных.
- У тебя НЕТ доступа к живой ленте X и новостям. Не утверждай, что что-то сейчас в тренде или что-то произошло сегодня. Опирайся на её посты и на постоянные темы и боли аудитории.
- Не выдумывай цифры, статистику и факты о рынке.
- Часы выбирай с учётом её лучших часов публикации, если данных достаточно; если постов мало, считай эти данные предварительными и просто распредели слоты по дню.
- Темы бери и из списка "лучшие по ER", и из списка "с наибольшим охватом" — второй список так же важен, не игнорируй его только потому, что там ниже ER: у постов с большим охватом ER занижен из-за большого знаменателя, это не значит, что тема слабая.
- Не повторяй темы из списка недавних.
- Не предлагай вставлять ссылку на продукт в ответы.
- В тексте полей не используй символы * _ \` [ ].`;
}

function parseSlots(raw) {
  const cleaned = String(raw).replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Claude вернул ответ не в JSON");
  const data = JSON.parse(cleaned.slice(start, end + 1));
  return Array.isArray(data.slots) ? data.slots : [];
}

export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  try {
    const { hour: nowHour } = nowParts();
    const firstAllowed = Math.max(WINDOW_FIRST, Number(nowHour) + 1);
    if (firstAllowed > WINDOW_LAST) {
      return res.status(200).send("too late for today's plan");
    }

    const posts = await getAllPosts(); // по дате по возрастанию
    const withTopic = posts.filter((p) => p.topic);
    const top = [...withTopic]
      .sort((a, b) => Number(b.engagement_rate || 0) - Number(a.engagement_rate || 0))
      .slice(0, 5);
    // ER делят на просмотры, поэтому у постов с большим охватом ER часто ниже
    // просто из-за большого знаменателя — по чистому ER они не попадают в `top`
    // и их темы молча выпадают из выбора. Добавляем отдельный список по
    // просмотрам, чтобы такие темы не терялись.
    const topByReach = [...withTopic]
      .sort((a, b) => Number(b.views || 0) - Number(a.views || 0))
      .filter((p) => !top.some((t) => t.post_date === p.post_date && t.post_time === p.post_time))
      .slice(0, 5);
    const recent = withTopic.slice(-5).reverse();
    const stats = hourStats(posts).slice(0, 5);
    const recentEngageTopics = await getRecentEngageTopics();

    const userMessage = [
      `Разрешённые часы для слотов: с ${firstAllowed} по ${WINDOW_LAST} включительно.`,
      `Всего постов в базе: ${posts.length}.`,
      withTopic.length
        ? `Лучшие посты по отклику (ER):\n${top.map(describePost).join("\n")}`
        : "Постов с темой в базе пока нет.",
      topByReach.length
        ? `Посты с наибольшим охватом, но не попавшие в список выше (их темы тоже стоит учитывать — низкий ER у них часто просто из-за большого числа просмотров в знаменателе, а не из-за слабой темы):\n${topByReach
            .map(describePost)
            .join("\n")}`
        : "",
      withTopic.length ? `Последние посты:\n${recent.map(describePost).join("\n")}` : "",
      stats.length
        ? `Часы публикации с лучшим средним ER (часов постов: ${stats.length}):\n` +
          stats
            .map((s) => `- ${hh(s.hour)}: ER ${s.avgER.toFixed(1)}% (постов: ${s.posts})`)
            .join("\n")
        : "",
      recentEngageTopics.length
        ? `Темы, которые уже предлагались недавно (не повторять):\n${recentEngageTopics
            .map((t) => `- ${t}`)
            .join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const raw = await askClaude({
      system: buildSystemPrompt(),
      userMessage,
      maxTokens: 900,
    });

    // Проверяем то, что вернул Claude: только целые часы из окна, без дублей.
    const seen = new Set();
    const slots = parseSlots(raw)
      .map((s) => ({
        hour: Number(s.hour),
        topic: stripMarkdown(s.topic || "").trim(),
        query: stripMarkdown(s.query || "").trim(),
        angle: stripMarkdown(s.angle || "").trim(),
      }))
      .filter((s) => {
        const ok =
          Number.isInteger(s.hour) &&
          s.hour >= firstAllowed &&
          s.hour <= WINDOW_LAST &&
          s.topic &&
          !seen.has(s.hour);
        if (ok) seen.add(s.hour);
        return ok;
      })
      .sort((a, b) => a.hour - b.hour)
      .slice(0, MAX_SLOTS);

    if (!slots.length) throw new Error("Claude не вернул ни одного подходящего слота");

    await skipQueuedSlots();
    await addEngageSlots(slots);

    const summary =
      "📅 План ответов под чужими постами на сегодня:\n\n" +
      slots.map((s) => `${hh(s.hour)} — ${s.topic}`).join("\n") +
      "\n\nНапомню в каждый из этих часов.";
    await sendTelegramMessage(process.env.FOUNDER_CHAT_ID, stripMarkdown(summary));

    res.status(200).send(`planned ${slots.length} slots`);
  } catch (err) {
    console.error("engage-plan: не удалось составить план", err);
    try {
      await sendTelegramMessage(
        process.env.FOUNDER_CHAT_ID,
        stripMarkdown(`⚠️ Не смогла составить план ответов на сегодня — ошибка: ${err.message}`)
      );
    } catch (notifyErr) {
      console.error("engage-plan: не удалось даже уведомить об ошибке", notifyErr);
    }
    res.status(200).send("failed, notified if possible");
  }
}
