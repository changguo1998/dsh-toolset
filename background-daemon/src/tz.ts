/**
 * IANA 时区算术（纯函数, 只依赖 `Intl`）。
 *
 * 设计依据（`docs/implementation/2026-10-15-background-daemon-design.md` §C①）：
 * 选择器要支持 `daily` / `weekly` 这类「显式 IANA 时区的本地钟表时间」, 因此需要
 * ① 由瞬时取当地墙钟；② 由墙钟反求瞬时（DST 缺口无解 / 重叠有两解）。
 * 缺口由调用方**跳过**、重叠由本模块取**较早**的实现（见 `instantForWallClock`）。
 */

/** 当地墙钟（只到分钟; 秒固定 0 参与计算）。 */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 日期（无时间）—— 用于按日推进。 */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** `Date` 可表示的瞬时上限（±8.64e15 ms）, 超出即 `time_out_of_range`。 */
export const MAX_INSTANT = 8.64e15;

const MS_PER_DAY = 86_400_000;

/** 时区格式化器缓存（`Intl.DateTimeFormat` 构造开销大, 同进程复用）。 */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * 校验 IANA 时区名（`Intl` 认即合法; 空串 / 非串 / 未知名一律 false）。
 *
 * 额外排除 `+08:00` / `GMT+8` 这类**固定偏移**写法：设计口径是「显式 IANA 时区」,
 * 固定偏移没有 DST 语义（`Intl` 从 V8 起接受偏移串, 不排会混进两种语义）。
 */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return false;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatters.set(timeZone, created);
  return created;
}

/**
 * 瞬时 → 当地墙钟；超出 `Date` 可表示范围返回 null（调用方转 `time_out_of_range`）。
 * 注意 `hourCycle: "h23"` 保证午夜给 "00" 而不是 "24"。
 */
export function wallClockAt(
  instant: number,
  timeZone: string,
): WallClock | null {
  if (!Number.isFinite(instant) || Math.abs(instant) > MAX_INSTANT) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatterFor(timeZone).formatToParts(new Date(instant));
  } catch {
    return null;
  }
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? Number.NaN : Number(found.value);
  };
  const wall: WallClock = {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
  for (const field of [
    wall.year,
    wall.month,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  ]) {
    if (!Number.isFinite(field)) return null;
  }
  return wall;
}

/**
 * 某瞬时在该时区的偏移（`墙钟 - UTC`, 单位 ms）。
 *
 * 秒级对齐后再相减, 避免毫秒位把偏移算成「非整分钟」（现实时区偏移都是整分钟,
 * 但 `Date` 的毫秒位会污染结果）。
 */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone);
  if (wall === null) {
    throw new RangeError(`瞬时不可表示：${String(instant)}（${timeZone}）`);
  }
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * 墙钟 → 瞬时。
 *
 * - **缺口**（当地不存在该墙钟, 如 DST 起始跳过的 02:30）→ null, 调用方跳过该日；
 * - **重叠**（当地出现两次, 如 DST 结束的 01:30）→ 取**较早**的瞬时；
 * - 其余 → 唯一解。
 *
 * 做法：用两次偏移迭代出候选（`wall - offset(wall)` 与 `wall - offset(候选)`）,
 * 再用墙钟回读校验——只有回读完全吻合的候选才是真解。
 */
export function instantForWallClock(
  wall: CalendarDate & { hour: number; minute: number },
  timeZone: string,
): number | null {
  const wallMs = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    0,
    0,
  );
  if (!Number.isFinite(wallMs) || Math.abs(wallMs) > MAX_INSTANT) return null;
  const firstOffset = zoneOffsetMs(wallMs, timeZone);
  const first = wallMs - firstOffset;
  const secondOffset = zoneOffsetMs(first, timeZone);
  const second = wallMs - secondOffset;
  let best: number | null = null;
  for (const candidate of new Set([first, second])) {
    if (Math.abs(candidate) > MAX_INSTANT) continue;
    const back = wallClockAt(candidate, timeZone);
    if (back === null) continue;
    if (
      back.year !== wall.year ||
      back.month !== wall.month ||
      back.day !== wall.day ||
      back.hour !== wall.hour ||
      back.minute !== wall.minute
    ) {
      continue;
    }
    if (best === null || candidate < best) best = candidate;
  }
  return best;
}

/** ISO 星期（周一 = 1 … 周日 = 7）。 */
export function isoWeekday(date: CalendarDate): number {
  const day = new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 日历日推进（`days` 可为负；跨月 / 跨年由 `Date` 归一）。 */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** 日历日 → 该日 00:00 的 UTC 毫秒（只用于比较与推进, 不是真实瞬时）。 */
export function calendarDayMs(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

/** 两天之间的天数差（`later - earlier`, 按日历日）。 */
export function daysBetween(earlier: CalendarDate, later: CalendarDate): number {
  return Math.round(
    (calendarDayMs(later) - calendarDayMs(earlier)) / MS_PER_DAY,
  );
}
