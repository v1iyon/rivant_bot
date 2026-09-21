import { getAllPosts } from "../lib/db.js";
import { askClaude } from "../lib/claude.js";
import { sendTelegramMessage } from "../lib/telegram.js";

// ---- Настройки (меняй прямо здесь) ----------------------------------------
// Сколько содержательных ответов под чужими постами ты хочешь сделать за сессию.
const ENGAGE_TARGET = 5;
// Кто твоя аудитория и что за продукт — Claude опирается на это при выборе тем.
const PRODUCT = "RIVANT — SaaS-платформа аналитики для e-commerce";
const AUDIENCE = "основатели и операторы e-commerce / DTC-магазинов в X";
// ---------------------------------------------------------------------------

// sendTelegramMessage шлёт с parse_mode: "Markdown" и не проверяет ответ Telegram:
// одна незакрытая * или _ в тексте Claude — и сообщение молча не придёт.
// Поэтому вычищаем Markdown-символы перед отправкой.
function stripMarkdown(text) {
  return text.replace(/[*_`\[\]]/g, "");
}

function describePost(p) {
  const er = Number(p.engagement_rate || 0).toFixed(1);
  return `- ${p.topic} (${p.post_date}, просмотры: ${p.views}, лайки: ${p.likes}, ответы: ${p.replies}, ER: ${er}%)`;
}

const SYSTEM_PROMPT = `Ты помощник основателя SaaS-продукта, который растит аккаунт в X.
Продукт: ${PRODUCT}.
Аудитория: ${AUDIENCE}.

Твоя задача — составить короткое напоминание в Telegram: пора идти отвечать под чужими постами и вот какие темы искать.

Формат ответа (по-русски, простой текст):
1. Первая строка: пора отвечать под чужими постами (одна короткая фраза).
2. 3–4 темы для поиска. Для каждой темы:
   - название темы по-русски;
   - поисковый запрос для X на английском, одной строкой (можно с операторами lang:en и -filter:replies);
   - одна фраза: какой угол или пользу добавить в ответ.
3. Последняя строка: цель на эту сессию — ${ENGAGE_TARGET} содержательных ответов.

Правила:
- Опирайся на темы её собственных постов из данных ниже, особенно на те, что дали лучший отклик, но не ограничивайся ими.
- Не выдумывай цифры, статистику и факты о рынке.
- Не предлагай вставлять ссылку на продукт в ответы — ценность должна быть в самом комментарии.
- Не используй Markdown: никаких звёздочек, подчёркиваний, обратных кавычек и квадратных скобок.
- Не длиннее 1200 символов.`;

export default async function handler(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).send("unauthorized");
  }

  try {
    const posts = await getAllPosts(); // отсортированы по дате по возрастанию
    const withTopic = posts.filter((p) => p.topic);

    const top = [...withTopic]
      .sort((a, b) => Number(b.engagement_rate || 0) - Number(a.engagement_rate || 0))
      .slice(0, 5);
    const recent = withTopic.slice(-5).reverse();

    const userMessage = withTopic.length
      ? `Лучшие посты по отклику:\n${top.map(describePost).join("\n")}\n\nПоследние посты:\n${recent.map(describePost).join("\n")}`
      : "Постов в базе пока нет — опирайся только на описание продукта и аудитории.";

    const text = await askClaude({
      system: SYSTEM_PROMPT,
      userMessage,
      maxTokens: 700,
    });

    await sendTelegramMessage(process.env.FOUNDER_CHAT_ID, stripMarkdown(text));
    res.status(200).send("engage reminder sent");
  } catch (err) {
    console.error("engage-reminder: не удалось отправить напоминание", err);
    try {
      await sendTelegramMessage(
        process.env.FOUNDER_CHAT_ID,
        `⚠️ Не смогла отправить напоминание про ответы под чужими постами — ошибка: ${err.message}`
      );
    } catch (notifyErr) {
      console.error("engage-reminder: не удалось даже уведомить об ошибке", notifyErr);
    }
    res.status(200).send("failed, notified if possible");
  }
}
