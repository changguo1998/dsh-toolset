/**
 * 账簿：本插件自持的跨会话状态文件（设计 D16：唯一状态源）。
 *
 * 落点 `<dshHome>/preference-analysis/ledger.json`：目录 0700、文件 0600；写入先写同目录
 * 临时文件再 rename（原子替换），并在写前做版本守卫（磁盘 revision 与内存不一致即拒写）。
 * 状态机 `observe -> candidate -> active -> dormant -> retired`；`suppressed` 保存被用户
 * 拒绝 / 撤销 / 退休的归一化 key，防止同一模式被重新归纳出来。
 *
 * 降级：文件损坏 -> 改名留档（`ledger.json.corrupt-<时间戳>`）并从空账簿开始；版本不受支持
 * -> 拒载拒写（只留告警），不静默覆盖用户数据。
 */
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/** 账簿文件格式版本（结构不兼容时递增）。 */
export const LEDGER_VERSION = 1;
/** 账簿目录名（`<dshHome>/<此名>/ledger.json`）。 */
export const LEDGER_DIR = "preference-analysis";
/** 账簿文件名。 */
export const LEDGER_FILE = "ledger.json";
/** 账簿条目上限：超出时先淘汰退休 / 观察中条目，再淘汰最久未见的。 */
export const MAX_ENTRIES = 500;
/** 单条目保留的会话 id 上限（阈值只比较“跨几个会话”，无需全量）。 */
export const MAX_SESSIONS_PER_ENTRY = 20;
/** `suppressed` 键上限（超出时丢最早者）。 */
export const MAX_SUPPRESSED = 500;

/** 偏好生命周期状态。 */
export type LedgerStatus =
  "observe" | "candidate" | "active" | "dormant" | "retired";

/** 库内副本引用（撤销 / 退休时按此删行）。 */
export interface LedgerMemoryRef {
  /** 写入用的句柄：归纳路径（项目层）/ 显式动作（用户层）。 */
  scope: "induction" | "explicit";
  tier: "project" | "user";
  id: number;
}

/** 一条偏好账簿条目。 */
export interface LedgerEntry {
  /** 稳定 id（由归一化 key 派生，重放同一模式不会变）。 */
  id: string;
  /** 归一化 key（去空白与标点、大小写折叠；S3 用 `tool:参数首段` 指纹）。 */
  key: string;
  /** 偏好正文（用户原话片段；S3 为机械生成的约束句）。 */
  text: string;
  status: LedgerStatus;
  /** 加权证据数（S2 纠正语境 x1.5）。 */
  evidence: number;
  /** 出现过的会话 id（去重，保留最近 MAX_SESSIONS_PER_ENTRY 个）。 */
  sessions: string[];
  /** 证据来源：用户重复原话 / 审批拒绝 / 模型显式提议。 */
  origin: "user" | "approval" | "model";
  /** 项目作用域（写入 P 层时用；缺省空串表示未知）。 */
  project: string;
  /** 可选标题（模型提议可带）。 */
  title?: string;
  /** 重要度 1..5（候选 3 / 高置信 4；`importance` 是少数能经服务面写入的元数据位）。 */
  importance: number;
  firstSeen: number;
  lastSeen: number;
  activatedAt?: number;
  /** 库内副本引用（写入成功后才有）。 */
  memory?: LedgerMemoryRef;
  /** 退出原因（仅 retired）。 */
  retiredReason?: "rejected" | "aged" | "removed";
}

/** 账簿文件。 */
export interface LedgerFile {
  version: number;
  /** 乐观并发版本号：每次成功写入 +1。 */
  revision: number;
  entries: LedgerEntry[];
  /** 被拒绝 / 撤销 / 退休的归一化 key。 */
  suppressed: string[];
  /** 纠正语境里没有约束句的「未成形观察」计数（只记账，不产出偏好）。 */
  unformed: number;
  updatedAt: number;
}

/** 老化阈值（天）。 */
export interface AgingThresholds {
  dormantDays: number;
  retireDays: number;
}

/** 老化计划（纯计算，由调用方落状态与删行）。 */
export interface AgingPlan {
  dormant: LedgerEntry[];
  retired: LedgerEntry[];
}

/** 空账簿。 */
export function emptyLedger(now = 0): LedgerFile {
  return {
    version: LEDGER_VERSION,
    revision: 0,
    entries: [],
    suppressed: [],
    unformed: 0,
    updatedAt: now,
  };
}

/** 账簿落点：`<dshHome>/preference-analysis/ledger.json`。 */
export function ledgerPathFor(dshHome: string): string {
  return join(dshHome, LEDGER_DIR, LEDGER_FILE);
}

/** 复制账簿（写入前改副本，失败不留半改状态）。 */
export function cloneLedger(ledger: LedgerFile): LedgerFile {
  return structuredClone(ledger);
}

/** 释放后仍可读的会话 id 记录：去重 + 上限 + 保持最近者。 */
export function touchSession(
  entry: LedgerEntry,
  sessionId: string,
  max = MAX_SESSIONS_PER_ENTRY,
): void {
  if (sessionId.length === 0) return;
  const index = entry.sessions.indexOf(sessionId);
  if (index >= 0) entry.sessions.splice(index, 1);
  entry.sessions.push(sessionId);
  if (entry.sessions.length > max)
    entry.sessions.splice(0, entry.sessions.length - max);
}

/** 记一个抑制键（去重 + 上限，超出丢最早者）。 */
export function addSuppressed(
  ledger: LedgerFile,
  key: string,
  max = MAX_SUPPRESSED,
): void {
  if (key.length === 0) return;
  const index = ledger.suppressed.indexOf(key);
  if (index >= 0) ledger.suppressed.splice(index, 1);
  ledger.suppressed.push(key);
  if (ledger.suppressed.length > max)
    ledger.suppressed.splice(0, ledger.suppressed.length - max);
}

/**
 * 老化计划：`lastSeen` 超 `dormantDays` 的候选 / 生效条目转休眠；超 `retireDays` 的
 * 候选 / 生效 / 休眠条目转退休。`observe` 条目不动 —— 它们只是计数，不注入也无库行。
 */
export function planAging(
  ledger: LedgerFile,
  nowMs: number,
  thresholds: AgingThresholds,
): AgingPlan {
  const day = 86_400_000;
  const plan: AgingPlan = { dormant: [], retired: [] };
  for (const entry of ledger.entries) {
    if (entry.status === "retired") continue;
    const idleDays = (nowMs - entry.lastSeen) / day;
    if (
      idleDays >= thresholds.retireDays &&
      (entry.status === "candidate" ||
        entry.status === "active" ||
        entry.status === "dormant")
    ) {
      plan.retired.push(entry);
      continue;
    }
    if (
      idleDays >= thresholds.dormantDays &&
      (entry.status === "candidate" || entry.status === "active")
    ) {
      plan.dormant.push(entry);
    }
  }
  return plan;
}

/** 账簿并发写冲突（磁盘 revision 与内存不一致）。 */
export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

/** 账簿版本不受支持：拒载拒写，避免覆盖更新版本的数据。 */
export class LedgerReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerReadOnlyError";
  }
}

/** 解析结果。 */
type ParseOutcome =
  | { ok: true; ledger: LedgerFile }
  | { ok: false; reason: "corrupt"; detail: string }
  | { ok: false; reason: "version"; version: number };

/** 账簿存储：串行化写入 + 版本守卫 + 原子替换。 */
export class LedgerStore {
  readonly path: string;
  readonly #now: () => number;
  #cache: LedgerFile | undefined;
  #readOnly = false;
  #warnings: string[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    dshHome: string,
    options: { path?: string; now?: () => number } = {},
  ) {
    this.path = options.path ?? ledgerPathFor(dshHome);
    this.#now = options.now ?? Date.now;
  }

  /** 载入过程的告警（坏文件留档 / 版本不符等）。 */
  get warnings(): readonly string[] {
    return this.#warnings;
  }

  /** 版本不受支持时进入只读态（拒写）。 */
  get readOnly(): boolean {
    return this.#readOnly;
  }

  /** 最近一次载入 / 写入的账簿快照（注入判定只读这一份，保证 `decide` 廉价）。 */
  snapshot(): LedgerFile {
    return this.#cache ?? emptyLedger(this.#now());
  }

  /** 同步载入一次（启动期建立注入快照）；读失败 / 坏文件 / 版本不符都降级为空账簿。 */
  loadSync(): LedgerFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        this.#warnings.push(`账簿读取失败：${describe(error)}`);
      }
      return (this.#cache = emptyLedger(this.#now()));
    }
    const parsed = parseLedger(raw);
    if (parsed.ok) return (this.#cache = parsed.ledger);
    if (parsed.reason === "version") {
      this.#readOnly = true;
      this.#warnings.push(
        `账簿版本 ${parsed.version} 不受支持（期望 ${LEDGER_VERSION}）：拒绝载入与写入`,
      );
      return (this.#cache = emptyLedger(this.#now()));
    }
    // 损坏：不在这里改名（同步路径保持无副作用），下一次写入前会改名留档。
    this.#warnings.push(
      `账簿文件无法解析（${parsed.detail}）：本次按空账簿运行，写入前会改名留档`,
    );
    return (this.#cache = emptyLedger(this.#now()));
  }

  /** 异步载入（与 `loadSync` 同口径，但会执行坏文件留档）。 */
  async load(): Promise<LedgerFile> {
    return this.#enqueue(async () => {
      const ledger = await this.#readFromDisk();
      return (this.#cache = ledger ?? emptyLedger(this.#now()));
    });
  }

  /**
   * 串行变更：读盘校验 revision -> 改副本 -> 原子写。`mutate` 可异步（如先写 memory-base）。
   * 冲突 / 只读 / 内部失败都会抛错，调用方负责把证据放回缓冲重试。
   */
  async update(
    mutate: (draft: LedgerFile) => void | Promise<void>,
  ): Promise<LedgerFile> {
    return this.#enqueue(async () => {
      if (this.#readOnly) {
        throw new LedgerReadOnlyError(
          `账簿版本不受支持，拒绝写入：${this.path}`,
        );
      }
      const disk = await this.#readFromDisk();
      const base = disk ?? emptyLedger(this.#now());
      const expected = this.#cache?.revision ?? base.revision;
      if (base.revision !== expected) {
        throw new LedgerConflictError(
          `账簿已被其他进程修改（磁盘 revision ${base.revision}，内存 ${expected}）`,
        );
      }
      const draft = cloneLedger(base);
      await mutate(draft);
      draft.entries = pruneEntries(draft.entries);
      draft.revision = base.revision + 1;
      draft.updatedAt = this.#now();
      await writeLedger(this.path, draft);
      return (this.#cache = draft);
    });
  }

  /** 串行队列：前一次失败不阻塞后续任务。 */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 读盘并做损坏留档；文件不存在返回 null。 */
  async #readFromDisk(): Promise<LedgerFile | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    const parsed = parseLedger(raw);
    if (parsed.ok) return parsed.ledger;
    if (parsed.reason === "version") {
      this.#readOnly = true;
      this.#warnings.push(
        `账簿版本 ${parsed.version} 不受支持（期望 ${LEDGER_VERSION}）：拒绝写入`,
      );
      throw new LedgerReadOnlyError(
        `账簿版本 ${parsed.version} 不受支持（期望 ${LEDGER_VERSION}）`,
      );
    }
    const backup = `${this.path}.corrupt-${this.#now()}`;
    await rename(this.path, backup);
    this.#warnings.push(`账簿文件无法解析，已改名为 ${backup} 并从空账簿开始`);
    return null;
  }
}

/** 原子写：临时文件（0600）-> rename；目录 0700。 */
export async function writeLedger(
  path: string,
  ledger: LedgerFile,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await bestEffortChmod(dir, 0o700);
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await bestEffortChmod(tmp, 0o600);
  try {
    await rename(tmp, path);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw error;
  }
}

/** 权限收紧是纵深防御，不是功能前提：失败只忽略。 */
async function bestEffortChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // 某些文件系统不支持 chmod（或已被外部收紧）
  }
}

/** 超出上限时优先淘汰退休 / 观察中、且最久未见的条目。 */
function pruneEntries(entries: LedgerEntry[]): LedgerEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;
  const rank = (status: LedgerStatus): number =>
    status === "retired" ? 0 : status === "observe" ? 1 : 2;
  const order = [...entries].sort(
    (a, b) => rank(a.status) - rank(b.status) || a.lastSeen - b.lastSeen,
  );
  const drop = new Set(
    order.slice(0, entries.length - MAX_ENTRIES).map((entry) => entry.id),
  );
  return entries.filter((entry) => !drop.has(entry.id));
}

/** 解析账簿文本：严格校验版本，条目级畸形字段按缺省收敛。 */
function parseLedger(raw: string): ParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: "corrupt", detail: describe(error) };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: "corrupt", detail: "顶层不是对象" };
  }
  const version = value["version"];
  if (typeof version === "number" && version !== LEDGER_VERSION) {
    return { ok: false, reason: "version", version };
  }
  if (version !== LEDGER_VERSION) {
    return { ok: false, reason: "corrupt", detail: "缺少 version" };
  }
  const ledger = emptyLedger(number(value["updatedAt"], 0));
  ledger.revision = nonNegativeInt(value["revision"], 0);
  ledger.unformed = nonNegativeInt(value["unformed"], 0);
  const entries = value["entries"];
  if (Array.isArray(entries)) {
    for (const item of entries) {
      const entry = coerceEntry(item);
      if (entry !== null) ledger.entries.push(entry);
    }
  }
  const suppressed = value["suppressed"];
  if (Array.isArray(suppressed)) {
    for (const item of suppressed) {
      if (typeof item === "string" && item.length > 0)
        addSuppressed(ledger, item);
    }
  }
  return { ok: true, ledger };
}

const STATUSES: ReadonlySet<string> = new Set([
  "observe",
  "candidate",
  "active",
  "dormant",
  "retired",
]);
const ORIGINS: ReadonlySet<string> = new Set(["user", "approval", "model"]);
const RETIRE_REASONS: ReadonlySet<string> = new Set([
  "rejected",
  "aged",
  "removed",
]);

function coerceEntry(value: unknown): LedgerEntry | null {
  if (!isRecord(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"] : "";
  const key = typeof value["key"] === "string" ? value["key"] : "";
  const text = typeof value["text"] === "string" ? value["text"] : "";
  if (id.length === 0 || key.length === 0 || text.length === 0) return null;
  const statusValue = value["status"];
  const status =
    typeof statusValue === "string" && STATUSES.has(statusValue)
      ? (statusValue as LedgerStatus)
      : "observe";
  const originValue = value["origin"];
  const origin =
    typeof originValue === "string" && ORIGINS.has(originValue)
      ? (originValue as LedgerEntry["origin"])
      : "user";
  const entry: LedgerEntry = {
    id,
    key,
    text,
    status,
    evidence: number(value["evidence"], 0),
    sessions: [],
    origin,
    project: typeof value["project"] === "string" ? value["project"] : "",
    importance: clampImportance(value["importance"]),
    firstSeen: number(value["firstSeen"], 0),
    lastSeen: number(value["lastSeen"], 0),
  };
  const title = value["title"];
  if (typeof title === "string" && title.length > 0) entry.title = title;
  const activatedAt = value["activatedAt"];
  if (typeof activatedAt === "number" && Number.isFinite(activatedAt))
    entry.activatedAt = activatedAt;
  const reason = value["retiredReason"];
  if (typeof reason === "string" && RETIRE_REASONS.has(reason))
    entry.retiredReason = reason as NonNullable<LedgerEntry["retiredReason"]>;
  const sessions = value["sessions"];
  if (Array.isArray(sessions)) {
    for (const item of sessions) {
      if (typeof item === "string" && item.length > 0)
        touchSession(entry, item);
    }
  }
  const memory = coerceMemoryRef(value["memory"]);
  if (memory !== null) entry.memory = memory;
  return entry;
}

function coerceMemoryRef(value: unknown): LedgerMemoryRef | null {
  if (!isRecord(value)) return null;
  const scope = value["scope"];
  const tier = value["tier"];
  const id = value["id"];
  if (scope !== "induction" && scope !== "explicit") return null;
  if (tier !== "project" && tier !== "user") return null;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  return { scope, tier, id };
}

function clampImportance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return fallback;
  return Math.floor(value);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
