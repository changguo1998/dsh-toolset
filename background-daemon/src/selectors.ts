/**
 * 选择器：校验 / 规范化 / 求下次触发（纯函数, 不读时钟做副作用、不落盘）。
 *
 * 首期五种（对齐宿主 `dsh-schedule` 的方言; **cron 不进首期**）：
 * `after_seconds` / `at` / `every_seconds`（≥ 60 s）/ `daily` / `weekly`。
 *
 * 时间语义口径（设计 §C①）：
 * - 首目标严格未来；DST **缺口跳过**、**重叠取较早**时点；同一日历日只触发一次；
 * - 已存记录必须**规范化**（`weekly.weekdays` 升序去重、`time` 补零为 `HH:MM`、
 *   `at` 为 `toISOString()` 形态）, 非规范化即拒绝（`non_canonical`）。
 */

import {
  addDays,
  instantForWallClock,
  isValidTimeZone,
  isoWeekday,
  MAX_INSTANT,
  wallClockAt,
  type CalendarDate,
} from "./tz.ts";

/** 一次性 + 秒数（相对任务创建时刻）。 */
export interface AfterSecondsSelector {
  kind: "after_seconds";
  seconds: number;
}

/** 一次性绝对时点（ISO 8601 瞬时, 创建时必须严格未来）。 */
export interface AtSelector {
  kind: "at";
  at: string;
}

/** 固定间隔（≥ 60 s, 相位基准 = 任务创建时刻）。 */
export interface EverySecondsSelector {
  kind: "every_seconds";
  seconds: number;
}

/** 每日固定本地钟表时间（显式 IANA 时区）。 */
export interface DailySelector {
  kind: "daily";
  /** `HH:MM`（24 小时制）。 */
  time: string;
  timeZone: string;
}

/** 每周固定几个 ISO 星期（1 = 周一 … 7 = 周日）的本地钟表时间。 */
export interface WeeklySelector {
  kind: "weekly";
  /** 升序去重的 ISO 星期。 */
  weekdays: readonly number[];
  time: string;
  timeZone: string;
}

export type Selector =
  | AfterSecondsSelector
  | AtSelector
  | EverySecondsSelector
  | DailySelector
  | WeeklySelector;

export type SelectorKind = Selector["kind"];

/** 选择器错误码（实现条目约定的可判据取值）。 */
export type SelectorErrorCode =
  | "invalid_selector"
  | "invalid_kind"
  | "invalid_seconds"
  | "frequency_too_high"
  | "invalid_at"
  | "at_not_future"
  | "invalid_time"
  | "invalid_weekdays"
  | "invalid_time_zone"
  | "time_out_of_range"
  | "non_canonical";

export interface SelectorError {
  code: SelectorErrorCode;
  message: string;
}

export type NormalizeResult =
  | { ok: true; selector: Selector }
  | ({ ok: false } & SelectorError);

/** `every_seconds` 的下限（低于即 `frequency_too_high`）。 */
export const MIN_EVERY_SECONDS = 60;

/** 首期支持的全部选择器种类（`/daemon` 文案与测试共用）。 */
export const SELECTOR_KINDS: readonly SelectorKind[] = [
  "after_seconds",
  "at",
  "every_seconds",
  "daily",
  "weekly",
];

/** 一次性（触发后即结束）与周期（触发后继续推进）的分界。 */
export function isPeriodic(selector: Selector): boolean {
  return (
    selector.kind === "every_seconds" ||
    selector.kind === "daily" ||
    selector.kind === "weekly"
  );
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** 解析 `H:MM` / `HH:MM` → `{hour, minute}`；非法返回 null。 */
export function parseTimeOfDay(
  time: string,
): { hour: number; minute: number } | null {
  const matched = TIME_PATTERN.exec(time);
  if (matched === null) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** 规范化钟表时间：`9:05` → `09:05`（非法原样返回, 由校验报错）。 */
export function canonicalTimeOfDay(time: string): string {
  const parsed = parseTimeOfDay(time);
  if (parsed === null) return time;
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function fail(code: SelectorErrorCode, message: string): NormalizeResult {
  return { ok: false, code, message };
}

/**
 * 校验并规范化选择器。
 *
 * @param input 未信任的输入（模型侧工具入参 / `/daemon` 命令 / 已存记录）。
 * @param now 当前瞬时（`at` 必须严格未来；缺省 `Date.now()`）。
 */
export function normalizeSelector(
  input: unknown,
  now: number = Date.now(),
): NormalizeResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("invalid_selector", "选择器必须是对象");
  }
  const raw = input as Record<string, unknown>;
  const kind = raw["kind"];
  if (typeof kind !== "string") {
    return fail("invalid_selector", "选择器缺少 kind");
  }
  switch (kind) {
    case "after_seconds": {
      const seconds = raw["seconds"];
      if (!isPositiveSafeInteger(seconds)) {
        return fail("invalid_seconds", "after_seconds.seconds 必须是正整数秒");
      }
      if (now + seconds * 1000 > MAX_INSTANT) {
        return fail("time_out_of_range", "目标瞬时超出可表示范围");
      }
      return { ok: true, selector: { kind, seconds } };
    }
    case "at": {
      const at = raw["at"];
      if (typeof at !== "string" || at.trim() === "") {
        return fail("invalid_at", "at.at 必须是 ISO 8601 字符串");
      }
      const instant = Date.parse(at);
      if (!Number.isFinite(instant)) {
        return fail("invalid_at", `无法解析的时间：${at}`);
      }
      if (Math.abs(instant) > MAX_INSTANT) {
        return fail("time_out_of_range", "目标瞬时超出可表示范围");
      }
      if (instant <= now) {
        return fail("at_not_future", `目标时间必须严格未来：${at}`);
      }
      return { ok: true, selector: { kind, at: new Date(instant).toISOString() } };
    }
    case "every_seconds": {
      const seconds = raw["seconds"];
      if (!isPositiveSafeInteger(seconds)) {
        return fail("invalid_seconds", "every_seconds.seconds 必须是正整数秒");
      }
      if (seconds < MIN_EVERY_SECONDS) {
        return fail(
          "frequency_too_high",
          `间隔过小：${seconds} s（下限 ${MIN_EVERY_SECONDS} s）`,
        );
      }
      return { ok: true, selector: { kind, seconds } };
    }
    case "daily": {
      const time = raw["time"];
      const timeZone = raw["timeZone"];
      const parsed = typeof time === "string" ? parseTimeOfDay(time) : null;
      if (parsed === null) {
        return fail("invalid_time", "daily.time 必须是 HH:MM");
      }
      if (!isValidTimeZone(timeZone)) {
        return fail("invalid_time_zone", `不认识的时区：${String(timeZone)}`);
      }
      return {
        ok: true,
        selector: { kind, time: canonicalTimeOfDay(String(time)), timeZone },
      };
    }
    case "weekly": {
      const time = raw["time"];
      const timeZone = raw["timeZone"];
      const weekdays = raw["weekdays"];
      const parsed = typeof time === "string" ? parseTimeOfDay(time) : null;
      if (parsed === null) {
        return fail("invalid_time", "weekly.time 必须是 HH:MM");
      }
      if (!isValidTimeZone(timeZone)) {
        return fail("invalid_time_zone", `不认识的时区：${String(timeZone)}`);
      }
      if (!Array.isArray(weekdays) || weekdays.length === 0) {
        return fail("invalid_weekdays", "weekly.weekdays 必须是非空数组");
      }
      const normalized: number[] = [];
      for (const value of weekdays) {
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 1 ||
          value > 7
        ) {
          return fail("invalid_weekdays", `非法星期：${String(value)}（1-7）`);
        }
        if (!normalized.includes(value)) normalized.push(value);
      }
      normalized.sort((left, right) => left - right);
      return {
        ok: true,
        selector: {
          kind,
          weekdays: normalized,
          time: canonicalTimeOfDay(String(time)),
          timeZone,
        },
      };
    }
    default:
      return fail(
        "invalid_kind",
        `不支持的选择器：${kind}（首期支持 ${SELECTOR_KINDS.join(" / ")}）`,
      );
  }
}

/** 规范化选择器（输入已合法; 只用于补零 / 排序去重 / ISO 归一）。 */
export function canonicalizeSelector(selector: Selector): Selector {
  const normalized = normalizeSelector(selector, Number.NEGATIVE_INFINITY);
  if (!normalized.ok) throw new Error(normalized.message);
  return normalized.selector;
}

/**
 * 是否已规范化（已存记录的门槛）。
 *
 * 与 `canonicalizeSelector` 的区别：`at` 在这里**不**校验「未来」——已存的一次性任务
 * 可能早已过期（等启动补算按 `missed` 处理）, 未来性只在创建时校验。
 */
export function isCanonicalSelector(selector: Selector): boolean {
  const normalized = normalizeSelector(selector, Number.NEGATIVE_INFINITY);
  if (!normalized.ok) return false;
  const left = normalized.selector;
  // 逐字段比较（不用 JSON 字符串：键序不应成为规范化的判据）
  switch (selector.kind) {
    case "after_seconds":
      return left.kind === "after_seconds" && left.seconds === selector.seconds;
    case "every_seconds":
      return left.kind === "every_seconds" && left.seconds === selector.seconds;
    case "at":
      return left.kind === "at" && left.at === selector.at;
    case "daily":
      return (
        left.kind === "daily" &&
        left.time === selector.time &&
        left.timeZone === selector.timeZone
      );
    case "weekly":
      return (
        left.kind === "weekly" &&
        left.time === selector.time &&
        left.timeZone === selector.timeZone &&
        left.weekdays.join(",") === selector.weekdays.join(",")
      );
  }
}

/**
 * 严格晚于 `after` 的下一个触发时刻；null = 不再有（一次性已过期）。
 *
 * @param anchor 任务创建时刻（`every_seconds` 的相位基准; 一次性任务的固定基准）。
 */
export function nextAfter(
  selector: Selector,
  after: number,
  anchor: number,
): number | null {
  switch (selector.kind) {
    case "after_seconds": {
      const fixed = anchor + selector.seconds * 1000;
      return fixed > after ? fixed : null;
    }
    case "at": {
      const fixed = Date.parse(selector.at);
      return fixed > after ? fixed : null;
    }
    case "every_seconds": {
      const step = selector.seconds * 1000;
      const elapsed = after - anchor;
      const steps = Math.floor(elapsed / step) + 1;
      return anchor + Math.max(1, steps) * step;
    }
    case "daily":
    case "weekly":
      return nextWallClockOccurrence(selector, after);
  }
}

/** 首目标：创建时刻之后第一次触发（一次性 = 固定时点; 周期 = 下一次墙上时刻）。 */
export function firstNext(
  selector: Selector,
  now: number,
  anchor: number = now,
): number | null {
  return nextAfter(selector, now, anchor);
}

/**
 * 墙上时刻的下一跳：从 `after` 的当地日期起逐日试, 跳过 DST 缺口日,
 * 命中第一个严格晚于 `after` 的时点。
 *
 * 逐日窗口 15 天：DST 缺口最多丢一天, 极端如 `Pacific/Apia` 跳掉整日也只丢一天;
 * 15 天足以覆盖 `weekly` 七个星期几 + 一周缺口。
 */
function nextWallClockOccurrence(
  selector: DailySelector | WeeklySelector,
  after: number,
): number | null {
  const parsed = parseTimeOfDay(selector.time);
  if (parsed === null) return null;
  const wallNow = wallClockAt(after, selector.timeZone);
  if (wallNow === null) return null;
  const today: CalendarDate = {
    year: wallNow.year,
    month: wallNow.month,
    day: wallNow.day,
  };
  const weekdays =
    selector.kind === "weekly" ? new Set(selector.weekdays) : undefined;
  for (let offset = 0; offset <= 15; offset += 1) {
    const date = addDays(today, offset);
    if (weekdays !== undefined && !weekdays.has(isoWeekday(date))) continue;
    const instant = instantForWallClock(
      { ...date, hour: parsed.hour, minute: parsed.minute },
      selector.timeZone,
    );
    if (instant === null) continue;
    if (instant > after) return instant;
  }
  return null;
}

/** 人类可读的选择器描述（`/daemon list` 与流水共用）。 */
export function describeSelector(selector: Selector): string {
  switch (selector.kind) {
    case "after_seconds":
      return `${selector.seconds} s 后一次`;
    case "at":
      return `一次性 ${selector.at}`;
    case "every_seconds":
      return `每 ${selector.seconds} s`;
    case "daily":
      return `每日 ${selector.time}（${selector.timeZone}）`;
    case "weekly":
      return `每周 ${selector.weekdays.join(",")} 的 ${selector.time}（${selector.timeZone}）`;
  }
}
