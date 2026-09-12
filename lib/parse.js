// Не полагаемся на то, что Клод всегда отвечает ЧИСТЫМ JSON без единого
// лишнего слова вокруг — иногда модель добавляет короткую преамбулу или
// оборачивает ответ в ```json ... ```. Раньше один лишний символ означал,
// что весь план/идеи молча терялись (JSON.parse просто падал).
// Возвращает распарсенное значение или null, если распознать не удалось.
export function extractJson(text) {
  if (!text) return null;

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // падаем ниже — попробуем вытащить JSON-кусок из текста руками
  }

  const firstArr = cleaned.indexOf("[");
  const firstObj = cleaned.indexOf("{");
  const candidates = [firstArr, firstObj].filter((i) => i !== -1);
  if (!candidates.length) return null;

  const start = Math.min(...candidates);
  const openChar = cleaned[start];
  const closeChar = openChar === "[" ? "]" : "}";
  const end = cleaned.lastIndexOf(closeChar);
  if (end === -1 || end <= start) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
