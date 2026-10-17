/**
 * preference-analysis 插件入口（DSH bundle 接入面）。
 *
 * 角色：**观测 + 归纳 + 注入**。
 * - 观测：订阅 `session/event`，抽出重复约束 / 纠正加权 / 审批拒绝三条信号（observe.ts）；
 * - 归纳：统计门槛 + 近似合并 + 置信分档（induce.ts），账簿是唯一状态源（ledger.ts）；
 * - 存储：达高置信且 `autoApply` 允许时写入 memory-base 项目层（apply.ts），撤销 / 退休真删；
 * - 注入：注册一个 rule-engine 消费者，`decide` 只读账簿快照，守条数与字符上限。
 *
 * 降级：memory 服务没有新句柄面 -> 只观察（不产出候选、不写库、不注入），并记一次明确日志；
 * `enabled: false` -> 零观测、零写入、零注入（连消费者与工具都不注册）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  INJECTION_SUMMARY,
  applyEntry,
  createMemoryPort,
  renderInjection,
  retireEntry,
  sensitiveReason,
  type MemoryPort,
} from "./apply.ts";
import {
  DAY_MS,
  DEFAULT_CORRECTION_MARKERS,
  DEFAULT_MARKERS,
  DEFAULT_SIMILARITY,
  evaluate,
  mergeEvidence,
  suppress,
  type ConfidenceThresholds,
} from "./induce.ts";
import {
  LedgerStore,
  ledgerPathFor,
  planAging,
  type AgingThresholds,
  type LedgerEntry,
  type LedgerFile,
} from "./ledger.ts";
import { Observer, type Observation } from "./observe.ts";
import {
  createTools,
  type PreferenceAddInput,
  type PreferenceAddResult,
  type PreferenceListOptions,
  type PreferenceRemoveResult,
  type ToolDef,
} from "./tools.ts";

export const name = "preference-analysis";

/** 硬依赖：分层存储与作用域句柄面（memory-base provide `memory`）。 */
export const inject = ["memory"];

/** 插件配置（类型声明，宿主不校验；缺省见 resolveConfig）。 */
export interface Config {
  /** 是否开启（缺省 `true`；显式 `false` 全关）。 */
  enabled?: boolean;
  /** 自动应用档：`off` 只列建议 / `confident` 高置信才写库（缺省）/ `all` 达候选门槛即写。 */
  autoApply?: "off" | "confident" | "all";
  /** S1 约束标记词（缺省 12 个）。 */
  markers?: readonly string[];
  /** S2 纠正标记词。 */
  correctionMarkers?: readonly string[];
  /** 置信阈值（证据数 / 跨会话数 / 最近证据天数）。 */
  thresholds?: { evidence?: number; sessions?: number; recentDays?: number };
  /** 老化（天）：超休眠线停注入，超退休线删库。 */
  aging?: { dormantDays?: number; retireDays?: number };
  /** 3-gram 相似合并阈值（缺省 0.8）。 */
  similarity?: number;
  /** 注入上限（条数 / 字符）。 */
  inject?: { maxItems?: number; maxChars?: number };
  /** 账簿落点（缺省 `<dshHome>/preference-analysis/ledger.json`）。 */
  ledgerPath?: string;
  /** DSH 家目录（缺省 `DSH_HOME` 或 `~/.dsh`）。 */
  dshHome?: string;
  /** 归纳节流（毫秒，缺省 10 分钟；启动后一次 + `compaction/end` 后一次）。 */
  minIntervalMs?: number;
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  autoApply: "off" | "confident" | "all";
  markers: readonly string[];
  correctionMarkers: readonly string[];
  thresholds: ConfidenceThresholds;
  aging: AgingThresholds;
  similarity: number;
  inject: { maxItems: number; maxChars: number };
  dshHome: string;
  ledgerPath: string;
  minIntervalMs: number;
}

/** 待归纳观测的内存上限（超出丢最早者；正常节流下不会触顶）。 */
export const MAX_PENDING_OBSERVATIONS = 2_000;

/** 缺省归纳节流：10 分钟。 */
export const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;

/** 归一化配置（非法值回退缺省，不抛错）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const dshHome =
    nonEmpty(config?.dshHome) ??
    nonEmpty(process.env["DSH_HOME"]) ??
    join(homedir(), ".dsh");
  return {
    enabled: config?.enabled !== false,
    autoApply:
      config?.autoApply === "off" || config?.autoApply === "all"
        ? config.autoApply
        : "confident",
    markers: stringList(config?.markers, DEFAULT_MARKERS),
    correctionMarkers: stringList(
      config?.correctionMarkers,
      DEFAULT_CORRECTION_MARKERS,
    ),
    thresholds: {
      evidence: positiveInt(config?.thresholds?.evidence, 3),
      sessions: positiveInt(config?.thresholds?.sessions, 2),
      recentDays: positiveInt(config?.thresholds?.recentDays, 30),
    },
    aging: {
      dormantDays: positiveInt(config?.aging?.dormantDays, 90),
      retireDays: positiveInt(config?.aging?.retireDays, 180),
    },
    similarity: ratio(config?.similarity, DEFAULT_SIMILARITY),
    inject: {
      maxItems: positiveInt(config?.inject?.maxItems, 5),
      maxChars: positiveInt(config?.inject?.maxChars, 600),
    },
    dshHome,
    ledgerPath: nonEmpty(config?.ledgerPath) ?? ledgerPathFor(dshHome),
    minIntervalMs: positiveInt(config?.minIntervalMs, DEFAULT_MIN_INTERVAL_MS),
  };
}

/** 一轮归纳的结果（测试与排查用）。 */
export interface ConsolidationReport {
  evidence: number;
  created: number;
  merged: number;
  suppressed: number;
  /** 含敏感片段、连条目都不产出的证据数。 */
  blocked: number;
  unformed: number;
  applied: number;
  dormant: number;
  retired: number;
  conflict?: string;
}

/** 插件实例。 */
export interface PreferencePlugin {
  readonly config: ResolvedConfig;
  readonly store: LedgerStore;
  /** memory 是否提供新句柄面（false = 只观察）。 */
  readonly memoryAvailable: boolean;
  /** 处理一条会话事件（会话面已剥离）。 */
  handle(sessionId: string, project: string, event: unknown): void;
  /** 归纳一轮（串行；重复调用复用同一 promise）。 */
  consolidate(): Promise<ConsolidationReport>;
  /** 账簿快照（注入判定与测试用）。 */
  snapshot(): LedgerFile;
  /** rule-engine 消费者决策：只读快照，返回注入正文或 null。 */
  decide(): { text: string; summary: string } | null;
  /** 模型侧工具的能力面。 */
  api: {
    list(opts?: PreferenceListOptions): Promise<LedgerEntry[]>;
    add(input: PreferenceAddInput): Promise<PreferenceAddResult>;
    remove(id: string): Promise<PreferenceRemoveResult>;
  };
  dispose(): void;
}

/** 创建实例的依赖。 */
export interface PluginDeps {
  ctx?: unknown;
  config?: Config;
  /** 注入时钟（测试推进老化用）。 */
  now?: () => number;
  warn?: (message: string) => void;
}

/** 构造插件实例（不碰宿主事件面；事件与消费者由 `apply` 接）。 */
export function createPlugin(deps: PluginDeps = {}): PreferencePlugin {
  const resolved = resolveConfig(deps.config);
  const now = deps.now ?? Date.now;
  const warn =
    deps.warn ??
    ((message: string) => {
      process.stderr.write(`[preference-analysis] warn: ${message}\n`);
    });
  const store = new LedgerStore(resolved.dshHome, {
    path: resolved.ledgerPath,
    now,
  });
  store.loadSync();
  for (const warning of store.warnings) warn(warning);

  const portResult = createMemoryPort(getService(deps.ctx, "memory"));
  const port: MemoryPort | null = portResult.ok ? portResult.port : null;
  if (!portResult.ok) {
    warn(
      `memory 服务不可用（${portResult.reason}）：本包停在只观察不写入 / 不注入`,
    );
  }

  const observer = new Observer({
    markers: resolved.markers,
    correctionMarkers: resolved.correctionMarkers,
    now,
  });
  const observations: Observation[] = [];
  let disposed = false;
  let lastProject = "";

  const handle = (sessionId: string, project: string, event: unknown): void => {
    if (disposed || !resolved.enabled) return;
    if (project.length > 0) lastProject = project;
    const produced = observer.handle(sessionId, project, event);
    if (produced.length === 0) return;
    observations.push(...produced);
    // 归纳尚未跑（如长会话未触发节流点）时也守住内存上限
    if (observations.length > MAX_PENDING_OBSERVATIONS) {
      observations.splice(0, observations.length - MAX_PENDING_OBSERVATIONS);
    }
  };

  const runConsolidate = async (): Promise<ConsolidationReport> => {
    const drained = observations.splice(0);
    const report: ConsolidationReport = {
      evidence: 0,
      created: 0,
      merged: 0,
      suppressed: 0,
      blocked: 0,
      unformed: 0,
      applied: 0,
      dormant: 0,
      retired: 0,
    };
    // 没有新证据时仍要跑老化；但既无证据又没有写库面时无事可做
    if (drained.length === 0 && port === null) return report;
    try {
      await store.update(async (draft) => {
        const touched = new Set<string>();
        for (const item of drained) {
          if (item.kind === "unformed") {
            draft.unformed += 1;
            report.unformed += 1;
            continue;
          }
          report.evidence += 1;
          // 敏感片段连账簿都不落（D10 a1：账簿不经过库闸门）
          const privacy =
            port !== null
              ? port.checkPrivacy(item.evidence.text)
              : sensitiveReason(item.evidence.text);
          if (privacy !== null) {
            report.blocked += 1;
            continue;
          }
          const outcome = mergeEvidence(draft, item.evidence, {
            similarity: resolved.similarity,
          });
          if (outcome.kind === "created") {
            report.created += 1;
            touched.add(outcome.entry.id);
          } else if (outcome.kind === "merged") {
            report.merged += 1;
            touched.add(outcome.entry.id);
          } else if (outcome.kind === "suppressed") {
            report.suppressed += 1;
          }
        }
        // 没有新句柄面：只落观察，不产出候选、不写库、不注入（「只观察不写入」）
        if (port === null) return;
        // 置信分档 + 自动应用
        for (const entry of draft.entries) {
          if (entry.status === "retired") continue;
          // 模型提议一律留待审（D8 附），不参与自动应用
          if (entry.origin === "model") continue;
          if (entry.status === "dormant" && !touched.has(entry.id)) continue;
          const verdict = evaluate(entry, resolved.thresholds, now());
          entry.importance = verdict.importance;
          if (verdict.tier === "observe") {
            if (entry.status !== "active") entry.status = "observe";
            continue;
          }
          if (entry.status === "active") continue;
          const auto =
            resolved.autoApply === "all" ||
            (resolved.autoApply === "confident" &&
              verdict.tier === "confident");
          if (!auto) {
            entry.status = "candidate";
            continue;
          }
          const applied = await applyEntry(port, entry);
          const id = applied.ids[0];
          if (applied.ok && id !== undefined) {
            entry.status = "active";
            entry.activatedAt = now();
            entry.memory = { scope: "induction", tier: "project", id };
            report.applied += 1;
          } else {
            entry.status = "candidate";
            warn(
              `偏好写入库失败（${entry.id}）：${applied.reason ?? "unknown"}`,
            );
          }
        }
        // 老化：休眠 / 退休（退休要真删库行）
        const plan = planAging(draft, now(), resolved.aging);
        for (const entry of plan.dormant) {
          entry.status = "dormant";
          report.dormant += 1;
        }
        for (const entry of plan.retired) {
          const retired = await retireEntry(port, entry);
          if (!retired.ok) {
            warn(
              `偏好退休删行失败（${entry.id}）：${retired.reason ?? "unknown"}`,
            );
            continue;
          }
          entry.status = "retired";
          entry.retiredReason = "aged";
          suppress(draft, entry.key);
          report.retired += 1;
        }
      });
    } catch (error) {
      // 冲突 / 只读：先重载账簿（刷新 revision），再把证据放回缓冲，下一次再试
      try {
        await store.load();
      } catch {
        // 重载失败留给下一次 consolidate
      }
      observations.unshift(...drained);
      report.conflict = describe(error);
      warn(`归纳落账失败：${report.conflict}`);
    }
    return report;
  };

  let running: Promise<ConsolidationReport> | null = null;
  const consolidate = (): Promise<ConsolidationReport> => {
    if (disposed) {
      return Promise.resolve({
        evidence: 0,
        created: 0,
        merged: 0,
        suppressed: 0,
        blocked: 0,
        unformed: 0,
        applied: 0,
        dormant: 0,
        retired: 0,
      });
    }
    running ??= (async () => {
      // 一轮处理期间新到的证据：连续补跑（上限 3 轮，防止长会话把归纳拖成死循环）
      let last: ConsolidationReport | undefined;
      for (let round = 0; round < 3; round += 1) {
        last = await runConsolidate();
        if (observations.length === 0) break;
      }
      return last!;
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const snapshot = (): LedgerFile => store.snapshot();

  const decide = (): { text: string; summary: string } | null => {
    if (disposed || !resolved.enabled || port === null) return null;
    const active = snapshot().entries.filter(
      (entry) => entry.status === "active",
    );
    const rendered = renderInjection(active, resolved.inject);
    return rendered === null
      ? null
      : { text: rendered.text, summary: INJECTION_SUMMARY };
  };

  const api = {
    async list(opts?: PreferenceListOptions): Promise<LedgerEntry[]> {
      let entries = [...snapshot().entries];
      if (opts?.status !== undefined) {
        entries = entries.filter((entry) => entry.status === opts.status);
      }
      entries.sort((a, b) => b.lastSeen - a.lastSeen);
      const limit = opts?.limit ?? 20;
      return entries.slice(0, Math.max(0, limit));
    },
    async add(input: PreferenceAddInput): Promise<PreferenceAddResult> {
      if (port === null) {
        return { ok: false, reason: "memory 服务不可用（需要分层句柄面）" };
      }
      const text = input.text.trim();
      if (text.length === 0) return { ok: false, reason: "text 不能为空" };
      const privacy = port.checkPrivacy(text);
      if (privacy !== null) return { ok: false, reason: privacy };
      const state: {
        id?: string;
        status?: string;
        reason?: string;
      } = {};
      try {
        await store.update((draft) => {
          const outcome = mergeEvidence(
            draft,
            {
              text,
              weight: 1,
              sessionId: "",
              at: now(),
              origin: "model",
              project: input.project ?? lastProject,
              ...(input.title === undefined ? {} : { title: input.title }),
            },
            { similarity: resolved.similarity },
          );
          if (outcome.kind === "suppressed") {
            state.reason = "该模式已被撤销，不再登记";
            return;
          }
          if (outcome.kind === "invalid") {
            state.reason = "正文无法归一化";
            return;
          }
          // 模型提议一律候选待审（不自动应用）
          if (outcome.entry.status !== "active")
            outcome.entry.status = "candidate";
          state.id = outcome.entry.id;
          state.status = outcome.entry.status;
        });
      } catch (error) {
        return { ok: false, reason: describe(error) };
      }
      if (state.reason !== undefined)
        return { ok: false, reason: state.reason };
      if (state.id === undefined) return { ok: false, reason: "未落账" };
      return {
        ok: true,
        id: state.id,
        ...(state.status === undefined ? {} : { status: state.status }),
      };
    },
    async remove(id: string): Promise<PreferenceRemoveResult> {
      const state: {
        found: boolean;
        removed: number;
        reason?: string;
      } = { found: false, removed: 0 };
      try {
        await store.update(async (draft) => {
          const target = draft.entries.find((entry) => entry.id === id);
          if (target === undefined) return;
          state.found = true;
          if (target.memory !== undefined) {
            if (port === null) {
              state.reason = "memory 服务不可用，无法删库行";
              return;
            }
            const retired = await retireEntry(port, target);
            if (!retired.ok) {
              state.reason = retired.reason ?? "forget 失败";
              return;
            }
            state.removed = retired.removed;
          }
          target.status = "retired";
          target.retiredReason = "removed";
          suppress(draft, target.key);
        });
      } catch (error) {
        return { ok: false, reason: describe(error) };
      }
      if (!state.found) return { ok: false, reason: "not-found" };
      if (state.reason !== undefined)
        return { ok: false, reason: state.reason };
      return { ok: true, removed: state.removed };
    },
  };

  return {
    config: resolved,
    store,
    memoryAvailable: port !== null,
    handle,
    consolidate,
    snapshot,
    decide,
    api,
    dispose() {
      disposed = true;
      observations.length = 0;
    },
  };
}

/** 宿主 context 的结构面（只声明本包用到的成员）。 */
interface HostContext {
  on?: (
    event: string,
    listener: (session: unknown, event: unknown) => void,
  ) => unknown;
  get?: (name: string) => unknown;
  tools?: { register: (def: unknown) => void };
  ruleEngine?: {
    registerConsumer: (input: ConsumerInput) => () => void;
  };
  memory?: unknown;
}

/** rule-engine 消费者注册项（结构面访问，不 import 对方代码）。 */
interface ConsumerInput {
  id: string;
  sources?: readonly string[];
  delivery?: "steer" | "inject" | "followup";
  dedupeInRecord?: number;
  directWrite?: readonly string[];
  decide: () => { text: string; summary?: string } | null;
}

/** 冻结的消费者注册值（设计「实现前冻结的接口」）。 */
export const CONSUMER_REGISTRATION = {
  id: name,
  sources: ["session-start", "compaction", "step-end"],
  delivery: "steer",
  dedupeInRecord: 1,
  directWrite: ["session-start", "compaction"],
} as const;

/**
 * bundle 装配入口：接观测事件、注册消费者与工具、安排启动后一次归纳。
 * 返回 dispose（解绑事件、注销消费者）。
 */
export function apply(ctx: unknown, config?: Config): () => void {
  const resolved = resolveConfig(config);
  const warn = (message: string): void => {
    process.stderr.write(`[preference-analysis] warn: ${message}\n`);
  };
  if (!resolved.enabled) return () => {};
  const plugin = createPlugin({ ctx, config, warn });
  const disposers: Array<() => void> = [];
  const c = (ctx ?? {}) as HostContext;

  let lastRun = 0;
  const schedule = (): void => {
    const at = Date.now();
    if (at - lastRun < resolved.minIntervalMs) return;
    lastRun = at;
    void plugin.consolidate();
  };

  // 观测：会话事件（含 compaction/end 后的归纳节流触发）
  if (typeof c.on === "function") {
    const off = c.on("session/event", (session, event) => {
      plugin.handle(sessionIdOf(session), sessionProjectOf(session), event);
      if (isRecord(event) && event["type"] === "compaction/end") schedule();
    });
    if (typeof off === "function") disposers.push(off as () => void);
  } else {
    warn("ctx.on 不可用：不观测会话事件");
  }

  // 注入：rule-engine 消费者（软依赖；没有新句柄面时不注册，避免注入空转）
  if (plugin.memoryAvailable) {
    const engine = getService(c, "ruleEngine") as
      { registerConsumer?: (input: ConsumerInput) => () => void } | undefined;
    if (engine !== undefined && typeof engine.registerConsumer === "function") {
      try {
        const off = engine.registerConsumer({
          ...CONSUMER_REGISTRATION,
          decide: () => plugin.decide(),
        });
        if (typeof off === "function") disposers.push(off);
      } catch (error) {
        warn(`注册消费者失败：${describe(error)}`);
      }
    } else {
      warn("ctx.ruleEngine 不可用：偏好只记录不注入");
    }
  }

  // 模型侧工具（三项；没有新句柄面时不注册，避免承诺做不到的写入）
  if (plugin.memoryAvailable) {
    const tools = c.tools;
    if (tools !== undefined && typeof tools.register === "function") {
      for (const def of createTools(plugin.api)) {
        try {
          tools.register(def as ToolDef);
        } catch (error) {
          warn(`注册工具 ${def.name} 失败：${describe(error)}`);
        }
      }
    }
  }

  // 启动后一次归纳（进程内节流在 schedule 里）
  schedule();

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 卸载阶段的异常不回流宿主
      }
    }
    plugin.dispose();
  };
}

function getService(ctx: unknown, key: string): unknown {
  if (!isRecord(ctx)) return undefined;
  const direct = ctx[key];
  if (direct !== undefined) return direct;
  const get = ctx["get"];
  if (typeof get === "function") {
    return (get as (name: string) => unknown).call(ctx, key);
  }
  return undefined;
}

function sessionIdOf(session: unknown): string {
  if (!isRecord(session)) return "";
  const id = session["id"];
  return typeof id === "string" ? id : "";
}

function sessionProjectOf(session: unknown): string {
  if (!isRecord(session)) return "";
  const header = session["header"];
  if (isRecord(header)) {
    const cwd = header["cwd"];
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return process.cwd();
}

function stringList(
  value: readonly string[] | undefined,
  fallback: readonly string[],
): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return cleaned.length > 0 ? cleaned : fallback;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function ratio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 老化窗口（天）与推理常量的再导出，供展示层 / 测试复用。 */
export { DAY_MS };
