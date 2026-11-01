/**
 * 学习层规则面：命令切段 / 切 token / 抹值 / 形态匹配与最小泛化 + 有界形态表。
 *
 * 这一层只有纯函数与表结构，不碰会话事件、不调模型；观测层（`learn-observe.ts`）决定
 * 「何时学」，本层决定「学成什么形状」（口径见
 * `docs/archived/2026-10-21-manual-approval-fingerprint.md`）：
 *
 * - **词法层（纯函数）**：按 `security-guard` 的口径切段（引号内分隔符不切）→ 词法切 token
 *   （处理 `-m"b"` 这类无空格粘连）→ 固定抹值（引号串 `<msg>` / 长 hex `<hex>` / 纯数字 `<n>`）；
 *   **不抹**路径 / 分支名 / URL / 选项名（宁可少泛化）。段首命令词保持原文，永不遮成占位。
 * - **形态表（`FormStore`）**：每会话一张，`formCapacity` 近似 LRU；覆盖判定是「每一段都在表里」
 *   （顺序无关）。A 层 = 精确形态；B 层 = 同段第二次**成功**观测时做最小泛化（差异位升级为
 *   `<v>`，段首命令词与子命令永不通配，单段变体位 ≤ 2）。
 */

import { createHash } from "node:crypto";

import { SHELL_TOOLS } from "./config.ts";
import { COMMAND_KEYS, matchesAnyTool, pickString } from "./patterns.ts";
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
