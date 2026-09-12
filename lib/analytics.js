// Считаем реальную статистику по постам сами, в коде — не доверяем LLM арифметику.

// Свежие посты весят больше старых: аудитория и стиль со временем меняются,
// пост из первой недели не должен тянуть выводы на себе наравне со вчерашним.
// HALF_LIFE_DAYS = через сколько дней "вес" поста падает вдвое.
const HALF_LIFE_DAYS = Number(process.env.RECENCY_HALF_LIFE_DAYS || 30);

function daysAgo(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d)) return null;
  return (Date.now() - d.getTime()) / 86400000;
}

function recencyWeight(dateStr) {
  const age = daysAgo(dateStr);
  if (age === null || age < 0) return 1;
  return Math.pow(0.5, age / HALF_LIFE_DAYS);
}

// views/час — сколько просмотров пост набирал в среднем за час к моменту,
// когда смотрели статистику. Это про ОХВАТ/дистрибуцию (во многом — удача
// алгоритма и время публикации), и отдельно от лайков/просмотров, которые
// про РЕЗОНАНС (зацепил ли текст). Смешивать их в одну метрику — ошибка:
// пост может плохо разлететься (мало показов), но у тех, кто его увидел,
// вызвать сильный отклик — это два разных диагноза и два разных лечения.
function viewsPerHour(p) {
  if (!p.hours_since_post || p.hours_since_post <= 0) return null;
  return p.views / p.hours_since_post;
}

function likeRate(p) {
  return p.views > 0 ? (p.likes / p.views) * 100 : null;
}

function replyRate(p) {
  return p.views > 0 ? (p.replies / p.views) * 100 : null;
}

// Взвешенное среднее ER по бакету (свежие посты весят больше), плюс сырое
// невзвешенное среднее и count — чтобы было видно, если вес что-то заметно
// сдвинул, и чтобы не терять прозрачность при малой выборке.
function bucketAvg(posts, keyFn) {
  const buckets = {};
  for (const p of posts) {
    const key = keyFn(p);
    if (key === null || key === undefined) continue;
    const w = recencyWeight(p.post_date);
    if (!buckets[key]) buckets[key] = { weightedSum: 0, weightTotal: 0, rawSum: 0, count: 0 };
    buckets[key].weightedSum += (p.engagement_rate || 0) * w;
    buckets[key].weightTotal += w;
    buckets[key].rawSum += p.engagement_rate || 0;
    buckets[key].count += 1;
  }
  return Object.entries(buckets)
    .map(([label, v]) => ({
      label,
      avgER: v.weightedSum / v.weightTotal, // взвешенное по свежести — используй как основное
      rawAvgER: v.rawSum / v.count, // невзвешенное, для сравнения
      count: v.count,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function confidenceLabel(n) {
  if (n < 15) return "low"; // предварительные выводы, см. систем-промпт
  if (n < 40) return "medium";
  return "high";
}

// Общее взвешенное (по свежести) среднее ER по всем постам — используется,
// например, в midweek-check, чтобы сравнивать "последние N постов" не с
// сырым средним за всю историю (где старые посты тянут не меньше новых),
// а с уже скорректированным на актуальность бенчмарком.
export function weightedOverallER(posts) {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const p of posts) {
    const w = recencyWeight(p.post_date);
    weightedSum += (p.engagement_rate || 0) * w;
    weightTotal += w;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : 0;
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

  // В top5/worst5 отдаём и hours_since_post, чтобы было видно, если "худший"
  // пост на самом деле просто замеряли через 20 минут после публикации —
  // это не провал контента, а рано считанные цифры.
  const annotate = (p) => ({
    date: p.post_date,
    time: p.post_time,
    topic: p.topic,
    format: p.format,
    text: p.text_content,
    views: p.views,
    likes: p.likes,
    replies: p.replies,
    retweets: p.retweets,
    engagement_rate: p.engagement_rate,
    views_per_hour: viewsPerHour(p) !== null ? Math.round(viewsPerHour(p) * 10) / 10 : null,
    hours_since_post: p.hours_since_post ?? null,
    data_quality:
      p.hours_since_post == null
        ? "неизвестно, через сколько часов смотрели"
        : p.hours_since_post < 1
        ? "замер очень рано (<1ч) — по охвату рано делать выводы"
        : "ок",
  });

  const top5 = sorted.slice(0, 5).map(annotate);
  const worst5 = sorted.slice(-5).reverse().map(annotate);

  // Полный список постов с текстом и посчитанными метриками — передаётся
  // Клоду в задаче analyze/plan, чтобы он реально читал, ЧТО было написано
  // (хук, структура, CTA), а не только смотрел на цифры по бакетам.
  const postsForQualitativeAnalysis = [...posts]
    .sort((a, b) => (a.post_date < b.post_date ? 1 : -1))
    .map((p) => ({
      ...annotate(p),
      like_rate_pct: likeRate(p) !== null ? Math.round(likeRate(p) * 100) / 100 : null,
      reply_rate_pct: replyRate(p) !== null ? Math.round(replyRate(p) * 100) / 100 : null,
      recency_weight: Math.round(recencyWeight(p.post_date) * 100) / 100,
    }));

  const withHours = posts.filter((p) => p.hours_since_post != null && p.hours_since_post > 0);
  const avgViewsPerHour = withHours.length
    ? withHours.reduce((s, p) => s + viewsPerHour(p), 0) / withHours.length
    : null;

  return {
    byHour,
    byWeekday,
    byTopic,
    byFormat,
    byLink,
    byMedia,
    byPoll,
    top5,
    worst5,
    totalPosts: posts.length,
    confidence: confidenceLabel(posts.length),
    recencyHalfLifeDays: HALF_LIFE_DAYS,
    avgViewsPerHour: avgViewsPerHour !== null ? Math.round(avgViewsPerHour * 10) / 10 : null,
    postsWithTimingData: withHours.length,
    posts: postsForQualitativeAnalysis,
  };
}
