/**
 * 存储适配与注入（设计 D7 / D16 / D18 / D10）。
 *
 * - 两个写入作用域句柄：`preference`（只写项目层，归纳路径）与 `preference_user`
 *   （只写用户层，仅显式动作调用）——越权层由 memory-base 抛错，属能力式硬闸；
 * - 自动应用 / 撤销 / 退休只经句柄 `put` / `forget`，列举经全局 `list`（库只是正文副本，
 *   生效信号在账簿里）；
 * - 注入只注册一个 rule-engine 消费者，`decide` 只读账簿快照，渲染时守条数与字符上限。
 *
 * 上游尚未提供新面（`registerKind` 未返回句柄）时 `createMemoryPort` 明确失败，调用方
 * 停在「只观察不写入 / 不注入」，不做冒充 `origin: "user"` 之类的临时妥协。
 */
import { normalizeKey } from "./induce.ts";
import type { LedgerEntry } from "./ledger.ts";

/** 记忆层。 */
export type Tier = "session" | "project" | "user";

/** `preWrite` 入参（与上游 `KindWriteInput` 对齐，不含 `tier`）。 */
export interface KindWriteInput {
  content: string;
  title?: string;
  project: string;
  kind: string;
}

/** `preWrite` 判定。 */
export interface KindVerdict {
  accept: boolean;
  reason?: string;
  importance?: number;
}

/** 分类注册项（与上游 `KindSpec` 对齐）。 */
export interface KindSpec {
  kind: string;
  table?: string;
  writableTiers?: readonly Tier[];
  preWrite?: (input: KindWriteInput) => KindVerdict | Promise<KindVerdict>;
}

/** 句柄写入入参（与上游 `ScopePutInput` 对齐）。 */
export interface ScopePutInput {
  content: string;
  tier?: Tier;
  project?: string;
  title?: string;
  importance?: number;
  source?: { kind?: string; ref?: string; label?: string };
  sessionId?: string;
}

/** 句柄写入结果（与上游 `PutResult` 对齐）。 */
export interface PutResult {
  ids: number[];
  sourceId: number;
  created: number;
  skipped?: { reason: string };
}

/** 写入作用域句柄（与上游 `MemoryScope` 对齐）。 */
export interface MemoryScope {
  readonly kind: string;
  readonly writableTiers: readonly Tier[];
  put(input: ScopePutInput): Promise<PutResult>;
  forget(
    refs: readonly { tier: Tier; ids: readonly number[] }[],
  ): Promise<number>;
}

/** 全局只读行（与上游 `StoreRow` 对齐，只用本包需要的字段）。 */
export interface StoreRow {
  id: number;
  kind: string;
  tier: Tier;
  project: string;
  title: string | null;
  content: string;
  importance: number;
  sessionId: string | null;
  createdAt: number;
}

/** `memory` 服务面（只声明本包用到的成员）。 */
export interface MemoryFace {
  registerKind(spec: KindSpec): MemoryScope;
  checkPrivacy(text: string): string | null;
  list?(opts?: {
    kind?: string;
    tier?: Tier;
    project?: string;
    limit?: number;
    offset?: number;
  }): Promise<StoreRow[]>;
}

/** 可用端口：两个句柄 + 隐私闸。 */
export interface MemoryPort {
  face: MemoryFace;
  /** 归纳路径：只可写项目层。 */
  induction: MemoryScope;
  /** 显式动作路径：只可写用户层。 */
  explicit: MemoryScope;
  /** 隐私预检（本包自有敏感模式 + memory-base 内置闸）。 */
  checkPrivacy(text: string): string | null;
}

/** 端口解析结果。 */
export type MemoryPortResult =
  { ok: true; port: MemoryPort } | { ok: false; reason: string };

/** 本包自有敏感模式（D10 a1）：账簿不经过库闸门，必须在写前自己拦一遍。 */
const SENSITIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\.ssh\b/iu, reason: "疑似私钥目录" },
  { pattern: /\bid_rsa\b/iu, reason: "疑似私钥文件名" },
  { pattern: /(?:^|[\\/\s])\.env(?:$|[^\w])/iu, reason: "疑似凭据文件" },
  { pattern: /\bcredentials\b/iu, reason: "疑似凭据文件" },
  {
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,})\b/u,
    reason: "疑似凭据形态",
  },
  {
    pattern:
      /(?:^|\s)(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/u,
    reason: "疑似家目录绝对路径",
  },
];

/** 本包自有隐私模式命中原因；未命中返回 null。 */
export function sensitiveReason(text: string): string | null {
  for (const { pattern, reason } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

/**
 * 解析 `memory` 服务为端口：注册两个 kind 并校验返回的是作用域句柄。
 * 旧形态（返回 `RegisteredKind` 的 Promise）或服务缺失一律失败，由调用方降级。
 */
export function createMemoryPort(face: unknown): MemoryPortResult {
  if (
    !isRecord(face) ||
    typeof face["registerKind"] !== "function" ||
    typeof face["checkPrivacy"] !== "function"
  ) {
    return {
      ok: false,
      reason:
        "memory 服务缺少 registerKind / checkPrivacy（需要 memory-base 的分层句柄面）",
    };
  }
  const service = face as unknown as MemoryFace;
  const checkPrivacy = (text: string): string | null => {
    const own = sensitiveReason(text);
    if (own !== null) return own;
    try {
      return service.checkPrivacy(text);
    } catch (error) {
      return `隐私预检失败: ${describe(error)}`;
    }
  };
  // 纵深防御（D10 a2）：内容级再拒一次；preWrite 入参不含 tier，故按 kind 拆分（上游已记明）。
  const preWrite = (input: KindWriteInput): KindVerdict => {
    const reason = checkPrivacy(input.content);
    return reason === null ? { accept: true } : { accept: false, reason };
  };
  try {
    const induction = service.registerKind({
      kind: "preference",
      writableTiers: ["project"],
      preWrite,
    });
    const explicit = service.registerKind({
      kind: "preference_user",
      writableTiers: ["user"],
    });
    if (!isScope(induction) || !isScope(explicit)) {
      return {
        ok: false,
        reason:
          "registerKind 未返回作用域句柄（memory-base 尚未提供分层句柄面），停用写入与注入",
      };
    }
    if (
      !induction.writableTiers.includes("project") ||
      !explicit.writableTiers.includes("user")
    ) {
      return {
        ok: false,
        reason: "registerKind 返回的可写层与注册值不一致，停用写入与注入",
      };
    }
    return {
      ok: true,
      port: {
        face: service,
        induction,
        explicit,
        checkPrivacy,
      },
    };
  } catch (error) {
    return { ok: false, reason: `registerKind 失败: ${describe(error)}` };
  }
}

/** 自动应用结果。 */
export interface ApplyOutcome {
  ok: boolean;
  ids: number[];
  reason?: string;
  /** 命中库内已有副本（重试幂等，不重复写行）。 */
  reused?: boolean;
}

/** 把一条偏好写进 memory-base（项目层）。 */
export async function applyEntry(
  port: MemoryPort,
  entry: LedgerEntry,
  options: { title?: string } = {},
): Promise<ApplyOutcome> {
  const reason = port.checkPrivacy(entry.text);
  if (reason !== null) return { ok: false, ids: [], reason };
  const existing = await findExistingRow(port, entry);
  if (existing !== undefined)
    return { ok: true, ids: [existing.id], reused: true };
  const sessionId = entry.sessions[entry.sessions.length - 1];
  const title = options.title ?? entry.title;
  try {
    const result = await port.induction.put({
      content: entry.text,
      tier: "project",
      ...(entry.project.length > 0 ? { project: entry.project } : {}),
      ...(title === undefined ? {} : { title }),
      importance: entry.importance,
      source: { kind: "manual" },
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    const id = result.ids[0];
    if (id === undefined) {
      return {
        ok: false,
        ids: [],
        reason: result.skipped?.reason ?? "skipped",
      };
    }
    return { ok: true, ids: [id] };
  } catch (error) {
    return { ok: false, ids: [], reason: describe(error) };
  }
}

/** 撤销 / 退休：按账簿里的副本引用真删（返回删条数）。 */
export async function retireEntry(
  port: MemoryPort,
  entry: LedgerEntry,
): Promise<{ ok: boolean; removed: number; reason?: string }> {
  if (entry.memory === undefined) return { ok: true, removed: 0 };
  const scope =
    entry.memory.scope === "explicit" ? port.explicit : port.induction;
  try {
    const removed = await scope.forget([
      { tier: entry.memory.tier, ids: [entry.memory.id] },
    ]);
    return { ok: true, removed };
  } catch (error) {
    return { ok: false, removed: 0, reason: describe(error) };
  }
}

/** 显式动作写入用户层（D18：只由用户显式要求调用）。 */
export async function applyExplicit(
  port: MemoryPort,
  entry: LedgerEntry,
): Promise<ApplyOutcome> {
  const reason = port.checkPrivacy(entry.text);
  if (reason !== null) return { ok: false, ids: [], reason };
  try {
    const result = await port.explicit.put({
      content: entry.text,
      tier: "user",
      importance: entry.importance,
      source: { kind: "manual" },
    });
    const id = result.ids[0];
    if (id === undefined) {
      return {
        ok: false,
        ids: [],
        reason: result.skipped?.reason ?? "skipped",
      };
    }
    return { ok: true, ids: [id] };
  } catch (error) {
    return { ok: false, ids: [], reason: describe(error) };
  }
}

/** 注入摘要（rule-engine 的 `source.summary`，去重与展示按此识别）。 */
export const INJECTION_SUMMARY = "用户偏好提醒";

/** 注入正文首行（说明来源与可撤销性）。 */
export const INJECTION_HEADER =
  "以下是用户此前多次提出的偏好（由历史会话归纳, 用户可撤销）, 本会话请遵守:";

/** 注入上限（条数与字符）。 */
export interface InjectionLimits {
  maxItems: number;
  maxChars: number;
}

/** 注入渲染结果。 */
export interface InjectionResult {
  text: string;
  items: number;
  dropped: number;
}

/**
 * 渲染偏好注入：按重要度与最近证据排序，守 `maxItems` / `maxChars`；
 * 超限只截断列表并在末尾标注条数（不改写正文、不静默丢弃）。
 */
export function renderInjection(
  entries: readonly LedgerEntry[],
  limits: InjectionLimits,
): InjectionResult | null {
  const sorted = [...entries].sort(
    (a, b) => b.importance - a.importance || b.lastSeen - a.lastSeen,
  );
  const accepted: LedgerEntry[] = [];
  for (const entry of sorted) {
    if (accepted.length >= limits.maxItems) break;
    accepted.push(entry);
    if (
      renderLines(accepted, sorted.length - accepted.length).length >
      limits.maxChars
    ) {
      accepted.pop();
      break;
    }
  }
  if (accepted.length === 0) return null;
  const dropped = sorted.length - accepted.length;
  return {
    text: renderLines(accepted, dropped),
    items: accepted.length,
    dropped,
  };
}

function renderLines(entries: readonly LedgerEntry[], dropped: number): string {
  const lines = entries.map((entry) => `- ${entry.text}`);
  if (dropped > 0) lines.push(`另有 ${dropped} 条偏好未列出。`);
  return [INJECTION_HEADER, ...lines].join("\n");
}

/** 重试幂等：库内已有同内容副本时复用其 id（不重复写行）。 */
async function findExistingRow(
  port: MemoryPort,
  entry: LedgerEntry,
): Promise<StoreRow | undefined> {
  const list = port.face.list;
  if (typeof list !== "function") return undefined;
  try {
    const rows = await list.call(port.face, {
      kind: "preference",
      tier: "project",
      ...(entry.project.length > 0 ? { project: entry.project } : {}),
      limit: 500,
    });
    const key = normalizeKey(entry.text);
    return rows.find((row) => normalizeKey(row.content) === key);
  } catch {
    return undefined;
  }
}

function isScope(value: unknown): value is MemoryScope {
  if (!isRecord(value)) return false;
  return (
    typeof value["put"] === "function" &&
    typeof value["forget"] === "function" &&
    Array.isArray(value["writableTiers"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
