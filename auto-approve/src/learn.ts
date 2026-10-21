/**
 * 学习层：把「用户在审批面板人工放行」的调用学成本会话的**段形态集合**，让同会话内后续等价
 * 调用不再弹面板（追踪文档 `docs/implementation/2026-10-21-manual-approval-fingerprint.md`）。
 *
 * 三个部分：
 *
 * 1. **词法层（纯函数）**：按 `security-guard` 的口径切段（引号内分隔符不切）→ 词法切 token
 *    （处理 `-m"b"` 这类无空格粘连）→ 固定抹值（引号串 `<msg>` / 长 hex `<hex>` / 纯数字 `<n>`）；
 *    **不抹**路径 / 分支名 / URL / 选项名（宁可少泛化）。段首命令词保持原文，永不遮成占位。
 * 2. **形态表（`FormStore`）**：每会话一张，`formCapacity` 近似 LRU；覆盖判定是「每一段都在表里」
 *    （顺序无关）。A 层 = 精确形态；B 层 = 同段第二次**成功**观测时做最小泛化（差异位升级为
 *    `<v>`，段首命令词与子命令永不通配，单段变体位 ≤ 2）。
 * 3. **学习器（事件状态机）**：`approval/asked` 建配对表 → `approval/decided` 收尾（`allowed-once`
 *    且非本插件裁定 = 人工放行）→ `tool/result` 按 `toolCallId` 记「成功执行」（只推进 B，A 不看结果）。
 *    候选先经 LLM 审阅（同批 2 s 窗口合并成一次请求），通过才入表；失败一律不学（fail-closed）。
 *
 * 边界：只在同一会话内生效；危险命令仍由 `security-guard` 否决（本模块**不调用** guard）；
 * 不新增审计 schema、不新增会话事件词汇（只读既有事件）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AUDIT_FILE_NAME } from "./audit.ts";
import type { CallTable } from "./calls.ts";
import { SHELL_TOOLS, type ResolvedConfig } from "./config.ts";
import { fingerprintOf } from "./fingerprint.ts";
import type { FingerprintStore } from "./fingerprint.ts";
import {
  COMMAND_KEYS,
  matchesAnyTool,
  parseArguments,
  parseEscalationTarget,
  pickString,
} from "./patterns.ts";
import {
  riskAtMost,
  type LearnCandidate,
  type LearnReviewer,
  type LearnReviewOutcome,
} from "./review.ts";
import type { SessionEventLike, SessionObserver } from "./sessions.ts";
import type { CallInfo, FormSource, FormView } from "./types.ts";

/** 泛化出来的变位占位符（B 层）。 */
export const VALUE_PLACEHOLDER = "<v>";
/** 引号串的抹值占位符。 */
export const QUOTED_PLACEHOLDER = "<msg>";
/** 长十六进制串（≥ 16 位）的抹值占位符。 */
export const HEX_PLACEHOLDER = "<hex>";
/** 纯数字 token 的抹值占位符。 */
export const NUMBER_PLACEHOLDER = "<n>";
/** 单段最多可泛化的变位数。 */
export const MAX_VARIABLE_SLOTS = 2;
/** 学习审阅的合并窗口（毫秒）：同窗口内的候选合成一次模型请求。 */
export const LEARN_REVIEW_WINDOW_MS = 2_000;
/** 回填单次最多处理的审批对数（超出丢弃并记一条日志）。 */
export const REHYDRATE_LIMIT = 20;
/** ask 配对表容量（asked → decided 在同一轮内闭合，只需短期容量）。 */
const PENDING_ASK_CAPACITY = 256;

/*
 * ── 词法层（纯函数） ─────────────────────────────────────────────────────────
 */

/** 一段命令的一个 token（`quoted` = 来自引号串，抹值时统一抹成 `<msg>`）。 */
export interface CommandToken {
  value: string;
  quoted: boolean;
}

/**
 * 切段：按 `;` / `|` / `&` / 换行切分，引号内的分隔符不切。
 *
 * 口径与 `security-guard/src/blacklist.ts` 的 `splitCommandSegments` 一致（本包复制 25 行实现，
 * 不引入跨包依赖 —— 抽公共模块属跨包改动，另立条目）；额外返回 `balanced`（引号是否配对），
 * 不配对时上层按「切分失败」处理，不猜。
 */
export function splitCommandSegments(command: string): {
  segments: string[];
  balanced: boolean;
} {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of command) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
      if (current.trim().length > 0) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) segments.push(current.trim());
  return { segments, balanced: quote === null };
}

/**
 * 切 token：空白分隔 + 引号串整体成一个 token；引号紧贴前文时先断开
 * （`-m"b"` → `-m` + `b`，与 `-m "b"` 同形）。
 */
export function tokenizeSegment(segment: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of segment) {
    if (quote !== null) {
      if (ch === quote) {
        tokens.push({ value: current, quoted: true });
        current = "";
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (current.length > 0) {
        tokens.push({ value: current, quoted: false });
        current = "";
      }
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push({ value: current, quoted: false });
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote !== null) {
    // 未闭合的引号串：balanced 已在上层判过；这里仍落 token，避免静默丢内容
    tokens.push({ value: current, quoted: true });
  } else if (current.length > 0) {
    tokens.push({ value: current, quoted: false });
  }
  return tokens;
}

/** 单个 token 的抹值（引号串 / 长 hex / 纯数字；其它原样保留）。 */
export function maskToken(token: CommandToken): string {
  if (token.quoted) return QUOTED_PLACEHOLDER;
  if (/^[0-9a-fA-F]{16,}$/.test(token.value)) return HEX_PLACEHOLDER;
  if (/^\d+$/.test(token.value)) return NUMBER_PLACEHOLDER;
  return token.value;
}

/**
 * 段形态：抹值后的 token 串。
 *
 * 段首命令词保持原文（即使是引号串也不抹）——否则 `"rm" -rf /` 与 `"curl" -rf /` 会并成一类。
 */
export function segmentForm(segment: string): string[] | undefined {
  const tokens = tokenizeSegment(segment);
  const head = tokens[0];
  if (head === undefined) return undefined;
  const form = [head.value];
  for (const token of tokens.slice(1)) form.push(maskToken(token));
  return form;
}

/** 命令 → 段形态数组；空命令 / 引号不配对 / 段数 0 / 某段无 token → `undefined`（不猜）。 */
export function formOfCommand(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;
  const { segments, balanced } = splitCommandSegments(trimmed);
  if (!balanced || segments.length === 0) return undefined;
  const forms: string[] = [];
  for (const segment of segments) {
    const form = segmentForm(segment);
    if (form === undefined) return undefined;
    forms.push(form.join(" "));
  }
  return forms;
}

/** 命令类工具的命令原文（`bash` / `pwsh` / `shell` 的 `command` / `script`）。 */
export function commandOfCall(call: CallInfo): string | undefined {
  if (!matchesAnyTool(SHELL_TOOLS, call.name)) return undefined;
  return pickString(call.arguments, COMMAND_KEYS);
}

/** 形态 id（sha256 前 16 位；带升级目标模式以免同形不同目标互相覆盖）。 */
export function formHash(form: string, target?: string): string {
  return createHash("sha256")
    .update(`${target ?? ""}\u0000${form}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * 形态匹配：`pattern` 里的 `<v>` 匹配任意单 token（变位只可能出现在第 3 位起）。
 * 长度必须一致 —— 段形态不做跨段匹配。
 */
export function matchesForm(
  pattern: readonly string[],
  tokens: readonly string[],
): boolean {
  if (pattern.length !== tokens.length) return false;
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const actual = tokens[index];
    if (expected === undefined || actual === undefined) return false;
    if (expected === VALUE_PLACEHOLDER) {
      if (index < 2) return false;
      continue;
    }
    if (expected !== actual) return false;
  }
  return true;
}

/** 可作变位的值：排除选项名 / 路径 / URL / 赋值 / 通配 / 变量引用 / 已有占位符。 */
function eligibleValue(token: string): boolean {
  if (token.length === 0) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("/") || token.includes("\\")) return false;
  if (token.includes("=") || token.includes("*") || token.includes("$"))
    return false;
  if (token.startsWith("~") || token.startsWith(".")) return false;
  if (token.startsWith("<") && token.endsWith(">")) return false;
  return true;
}

/**
 * 最小泛化（B 层）：把 `observed` 与 `pattern` 的差异位升级为 `<v>`。
 *
 * - 段首命令词与子命令（前两位）永不通配；
 * - 差异位两侧都必须是可作值的字面量（路径 / 选项 / URL 不泛化，宁可少泛化）；
 * - 泛化后单段变位总数 ≤ `MAX_VARIABLE_SLOTS`；
 * - 无差异或任一条件不满足 → `undefined`（不改表）。
 */
export function mergeForm(
  pattern: readonly string[],
  observed: readonly string[],
): string[] | undefined {
  if (pattern.length !== observed.length) return undefined;
  const out = [...pattern];
  let variables = pattern.filter((token) => token === VALUE_PLACEHOLDER).length;
  let added = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const actual = observed[index];
    if (expected === undefined || actual === undefined) return undefined;
    if (expected === VALUE_PLACEHOLDER || expected === actual) continue;
    if (index < 2) return undefined;
    if (!eligibleValue(expected) || !eligibleValue(actual)) return undefined;
    out[index] = VALUE_PLACEHOLDER;
    added += 1;
  }
  if (added === 0) return undefined;
  if (variables + added > MAX_VARIABLE_SLOTS) return undefined;
  return out;
}

/*
 * ── 形态表 ───────────────────────────────────────────────────────────────────
 */

/** 形态表条目（`successes` 是 B 层的「第二次成功观测」判据）。 */
interface FormEntry {
  form: string;
  tokens: readonly string[];
  /** 首次入表的掩码形态（泛化后不变，用于按 base 定位观测）。 */
  base: string;
  toolName: string;
  source: FormSource;
  target?: string;
  approvedAt: string;
  successes: number;
}

interface SessionForms {
  entries: Map<string, FormEntry>;
  /** 已计入成功观测的 `callId + 形态`（同一调用同一形态只计一次）。 */
  seen: Set<string>;
}

/** 单会话有界形态表（近似 LRU：Map 插入序）。 */
export class FormStore {
  readonly #capacity: number;
  readonly #sessions = new Map<string, SessionForms>();

  constructor(capacity: number) {
    this.#capacity = Math.max(1, Math.floor(capacity));
  }

  /** 记一条形态（幂等；超容量淘汰最早的条目）。 */
  add(
    sessionId: string,
    form: string,
    toolName: string,
    source: FormSource,
    target?: string,
    now = new Date(),
  ): boolean {
    const session = this.#session(sessionId);
    const key = formHash(form, target);
    if (session.entries.has(key)) return false;
    session.entries.set(key, {
      form,
      tokens: form.split(" "),
      base: form,
      toolName,
      source,
      ...(target === undefined ? {} : { target }),
      approvedAt: now.toISOString(),
      successes: 0,
    });
    while (session.entries.size > this.#capacity) {
      const oldest = session.entries.keys().next();
      if (oldest.done === true) break;
      session.entries.delete(oldest.value);
    }
    return true;
  }

  /** 段覆盖判定：**每一段**都能在表里找到（同目标模式）等价形态才 `true`。 */
  covers(
    sessionId: string,
    forms: readonly string[],
    target?: string,
  ): boolean {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || forms.length === 0) return false;
    for (const form of forms) {
      if (this.#match(session, form.split(" "), target) === undefined) {
        return false;
      }
    }
    return true;
  }

  /**
   * 记一次**成功执行**观测（B 层）。
   *
   * 已被覆盖的段：计入 `successes`（同一 `callId + 形态` 只计一次），返回命中的段形态。
   * 未覆盖的段：返回空数组，由调用方用 `mergeCandidate` 判断能否最小泛化。
   */
  noteSuccess(
    sessionId: string,
    callId: string,
    forms: readonly string[],
    target?: string,
  ): readonly string[] {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return [];
    const hit: string[] = [];
    for (const form of forms) {
      const entry = this.#match(session, form.split(" "), target);
      if (entry === undefined) continue;
      const key = `${callId}\u0000${formHash(entry.form, entry.target)}`;
      if (session.seen.has(key)) {
        hit.push(entry.form);
        continue;
      }
      if (session.seen.size > this.#capacity * 8) session.seen.clear();
      session.seen.add(key);
      entry.successes += 1;
      hit.push(entry.form);
    }
    return hit;
  }

  /**
   * 找可做最小泛化的条目：同目标模式、已有 ≥1 次成功观测、差异只在值位且变位数未超限。
   * 返回被升级的旧形态与升级后的新形态（真正落表由 `applyUpgrade` 在审阅通过后做）。
   */
  mergeCandidate(
    sessionId: string,
    form: string,
    target?: string,
  ): { form: string; next: string } | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    const tokens = form.split(" ");
    let best: { form: string; next: string; diffs: number } | undefined;
    for (const entry of session.entries.values()) {
      if (entry.target !== target) continue;
      if (entry.successes < 1) continue;
      const merged = mergeForm(entry.tokens, tokens);
      if (merged === undefined) continue;
      const diffs = merged.filter(
        (token) => token === VALUE_PLACEHOLDER,
      ).length;
      if (best === undefined || diffs < best.diffs) {
        best = { form: entry.form, next: merged.join(" "), diffs };
      }
    }
    return best === undefined
      ? undefined
      : { form: best.form, next: best.next };
  }

  /** 应用一次泛化：把 `fromForm` 升级为 `nextForm`，计入这次成功观测，并清掉被覆盖的旧条目。 */
  applyUpgrade(
    sessionId: string,
    fromForm: string,
    nextForm: string,
    target?: string,
    now = new Date(),
  ): boolean {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return false;
    const fromKey = formHash(fromForm, target);
    const entry = session.entries.get(fromKey);
    if (entry === undefined) return false;
    const nextKey = formHash(nextForm, target);
    if (session.entries.has(nextKey)) return false;
    const nextTokens = nextForm.split(" ");
    session.entries.delete(fromKey);
    session.entries.set(nextKey, {
      ...entry,
      form: nextForm,
      tokens: nextTokens,
      approvedAt: now.toISOString(),
      successes: entry.successes + 1,
    });
    // 被新形态完全覆盖的旧条目（同一 base 的来源条目保留）
    for (const [key, other] of [...session.entries.entries()]) {
      if (key === nextKey || other.target !== target) continue;
      if (!matchesForm(nextTokens, other.tokens)) continue;
      session.entries.delete(key);
    }
    return true;
  }

  /** 某会话的条目数（未给会话时取全部）。 */
  size(sessionId?: string): number {
    if (sessionId !== undefined) {
      return this.#sessions.get(sessionId)?.entries.size ?? 0;
    }
    let total = 0;
    for (const session of this.#sessions.values()) {
      total += session.entries.size;
    }
    return total;
  }

  /** 视图（按会话 id 升序、会话内按入表时间升序）。 */
  list(sessionId?: string): FormView[] {
    const out: FormView[] = [];
    const ids =
      sessionId === undefined ? [...this.#sessions.keys()].sort() : [sessionId];
    for (const id of ids) {
      const session = this.#sessions.get(id);
      if (session === undefined) continue;
      const entries = [...session.entries.values()].sort((a, b) =>
        a.approvedAt.localeCompare(b.approvedAt),
      );
      for (const entry of entries) {
        out.push({
          sessionId: id,
          formHash: formHash(entry.form, entry.target),
          form: entry.form,
          toolName: entry.toolName,
          source: entry.source,
          ...(entry.target === undefined ? {} : { target: entry.target }),
          approvedAt: entry.approvedAt,
        });
      }
    }
    return out;
  }

  /**
   * 按形态 id 删（`learn undo <hash>`；给了会话就只在该会话里找）。
   *
   * 支持完整 id 与 `learn list` 里显示的 8 位前缀（不足 8 位按完整 id 精确匹配）。
   */
  remove(hash: string, sessionId?: string): number {
    const prefix = hash.length >= 8;
    let removed = 0;
    for (const [id, session] of this.#sessions) {
      if (sessionId !== undefined && id !== sessionId) continue;
      for (const [key, entry] of [...session.entries.entries()]) {
        const full = formHash(entry.form, entry.target);
        if (prefix ? !full.startsWith(hash) : full !== hash) continue;
        session.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 清空某会话的形态表（未给会话时清空全部）；返回清掉的条数。 */
  clear(sessionId?: string): number {
    if (sessionId === undefined) {
      const total = this.size();
      this.#sessions.clear();
      return total;
    }
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return 0;
    const before = session.entries.size;
    this.#sessions.delete(sessionId);
    return before;
  }

  #session(sessionId: string): SessionForms {
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      session = { entries: new Map(), seen: new Set() };
      this.#sessions.set(sessionId, session);
    }
    return session;
  }

  /** 覆盖某段形态的条目（同目标模式、通配匹配）。 */
  #match(
    session: SessionForms,
    tokens: readonly string[],
    target?: string,
  ): FormEntry | undefined {
    for (const entry of session.entries.values()) {
      if (entry.target !== target) continue;
      if (matchesForm(entry.tokens, tokens)) return entry;
    }
    return undefined;
  }
}

/*
 * ── 学习器（事件状态机） ─────────────────────────────────────────────────────
 */

/** 判定层用到的学习钩子（`decide.ts` 只依赖这个面，不依赖整个学习器）。 */
export interface LearnHooks {
  /** 本插件自己裁定的 `allowed-once`（按 callId 自记，decided 时据此排除）。 */
  noteSelfDecision(callId?: string): void;
  /** 首用某会话时触发一次回填（同步触发、异步完成、失败降级空集）。 */
  ensureRehydrated(sessionId: string): void;
}

/** 回填数据源（缺省 = 不可用，直接空集）。 */
export interface LearnHistory {
  readEvents(sessionId: string): Promise<readonly SessionEventLike[]>;
  readAuditCallIds(sessionId: string): readonly string[];
}

/** 学习器选项（全可注入：测试用假宿主 / 假 LLM / 手控定时器）。 */
export interface LearnerOptions {
  config: ResolvedConfig;
  calls: CallTable;
  sessions: SessionObserver;
  forms: FormStore;
  fingerprints: FingerprintStore;
  /** 运行态是否允许学习（`enabled` + 模式；`learn off` 另算）。 */
  isActive: () => boolean;
  reviewer?: LearnReviewer;
  warn: (message: string) => void;
  /** 学习结果的提示出口（插件 logger）；每会话首次一条。 */
  log?: (message: string) => void;
  now?: () => number;
  /** 合并窗口的定时器（测试注入手控实现）。 */
  schedule?: (fn: () => void, ms: number) => () => void;
  history?: LearnHistory;
  windowMs?: number;
}

/** 学习器对外句柄。 */
export interface Learner extends LearnHooks {
  /** 吸收一条会话事件（`approval/asked` / `approval/decided` / `tool/result`）。 */
  observe(sessionId: string, event: SessionEventLike): void;
  /** 运行态学习开关（`/autoapprove learn on|off`；不动运行时裁定）。 */
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  /** 回填一个会话（一次性；返回新增形态条数）。 */
  rehydrate(sessionId: string): Promise<number>;
  /** 等待窗口内的审阅批次与回填结算（测试用）。 */
  flush(): Promise<void>;
  dispose(): void;
}

/** 待审阅的候选（`new` = A 层新形态；`upgrade` = B 层泛化后的形态）。 */
interface PendingCandidate {
  kind: "new" | "upgrade";
  sessionId: string;
  toolName: string;
  form: string;
  /** `upgrade` 用：被升级的旧形态。 */
  fromForm?: string;
  command: string;
  cwd: string;
  callId: string;
  target?: string;
  reason?: string;
}

/** 一条已配对的审批（asked 的内容）。 */
interface PendingAsk {
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

/** 缺省定时器（unref，避免拖住进程退出）。 */
function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 创建学习器。所有副作用都是「表内记账 + 一次模型请求」，不写盘、不发事件。
 */
export function createLearner(options: LearnerOptions): Learner {
  const { config, calls, sessions, forms, fingerprints } = options;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? defaultSchedule;
  const windowMs = Math.max(1, options.windowMs ?? LEARN_REVIEW_WINDOW_MS);
  const warn = options.warn;
  const log = options.log ?? (() => {});

  /** asked 配对表（ask id → 配对信息）。 */
  const pendingAsks = new Map<string, PendingAsk>();
  /** 本插件自己裁过的 callId（→ 过期时刻）。 */
  const selfDecided = new Map<string, number>();
  /** 每会话的成功执行标记（`callId`，容量同 `callTableCapacity`）。 */
  const successful = new Map<string, Set<string>>();
  /** 已审阅过的形态（同形态不重复审阅）。 */
  const reviewed = new Set<string>();
  /** 已回填过的会话（一次性）。 */
  const rehydrated = new Set<string>();
  /** 进行中的回填（`flush` 等它结算）。 */
  const rehydrating = new Set<Promise<number>>();
  /** 已打过学习日志的会话（每会话首次一条）。 */
  const logged = new Set<string>();
  /** 待审阅批次。 */
  let pending: PendingCandidate[] = [];
  let cancelTimer: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  let enabled = true;
  let disposed = false;

  function learningActive(): boolean {
    return enabled && config.learnFromManual && options.isActive();
  }

  function reviewKey(
    sessionId: string,
    form: string,
    target: string | undefined,
  ): string {
    return `${sessionId}\u0000${target ?? ""}\u0000${form}`;
  }

  function markReviewed(
    sessionId: string,
    form: string,
    target: string | undefined,
  ): boolean {
    const key = reviewKey(sessionId, form, target);
    if (reviewed.has(key)) return false;
    if (reviewed.size > config.formCapacity * 8) reviewed.clear();
    reviewed.add(key);
    return true;
  }

  function isSelfDecided(callId: string): boolean {
    const expires = selfDecided.get(callId);
    if (expires === undefined) return false;
    if (expires <= now()) {
      selfDecided.delete(callId);
      return false;
    }
    return true;
  }

  function noteSelfDecision(callId?: string): void {
    if (callId === undefined) return;
    selfDecided.set(callId, now() + config.selfDecidedTtlMs);
    while (selfDecided.size > config.selfDecidedCapacity) {
      const oldest = selfDecided.keys().next();
      if (oldest.done === true) break;
      selfDecided.delete(oldest.value);
    }
  }

  function successTable(sessionId: string): Set<string> {
    let table = successful.get(sessionId);
    if (table === undefined) {
      table = new Set();
      successful.set(sessionId, table);
    }
    return table;
  }

  function succeeded(sessionId: string, callId: string): boolean {
    return successful.get(sessionId)?.has(callId) === true;
  }

  /** 按 `callId` 反查参数（`pre-execute` 表优先，会话日志兜底）。 */
  function resolveCall(
    sessionId: string,
    callId: string,
  ): CallInfo | undefined {
    const recorded = calls.get(callId);
    if (recorded !== undefined && recorded.arguments !== undefined) {
      return recorded;
    }
    const observed = sessions.callOf(sessionId, callId);
    if (observed === undefined) return undefined;
    const cwd = sessions.cwdOf(sessionId);
    return {
      callId,
      name: observed.name,
      arguments: parseArguments(observed.arguments),
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
    };
  }

  /** 候选入队；窗口内多条合并成一次审阅。 */
  function queue(candidate: PendingCandidate): void {
    if (disposed) return;
    pending.push(candidate);
    if (cancelTimer !== undefined) return;
    cancelTimer = schedule(() => {
      cancelTimer = undefined;
      startFlush();
    }, windowMs);
  }

  function startFlush(): void {
    if (inFlight !== undefined || pending.length === 0) return;
    const batch = pending;
    pending = [];
    inFlight = reviewAndApply(batch)
      .catch((error: unknown) => {
        warn(`学习批次应用失败（已忽略）：${String(error)}`);
      })
      .finally(() => {
        inFlight = undefined;
        // 审阅期间又攒了候选：按同一个窗口重新排一次（合并成下一次请求）
        if (pending.length > 0 && cancelTimer === undefined && !disposed) {
          cancelTimer = schedule(() => {
            cancelTimer = undefined;
            startFlush();
          }, windowMs);
        }
      });
  }

  /** 一批候选 → 一次审阅 → 逐条落地（失败 / 不达标一律不入表）。 */
  async function reviewAndApply(
    batch: readonly PendingCandidate[],
  ): Promise<void> {
    let outcomes: readonly (LearnReviewOutcome | undefined)[];
    try {
      outcomes = await review(batch);
    } catch (error) {
      warn(
        `学习审阅不可用，本批 ${batch.length} 条形态不入表：${String(error)}`,
      );
      return;
    }
    const added = new Map<string, number>();
    let denied = 0;
    for (let index = 0; index < batch.length; index += 1) {
      const candidate = batch[index];
      const outcome = outcomes[index];
      if (candidate === undefined) continue;
      if (outcome === undefined || !admitted(outcome)) {
        denied += 1;
        continue;
      }
      if (!apply(candidate)) {
        denied += 1;
        continue;
      }
      added.set(candidate.sessionId, (added.get(candidate.sessionId) ?? 0) + 1);
    }
    // 每会话首次一条（同批可能跨会话：逐会话各记一条）
    for (const [sessionId, count] of added) {
      if (logged.has(sessionId)) continue;
      logged.add(sessionId);
      log(
        `auto-approve 学习：会话 ${sessionId.slice(0, 8)} 新增 ${count} 条形态` +
          `（本批审阅未通过 ${denied} 条；同会话后续等价调用免问）`,
      );
    }
  }

  /** 一次审阅请求（审阅关闭时按 A / B 直接通过）。 */
  async function review(
    batch: readonly PendingCandidate[],
  ): Promise<readonly (LearnReviewOutcome | undefined)[]> {
    const pass = batch.map(() => ({ allow: true, risk: "low" as const }));
    if (!config.learnReview.enabled) return pass;
    const reviewer = options.reviewer;
    if (reviewer === undefined) {
      throw new Error("学习审阅器不可用");
    }
    const candidates: LearnCandidate[] = batch.map((candidate, index) => ({
      index,
      toolName: candidate.toolName,
      form: candidate.form,
      command: candidate.command,
      cwd: candidate.cwd,
      ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
      ...(candidate.target === undefined ? {} : { target: candidate.target }),
    }));
    const sessionId = batch[0]?.sessionId;
    return await reviewer({
      ...(sessionId === undefined ? {} : { sessionId }),
      candidates,
    });
  }

  /** 审阅结论是否达标（`allow` 且风险不高于运行时的 `maxRiskAllow`）。 */
  function admitted(outcome: {
    allow: boolean;
    risk: "low" | "medium" | "high";
  }): boolean {
    return (
      outcome.allow && riskAtMost(outcome.risk, config.review.maxRiskAllow)
    );
  }

  /** 落表（A 新入 / B 升级）；返回是否改动。 */
  function apply(candidate: PendingCandidate): boolean {
    if (candidate.kind === "new") {
      const added = forms.add(
        candidate.sessionId,
        candidate.form,
        candidate.toolName,
        "manual",
        candidate.target,
      );
      if (!added) return false;
      if (succeeded(candidate.sessionId, candidate.callId)) {
        forms.noteSuccess(
          candidate.sessionId,
          candidate.callId,
          [candidate.form],
          candidate.target,
        );
      }
      return true;
    }
    const fromForm = candidate.fromForm;
    if (fromForm === undefined) return false;
    const upgraded = forms.applyUpgrade(
      candidate.sessionId,
      fromForm,
      candidate.form,
      candidate.target,
    );
    if (!upgraded) return false;
    forms.noteSuccess(
      candidate.sessionId,
      candidate.callId,
      [candidate.form],
      candidate.target,
    );
    return true;
  }

  /** 人工放行 → 候选（精确指纹立即记；形态走审阅）。 */
  function learnFromApproval(ask: PendingAsk): void {
    const callId = ask.callId;
    if (callId === undefined) return;
    const call = resolveCall(ask.sessionId, callId);
    if (call === undefined) return;
    const target = parseEscalationTarget(ask.reason) ?? call.escalationTarget;
    const hash = fingerprintOf(call.name, call.arguments, target);
    fingerprints.approve(ask.sessionId, hash, call.name, "manual");
    const command = commandOfCall(call);
    if (command === undefined) return;
    const segments = formOfCommand(command);
    if (segments === undefined) return;
    const cwd = call.cwd ?? sessions.cwdOf(ask.sessionId) ?? process.cwd();
    for (const form of segments) {
      if (forms.covers(ask.sessionId, [form], target)) continue;
      if (!markReviewed(ask.sessionId, form, target)) continue;
      queue({
        kind: "new",
        sessionId: ask.sessionId,
        toolName: call.name,
        form,
        command,
        cwd,
        callId,
        ...(target === undefined ? {} : { target }),
        ...(ask.reason === undefined ? {} : { reason: ask.reason }),
      });
    }
  }

  /** 成功执行 → 计入观测（B 层「第二次观测」）或产生泛化候选。 */
  function observeExecution(sessionId: string, callId: string): void {
    const call = resolveCall(sessionId, callId);
    if (call === undefined) return;
    const command = commandOfCall(call);
    if (command === undefined) return;
    const segments = formOfCommand(command);
    if (segments === undefined) return;
    const target = call.escalationTarget;
    const cwd = call.cwd ?? sessions.cwdOf(sessionId) ?? process.cwd();
    for (const form of segments) {
      // 先计入这次的观测，再（无论是否被覆盖）找可最小泛化的旧形态：
      // 「同段第二次观测」可能来自两个各自独立的条目（值位不同 → A 层学成两条）
      forms.noteSuccess(sessionId, callId, [form], target);
      const candidate = forms.mergeCandidate(sessionId, form, target);
      if (candidate === undefined) continue;
      if (!markReviewed(sessionId, candidate.next, target)) continue;
      queue({
        kind: "upgrade",
        sessionId,
        toolName: call.name,
        form: candidate.next,
        fromForm: candidate.form,
        command,
        cwd,
        callId,
        ...(target === undefined ? {} : { target }),
      });
    }
  }

  function onAsked(sessionId: string, data: Record<string, unknown>): void {
    const id = nonEmptyString(data["id"]);
    const toolName = nonEmptyString(data["toolName"]);
    if (id === undefined || toolName === undefined) return;
    const callId = nonEmptyString(data["callId"]);
    const reason = nonEmptyString(data["reason"]);
    pendingAsks.set(id, {
      sessionId,
      toolName,
      ...(callId === undefined ? {} : { callId }),
      ...(reason === undefined ? {} : { reason }),
    });
    while (pendingAsks.size > PENDING_ASK_CAPACITY) {
      const oldest = pendingAsks.keys().next();
      if (oldest.done === true) break;
      pendingAsks.delete(oldest.value);
    }
  }

  function onDecided(sessionId: string, data: Record<string, unknown>): void {
    const id = nonEmptyString(data["id"]);
    if (id === undefined) return;
    const ask = pendingAsks.get(id);
    pendingAsks.delete(id);
    if (ask === undefined) return;
    // 只有人工面板的 allowed-once 才是学习来源（拒绝 / cancelled / unavailable 不入表）
    if (data["outcome"] !== "allowed-once") return;
    if (!learningActive()) return;
    // 本插件自己裁的也算 allowed-once：自记集合命中即跳过
    if (ask.callId !== undefined && isSelfDecided(ask.callId)) return;
    learnFromApproval(ask);
  }

  function onResult(sessionId: string, data: Record<string, unknown>): void {
    const message = asRecord(data["message"]);
    const callId = nonEmptyString(message?.["toolCallId"]);
    if (callId === undefined) return;
    // `isError` 缺失 / 非 false 一律按「未成功」处理（失败只挡泛化，不挡首次学习）
    if (message?.["isError"] !== false) return;
    const table = successTable(sessionId);
    if (table.has(callId)) return;
    table.add(callId);
    while (table.size > config.callTableCapacity) {
      const oldest = table.values().next();
      if (oldest.done === true) break;
      table.delete(oldest.value);
    }
    if (!learningActive() || !config.learnGeneralize) return;
    observeExecution(sessionId, callId);
  }

  /** 回填：读会话历史 + 本会话审计文件，重建形态集（一次性、上限 20、只计成功）。 */
  async function rehydrate(sessionId: string): Promise<number> {
    if (rehydrated.has(sessionId)) return 0;
    rehydrated.add(sessionId);
    const history = options.history;
    if (history === undefined || !learningActive()) return 0;
    let events: readonly SessionEventLike[];
    let selfCallIds: ReadonlySet<string>;
    try {
      events = await history.readEvents(sessionId);
      selfCallIds = new Set(history.readAuditCallIds(sessionId));
    } catch (error) {
      warn(`学习回填失败（本会话按空集处理）：${String(error)}`);
      return 0;
    }
    const asked = new Map<
      string,
      { toolName: string; callId?: string; reason?: string }
    >();
    const decided = new Map<string, string>();
    const callArgs = new Map<string, unknown>();
    const callNames = new Map<string, string>();
    const success = new Set<string>();
    for (const event of events) {
      const data = asRecord(event.data);
      if (event.type === "approval/asked") {
        const id = nonEmptyString(data?.["id"]);
        const toolName = nonEmptyString(data?.["toolName"]);
        if (id === undefined || toolName === undefined) continue;
        const callId = nonEmptyString(data?.["callId"]);
        const reason = nonEmptyString(data?.["reason"]);
        asked.set(id, {
          toolName,
          ...(callId === undefined ? {} : { callId }),
          ...(reason === undefined ? {} : { reason }),
        });
        continue;
      }
      if (event.type === "approval/decided") {
        const id = nonEmptyString(data?.["id"]);
        const outcome = nonEmptyString(data?.["outcome"]);
        if (id !== undefined && outcome !== undefined) decided.set(id, outcome);
        continue;
      }
      if (event.type === "tool/call") {
        const callId = nonEmptyString(data?.["callId"]);
        const name = nonEmptyString(data?.["name"]);
        if (callId === undefined || name === undefined) continue;
        callNames.set(callId, name);
        callArgs.set(callId, parseArguments(data?.["arguments"]));
        continue;
      }
      if (event.type === "tool/result") {
        const message = asRecord(data?.["message"]);
        const callId = nonEmptyString(message?.["toolCallId"]);
        if (callId !== undefined && message?.["isError"] === false) {
          success.add(callId);
        }
      }
    }
    // 人工放行 = decided 为 allowed-once 且本包审计里没有该 callId（排除本插件自己的裁定）
    const manual: { callId: string; toolName: string; reason?: string }[] = [];
    for (const [id, ask] of asked) {
      if (decided.get(id) !== "allowed-once") continue;
      const callId = ask.callId;
      if (callId === undefined || selfCallIds.has(callId)) continue;
      if (!success.has(callId)) continue;
      manual.push({
        callId,
        toolName: ask.toolName,
        ...(ask.reason === undefined ? {} : { reason: ask.reason }),
      });
    }
    if (manual.length === 0) return 0;
    const kept = manual.slice(-REHYDRATE_LIMIT);
    if (manual.length > kept.length) {
      log(
        `auto-approve 学习回填：会话 ${sessionId.slice(0, 8)} 有 ${manual.length} 条人工放行` +
          `，单次只处理最近 ${REHYDRATE_LIMIT} 条（其余丢弃）`,
      );
    }
    const cwd = sessions.cwdOf(sessionId) ?? process.cwd();
    const batch: PendingCandidate[] = [];
    for (const entry of kept) {
      const name = callNames.get(entry.callId) ?? entry.toolName;
      const args = callArgs.get(entry.callId);
      const call: CallInfo = {
        callId: entry.callId,
        name,
        arguments: args,
        sessionId,
        cwd,
      };
      const command = commandOfCall(call);
      if (command === undefined) continue;
      const segments = formOfCommand(command);
      if (segments === undefined) continue;
      for (const form of segments) {
        if (forms.covers(sessionId, [form])) continue;
        if (!markReviewed(sessionId, form, undefined)) continue;
        batch.push({
          kind: "new",
          sessionId,
          toolName: name,
          form,
          command,
          cwd,
          callId: entry.callId,
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        });
      }
    }
    if (batch.length === 0) return 0;
    let outcomes: readonly (LearnReviewOutcome | undefined)[];
    try {
      outcomes = await review(batch);
    } catch (error) {
      warn(
        `学习回填审阅不可用，会话 ${sessionId.slice(0, 8)} 按空集处理：${String(error)}`,
      );
      return 0;
    }
    let added = 0;
    for (let index = 0; index < batch.length; index += 1) {
      const candidate = batch[index];
      const outcome = outcomes[index];
      if (candidate === undefined) continue;
      if (outcome === undefined || !admitted(outcome)) continue;
      if (!apply(candidate)) continue;
      added += 1;
      // 回填只收成功执行的调用：入表即计一次成功观测（B 层后续才可能泛化）
      forms.noteSuccess(
        sessionId,
        candidate.callId,
        [candidate.form],
        candidate.target,
      );
    }
    return added;
  }

  function ensureRehydrated(sessionId: string): void {
    if (!config.learnRehydrate || !learningActive()) return;
    if (options.history === undefined) return;
    if (rehydrated.has(sessionId)) return;
    const task = rehydrate(sessionId).catch((error: unknown) => {
      warn(`学习回填异常（已忽略）：${String(error)}`);
      return 0;
    });
    rehydrating.add(task);
    void task.finally(() => rehydrating.delete(task));
  }

  return {
    noteSelfDecision,
    ensureRehydrated,
    observe(sessionId, event) {
      if (disposed) return;
      const data = asRecord(event.data);
      if (data === undefined) return;
      if (event.type === "approval/asked") onAsked(sessionId, data);
      else if (event.type === "approval/decided") onDecided(sessionId, data);
      else if (event.type === "tool/result") onResult(sessionId, data);
    },
    setEnabled(on: boolean) {
      enabled = on;
    },
    isEnabled(): boolean {
      return enabled;
    },
    rehydrate,
    async flush() {
      if (cancelTimer !== undefined) {
        cancelTimer();
        cancelTimer = undefined;
      }
      startFlush();
      while (inFlight !== undefined) await inFlight;
      if (rehydrating.size > 0) await Promise.all([...rehydrating]);
    },
    dispose() {
      disposed = true;
      if (cancelTimer !== undefined) {
        cancelTimer();
        cancelTimer = undefined;
      }
      pending = [];
      pendingAsks.clear();
      selfDecided.clear();
      successful.clear();
      reviewed.clear();
      rehydrated.clear();
      logged.clear();
    },
  };
}

/** 读本会话审计文件里的 `callId` 集合（回填时排除本插件自己的裁定；失败 → 空集）。 */
export function readAuditCallIds(
  sessionPaths: { sessionDirFor(sessionId: string): string } | undefined,
  sessionId: string,
): string[] {
  if (sessionPaths === undefined) return [];
  try {
    const file = join(sessionPaths.sessionDirFor(sessionId), AUDIT_FILE_NAME);
    const out: string[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line) as {
          callId?: unknown;
          truncated?: unknown;
        };
        if (row.truncated === true) continue;
        const callId = nonEmptyString(row.callId);
        if (callId !== undefined) out.push(callId);
      } catch {
        // 坏行忽略（只读回填不因单行损坏失败）
      }
    }
    return out;
  } catch {
    return [];
  }
}
