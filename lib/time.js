// Работа со временем через нормальную IANA-таймзону (например "Europe/Kyiv"),
// а не через ручной числовой оффсет — переход на летнее/зимнее время
// учитывается автоматически, ничего не нужно менять руками дважды в год.

export const TIMEZONE = process.env.TIMEZONE || "Europe/Kyiv";

// Текущие локальные час/день недели/дата в заданной таймзоне.
// weekday в формате "Sun".."Sat" — совпадает с тем, что уже использует БД (day_of_week).
export function nowParts(timeZone = TIMEZONE) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // некоторые локали отдают полночь как "24"
  return {
    hour,
    minute: Number(get("minute")),
    weekday: get("weekday"), // "Sun".."Sat"
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

// Сегодняшняя дата (YYYY-MM-DD) в локальной таймзоне — используется, например,
// чтобы проставить дату поста, когда человек отвечает "запостила" на напоминание.
export function todayLocal(timeZone = TIMEZONE) {
  return nowParts(timeZone).date;
}

// Превращает "локальные" дату+время (как их видит человек в своём городе)
// в точный момент времени (мс), корректно учитывая DST на эту конкретную дату —
// не через фиксированный оффсет, а через реальные данные таймзоны.
export function zonedDateTimeToMs(dateStr, timeStr, timeZone = TIMEZONE) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) return null;

  // Первая грубая догадка: как будто это время уже в UTC.
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Смотрим, как этот момент выглядит в целевой таймзоне, и поправляем разницу.
  // Стандартный приём для конвертации "локальное время -> UTC" без внешних библиотек.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(guessMs));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  let asZoneHour = get("hour");
  if (asZoneHour === 24) asZoneHour = 0;
  const asUtcOfThatWallTime = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    asZoneHour,
    get("minute"),
    get("second")
  );
  const driftMs = asUtcOfThatWallTime - guessMs;
  return guessMs - driftMs;
}

// Часы между "постом" (локальная дата+время) и моментом, когда цифры были занесены в бота.
// checkedAtMs — обычно Date.now() или message.date*1000 из Telegram (момент отправки сообщения).
export function hoursSincePost(dateStr, timeStr, checkedAtMs, timeZone = TIMEZONE) {
  const postedMs = zonedDateTimeToMs(dateStr, timeStr, timeZone);
  if (postedMs === null || !checkedAtMs) return null;
  const diffH = (checkedAtMs - postedMs) / 3600000;
  if (!Number.isFinite(diffH)) return null;
  return Math.max(0, Math.round(diffH * 10) / 10);
}
