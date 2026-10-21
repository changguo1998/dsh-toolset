/**
 * auto-approve 的类型面：宿主契约的结构化子集 + 本插件的公开口径。
 *
 * 只声明本插件真正用到的成员（宿主 cordis 是 dsh 仓 workspace 包，未发布 npm），
 * 与 `security-guard` / `output-compress` 同款策略：不 import 宿主类型。
 */

/** 审批裁定词表（与宿主 `ApprovalOutcome` 一致）。 */
export type ApprovalOutcome =
  "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** 生效模式（`off` 等价 `enabled: false`）。 */
export type AutoApproveMode = "off" | "rules" | "rules+llm" | "all";

/** 裁定来源（审计行的 `source`）。 */
export type DecisionSource =
  "rule" | "fingerprint" | "readonly" | "upgrade" | "llm";

/** 指纹 / 形态条目的来源：`decision` = 本插件裁定的，`manual` = 从人工面板放行学来的。 */
export type FormSource = "decision" | "manual";

/** 一次判定的结果。`next` = 不裁定（交下一位应答者 / 原路径）。 */
export type GateOutcome = "allowed-once" | "rejected" | "next";

/** 判定结果（判定核心的唯一输出；gate 与应答者共用）。 */
export interface Decision {
  outcome: GateOutcome;
  /** 裁定来源；`next` 时不填。 */
  source?: DecisionSource;
  /** 命中的规则 id（人工填写的 `id`，或合成的 `readonly:<tool>` / `upgrade:<n>`）。 */
  ruleId?: string;
  /** LLM 审查段的风险档（仅 `source: "llm"`）。 */
  risk?: RiskLevel;
  /** LLM 审查段的裁定（仅 `source: "llm"`）。 */
  reviewerDecision?: "allow" | "deny";
  /** LLM 审查段实际使用的模型（仅 `source: "llm"`）。 */
  reviewerModel?: string;
  /** 失败兜底路径（仅失败时）：`panel` = 交人工 / 原路径；`reject` = 直接拒。 */
  fallback?: "panel" | "reject";
  /** 拒绝时给模型看的理由（人类拒绝同款文案形态）。 */
  reason?: string;
}

/** LLM 审查段的风险档（沿用官方三档定义）。 */
export type RiskLevel = "low" | "medium" | "high";

/** 一次工具调用的快照（`callId → 参数` 表与审批应答共用）。 */
export interface CallInfo {
  callId: string;
  name: string;
  /** 解析后的参数（解析失败时保留原始字符串）。 */
  arguments: unknown;
  sessionId?: string;
  agentId?: string;
  /** 会话 cwd（路径解析用；取自 `request/header` 或 `agent.options`）。 */
  cwd?: string;
  /** 该调用是否带 `sandbox_permissions` 升级意图（`pre-execute` 侧可见）。 */
  escalationTarget?: string;
}

/** 审批请求（宿主 `ApprovalRequestEvent` 的结构化子集）。 */
export interface ApprovalRequestLike {
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
  agent?: unknown;
}

/** 审批应答者签名（waterfall：返回即裁定，`next()` 交下一位）。 */
export type ApprovalAnswerer = (
  req: ApprovalRequestLike,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>;

/** 工具执行对象（宿主 `tools/pre-execute` 的结构化子集）。 */
export interface PreExecuteExecution {
  name: string;
  arguments: unknown;
  callId?: string;
  agent?: unknown;
  signal?: AbortSignal;
}

/** 宿主 `PreToolDecision` 的结构化子集（本插件只产出 `allow` / `deny`）。 */
export type PreToolDecision =
  { kind: "allow" } | { kind: "deny"; reason: string };

/** 审计行（会话 JSONL 与 memory-base `project` 层同形）。 */
export interface AuditLine {
  /** ISO 时间戳。 */
  t: string;
  sessionId: string;
  agentId?: string;
  callId?: string;
  toolName: string;
  outcome: ApprovalOutcome;
  source: DecisionSource;
  ruleId?: string;
  risk?: RiskLevel;
  reviewerDecision?: "allow" | "deny";
  reviewerModel?: string;
  fallback?: "panel" | "reject";
  mode: AutoApproveMode;
  /** 等价调用的指纹（sha256 前 16 位）；不记参数原文。 */
  fingerprintHash?: string;
}

/** 审计健康度（`status()` 的降级标记）。 */
export interface AuditHealth {
  /** 会话那份是否可用；`false` = 已降级（退回人工面板 + 一次警告）。 */
  sessionWritable: boolean;
  /** 降级原因（服务缺失 / 目录不可写 / 截断失败）。 */
  degradedReason?: string;
  /** 当前会话审计文件路径（不可用时省略）。 */
  sessionFilePath?: string;
  /** 项目那份（memory-base）是否可用。 */
  projectWritable: boolean;
  /** 项目那份被跳过的行数。 */
  projectSkipped: number;
  /** 会话那份的行数（进程内计数，含截断前）。 */
  sessionLines: number;
  /** 会话那份是否发生过 16 MiB 截断。 */
  truncated: boolean;
}

/** `/autoapprove status` 与 `provide("autoApprove").status()` 的输出。 */
export interface AutoApproveStatus {
  enabled: boolean;
  /** 当前运行态模式（可能已被 `/autoapprove mode` 改过）。 */
  mode: AutoApproveMode;
  /** 配置文件的模式（重启后回落值）。 */
  configuredMode: AutoApproveMode;
  /** LLM 审查段是否开启（`review.enabled` 且模式含 llm）。 */
  llmEnabled: boolean;
  /** LLM 审查段的静态路由标记：`session` = 跟随当前会话模型；`<provider>/<model>` = 配置覆盖。 */
  llmRoute: string;
  /** 只读类工具数 / 白名单条目数 / 拒绝名单条目数 / 升级白名单条目数。 */
  readonlyTools: number;
  allowRules: number;
  denyRules: number;
  upgradeRules: number;
  /** 本会话指纹条目数。 */
  fingerprints: number;
  /** 学来的形态条目总数（全部会话）。 */
  forms: number;
  /** 学习层是否启用（配置总开关 + 运行态 `learn on/off`）。 */
  learnEnabled: boolean;
  /** 审计健康度。 */
  audit: AuditHealth;
}

/** 指纹视图（`provide("autoApprove").fingerprints()`）。 */
export interface FingerprintView {
  sessionId: string;
  fingerprintHash: string;
  toolName: string;
  /** 首次批准时间（ISO）。 */
  approvedAt: string;
  /** `decision` = 本插件裁定入表；`manual` = 从人工面板放行学来。 */
  source: FormSource;
}

/** 形态视图（`provide("autoApprove").forms()` 与 `/autoapprove learn list`）。 */
export interface FormView {
  sessionId: string;
  /** 形态 id（sha256 前 16 位；`learn undo` 用）。 */
  formHash: string;
  /** 段形态（值位已抹成占位）。 */
  form: string;
  toolName: string;
  source: FormSource;
  /** 学到的形态绑定的沙箱升级目标模式（非升级请求省略）。 */
  target?: string;
  /** 首次入表时间（ISO）。 */
  approvedAt: string;
}

/** 服务面（`provide("autoApprove")`）：只读查询 + 运行态模式切换。 */
export interface AutoApproveService {
  status(): AutoApproveStatus;
  recent(n?: number): readonly AuditLine[];
  fingerprints(): readonly FingerprintView[];
  /** 学来的形态（缺省全部会话；新→旧不保证）。 */
  forms(sessionId?: string): readonly FormView[];
  /** 运行态切换模式（`off` 等价关闭）；只影响当前进程。 */
  setMode(mode: AutoApproveMode): void;
}

/** 宿主 ctx 的结构化子集（只声明本插件用到的成员）。 */
export interface PluginHost {
  on(event: string, listener: (...args: never[]) => unknown): unknown;
  get?(name: string): unknown;
  provide?(name: string, value: unknown): unknown;
  logger?(namespace: string): { info(message: string): void };
}

/** 服务读取（优先 `ctx.get`，其次直接成员；与 command-template 的 `readService` 同构）。 */
export function readService<T>(host: unknown, key: string): T | undefined {
  if (host === null || typeof host !== "object") return undefined;
  const record = host as Record<string, unknown>;
  const get = record["get"];
  if (typeof get === "function") {
    try {
      const value = (get as (name: string) => unknown).call(host, key);
      if (value !== undefined && value !== null) return value as T;
    } catch {
      // get 抛错时回落直接成员读取
    }
  }
  const direct = record[key];
  return direct === undefined || direct === null ? undefined : (direct as T);
}
