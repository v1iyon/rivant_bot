const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5"; // хорошее качество/цена для анализа и генерации текста

export async function askClaude({ system, userMessage, maxTokens = 1500 }) {
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
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.content.map((c) => c.text || "").join("\n");
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
