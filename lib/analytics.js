// Считаем реальную статистику по постам сами, в коде — не доверяем LLM арифметику.

function bucketAvg(posts, keyFn) {
  const buckets = {};
  for (const p of posts) {
    const key = keyFn(p);
    if (key === null || key === undefined) continue;
    if (!buckets[key]) buckets[key] = { sum: 0, count: 0 };
    buckets[key].sum += p.engagement_rate || 0;
    buckets[key].count += 1;
  }
  return Object.entries(buckets)
    .map(([label, v]) => ({ label, avgER: v.sum / v.count, count: v.count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function computeStats(posts) {
  const byHour = bucketAvg(posts, (p) => (p.post_time || "").slice(0, 2));

  const byWeekday = bucketAvg(posts, (p) => {
    const d = new Date(p.post_date);
    if (isNaN(d)) return null;
    const days = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
    return days[d.getUTCDay()];
  });

  const byTopic = bucketAvg(posts, (p) => p.topic || "не указано");
  const byFormat = bucketAvg(posts, (p) => p.format || "не указано");
  const byLink = bucketAvg(posts, (p) => (p.had_link ? "со ссылкой" : "без ссылки"));
  const byMedia = bucketAvg(posts, (p) => (p.had_media ? "с фото/видео" : "без фото/видео"));
  const byPoll = bucketAvg(posts, (p) => (p.had_poll ? "с опросом" : "без опроса"));

  const sorted = [...posts].sort((a, b) => (b.engagement_rate || 0) - (a.engagement_rate || 0));
  const top5 = sorted.slice(0, 5);
  const worst5 = sorted.slice(-5).reverse();

  return { byHour, byWeekday, byTopic, byFormat, byLink, byMedia, byPoll, top5, worst5, totalPosts: posts.length };
}
