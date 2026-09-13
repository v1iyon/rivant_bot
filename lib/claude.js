const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001"; // было claude-sonnet-5 — для отчётов/идей/ответов
// на твиты хватает Haiku за долю цены Sonnet; сюда стоит вернуться на Sonnet
// только если реально увидите просадку качества текста на практике.

const TIMEOUT_MS = 55000; // одна попытка, с запасом под 60-секундный лимит
// Vercel (Hobby) — остальные ~5 сек уходят на БД/графики/отправку в
// Telegram. Длинные ответы (maxTokens до 8000 для "Идей" — план на полную
// неделю, 20-25 объектов) на Haiku в норме могут генерироваться дольше 30
// сек — это не сбой, а просто объём текста, поэтому таймаут даём щедрый,
// близко к потолку Vercel, чтобы не обрывать честно работающий запрос
// раньше времени и не терять на этом деньги (частично сгенерированные,
// но так и не использованные токены).

async function callClaudeOnce({ system, userMessage, maxTokens }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API error: ${res.status} ${errText}`);
    }

    const data = await res.json();
    return data.content.map((c) => c.text || "").join("\n");
  } finally {
    clearTimeout(timeout);
  }
}

// Повтор — только при сетевом сбое или 5xx (проблема на стороне API, не в
// самом запросе): такие ошибки обычно всплывают за доли секунды, повтор не
// бьёт по бюджету времени. При таймауте (AbortError) НЕ повторяем — раз
// первая попытка не уложилась в TIMEOUT_MS, вторая с тем же лимитом почти
// наверняка упрётся в то же самое, и мы просто сожжём остаток 60-секундного
// бюджета Vercel впустую вместо того, чтобы быстро вернуть пользователю
// понятную ошибку.
export async function askClaude({ system, userMessage, maxTokens = 1500 }) {
  try {
    return await callClaudeOnce({ system, userMessage, maxTokens });
  } catch (err) {
    const isServerError = /Claude API error: 5\d\d/.test(err.message || "");
    const isNetworkError = /fetch failed|ECONNRESET|ETIMEDOUT/i.test(err.message || "");
    if (!isServerError && !isNetworkError) throw err;
    console.warn("askClaude: первая попытка не удалась, повторяю:", err.message);
    return await callClaudeOnce({ system, userMessage, maxTokens });
  }
}

// X сжимает ЛЮБУЮ ссылку до 23 символов независимо от её реальной длины —
// считаем "эффективную" длину твита именно так, а не по факту символов ссылки.
function effectiveTweetLength(text) {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, "");
  const urlCount = (text.match(/https?:\/\/\S+/g) || []).length;
  return withoutUrls.length + urlCount * 23;
}

// Гарантирует, что твит уложится в 280 символов лимита X — если Claude
// сгенерировал длиннее, просим сократить ещё раз (максимум 2 попытки).
// extractTweet — функция, которая достаёт именно текст твита из полного ответа
// (если ответ содержит что-то ещё, например русское объяснение рядом).
export async function generateTweetUnder280({ system, userMessage, maxTokens = 600, extractTweet }) {
  let text = await askClaude({ system, userMessage, maxTokens });
  const getTweet = (t) => (extractTweet ? extractTweet(t) || t : t);

  for (let attempt = 0; attempt < 2 && effectiveTweetLength(getTweet(text)) > 280; attempt++) {
    const over = effectiveTweetLength(getTweet(text)) - 280;
    text = await askClaude({
      system,
      userMessage: `Your previous response's TWEET part was ${over} characters too long for X's 280-character limit (links count as 23 chars regardless of real length). Regenerate the FULL response in the exact same format as before, but with the TWEET shortened to fit strictly under 280 effective characters, same meaning and tone:\n\nPrevious response:\n${text}\n\nOriginal request:\n${userMessage}`,
      maxTokens,
    });
  }

  return text;
}
