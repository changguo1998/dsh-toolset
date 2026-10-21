/**
 * 配置归一（`Config` → `ResolvedConfig`）：非法值一律**回落缺省**并记一条诊断，不抛错
 * —— 与 `security-guard` 的「非法按保守处理」不同，本插件的保守 = 「不自动批」（回落人工面板），
 * 因此丢弃非法规则是安全方向，不需要把整条判定变成拒绝。
 *
 * 缺省值（R6 裁定）：`enabled: true`、`mode: "rules"`、四张名单全空（只读类除外，它有内置清单）。
 */

import type { AutoApproveMode } from "./types.ts";

/** 只读类工具的缺省清单（按工具名即可判定，不含 `bash`——其只读性在文本层面不可靠）。 */
export const DEFAULT_READONLY_TOOLS: readonly string[] = [
  "read",
  "read_image",
  "grep",
  "glob",
  "hash_read",
  "fs_digest",
  "code_map",
  "ast_query",
  "md_map",
];

/** 缺省不参与自动裁定的工具（`run_code` 是传输层，内层调用已各自单独判一次）。 */
export const DEFAULT_BYPASS_TOOLS: readonly string[] = ["run_code"];

/** 一条「命令正则 + 允许的目标模式」规则。 */
export interface CommandRuleConfig {
  /** 规则 id（审计行的 `ruleId`；省略时按序合成）。 */
  id?: string;
  /** 命令正则（源串，大小写敏感）。 */
  match: string;
  /** 允许升到的沙箱模式；省略 = 该命令不允许升级（只能用于非升级请求）。 */
  to?: readonly string[];
  /** 适用工具名（缺省 `bash` / `pwsh` / `shell`）。 */
  tools?: readonly string[];
}

/** 一条「路径正则 + 允许的目标模式」规则。 */
export interface PathRuleConfig {
  id?: string;
  /** 路径正则（源串，匹配归一化后的绝对路径）。 */
  path: string;
  to?: readonly string[];
  /** 适用工具名（缺省全部文件读写工具）。 */
  tools?: readonly string[];
}

/** 沙箱升级白名单的总配置。 */
export interface EscalationConfig {
  /** `match`（缺省）= 必须命中 `allow` 规则才放行；`any` = 任何升级都放行（不建议）。 */
  mode?: "match" | "any";
  /** 规则越界时的目标模式兜底（规则自身 `to` 优先）。 */
  to?: readonly string[];
  allow?: readonly (CommandRuleConfig | PathRuleConfig)[];
}

/** 放行白名单（命令 / 路径两张表，按工具名分节）。 */
export interface AllowConfig {
  /** 命令白名单：`{bash: ['^git status\\b'], pwsh: [...]}`。 */
  commands?: Readonly<Record<string, readonly string[]>>;
  /** 路径白名单：`{read: ['^/var/log/'], write: ['^/tmp/']}`。 */
  paths?: Readonly<Record<string, readonly string[]>>;
}

/** 拒绝名单（**只表达「不自动批」**，危险命令与敏感路径归 `security-guard`）。 */
export interface DenyConfig {
  /** 工具名（精确或 `*` 结尾前缀通配）；命中即拒。 */
  tools?: readonly string[];
  /** 升级例外：任何工具升到这些档一律拒（优先于 `escalation.allow`）。 */
  escalation?: { to?: readonly string[] };
  /** 审批请求取不到命令 / 路径原文时的保守闸门（缺省 false = 落人工面板）。 */
  missingArguments?: boolean;
}

/** LLM 审查段配置。 */
export interface ReviewConfig {
  /** 是否启用（缺省 true；只有 `mode: "rules+llm"` 时才会真正调用）。 */
  enabled?: boolean;
  /** 路由覆盖：provider / model 同时给出才生效；缺省跟随当前会话模型。 */
  provider?: string;
  model?: string;
  /** 单次审查超时（毫秒，缺省 10_000）。 */
  timeoutMs?: number;
  /** 允许自动放行的最高风险档（缺省 `medium`；`low` = 只放行 low）。 */
  maxRiskAllow?: RiskLevelName;
  /** 失败兜底：`panel`（缺省，交人工 / 原路径）或 `reject`（直接拒）。 */
  onFailure?: "panel" | "reject";
}

/** 风险档名（与 `RiskLevel` 同值；独立声明避免配置面依赖 types 的循环）。 */
export type RiskLevelName = "low" | "medium" | "high";

/** 学习结果审阅配置（只做准入判断，不参与运行时裁定）。 */
export interface LearnReviewConfig {
  /** 是否启用审阅（缺省 true）；`false` 时按 A / B 直接入表。 */
  enabled?: boolean;
  /** 审阅失败兜底：目前只有 `skip`（不入表，fail-closed）。 */
  onFailure?: "skip";
}

/** 审计配置。 */
export interface AuditConfig {
  /** 项目那份（memory-base）是否启用（缺省 true；有 memory-base 才写）。 */
  project?: boolean;
  /** 会话那份的单文件上限（字节，缺省 16 MiB）。 */
  maxBytes?: number;
}

/** 插件配置（profile 的 `cordis.patch.yml` 该条目下的 `config`；宿主不校验）。 */
export interface Config {
  /** 总开关（缺省 true；显式 false 关闭）。 */
  enabled?: boolean;
  /** 生效模式（缺省 `rules`）。 */
  mode?: AutoApproveMode;
  /** 只读类工具清单（覆盖内置清单；给空数组即关闭该层）。 */
  readonlyTools?: readonly string[];
  /** 不参与自动裁定的工具名（精确或 `*` 前缀通配）。 */
  bypassTools?: readonly string[];
  /** 只审这些工具（非空即白名单；与 `bypassTools` 同时命中时 bypass 优先）。 */
  gateTools?: readonly string[];
  /** 指纹表容量（单会话，缺省 256）。 */
  fingerprintCapacity?: number;
  /** `callId → 参数` 表容量（缺省 256）。 */
  callTableCapacity?: number;
  /** 是否从人工面板放行学习（缺省 true；`false` 即整条学习路径与形态层都不启用）。 */
  learnFromManual?: boolean;
  /** 是否做最小泛化（B 层，缺省 `on`；`off` 只保留逐段精确形态）。 */
  learnGeneralize?: "on" | "off";
  /** 学习结果审阅（缺省开启，失败不入表）。 */
  learnReview?: LearnReviewConfig;
  /** 学习形态表容量（单会话，缺省 256）。 */
  formCapacity?: number;
  /** 「本插件自己裁过」的自记集合容量（缺省 512）。 */
  selfDecidedCapacity?: number;
  /** 自记集合的保留窗口（毫秒，缺省 300000）。 */
  selfDecidedTtlMs?: number;
  /** 是否在首次用到学习层时回读会话历史做回填（缺省 true）。 */
  learnRehydrate?: boolean;
  allow?: AllowConfig;
  deny?: DenyConfig;
  escalation?: EscalationConfig;
  review?: ReviewConfig;
  audit?: AuditConfig;
}

/** 归一化后的沙箱升级规则（已编译正则）。 */
export interface EscalationRule {
  id: string;
  /** 命令正则（与 `path` 二选一）。 */
  command?: RegExp;
  /** 路径正则（与 `command` 二选一）。 */
  path?: RegExp;
  /** 允许的目标模式（缺省取 `EscalationConfig.to`）。 */
  to: readonly string[];
  /** 适用工具（空 = 该规则类型的内置默认集合）。 */
  tools: readonly string[];
}

/** 归一化后的白名单条目。 */
export interface AllowRule {
  id: string;
  tool: string;
  pattern: RegExp;
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  mode: AutoApproveMode;
  readonlyTools: readonly string[];
  bypassTools: readonly string[];
  gateTools: readonly string[];
  fingerprintCapacity: number;
  callTableCapacity: number;
  /** 人工放行学习总开关；`false` 时形态层也不参与判定。 */
  learnFromManual: boolean;
  /** 最小泛化（B 层）开关。 */
  learnGeneralize: boolean;
  learnReview: { enabled: boolean; onFailure: "skip" };
  /** 单会话形态表容量。 */
  formCapacity: number;
  selfDecidedCapacity: number;
  selfDecidedTtlMs: number;
  learnRehydrate: boolean;
  allowCommands: readonly AllowRule[];
  allowPaths: readonly AllowRule[];
  denyTools: readonly string[];
  denyEscalationTo: readonly string[];
  denyMissingArguments: boolean;
  escalationMode: "match" | "any";
  escalationTo: readonly string[];
  escalationRules: readonly EscalationRule[];
  review: {
    enabled: boolean;
    provider?: string;
    model?: string;
    timeoutMs: number;
    maxRiskAllow: RiskLevelName;
    onFailure: "panel" | "reject";
  };
  audit: { project: boolean; maxBytes: number };
  /** 归一过程中的诊断（非法值被回落时各一条）。 */
  diagnostics: readonly string[];
}

/** 缺省审计文件上限：16 MiB。 */
export const DEFAULT_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
/** 缺省 LLM 审查超时：10 s。 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 10_000;
/** 缺省指纹表容量。 */
export const DEFAULT_FINGERPRINT_CAPACITY = 256;
/** 缺省 `callId → 参数` 表容量。 */
export const DEFAULT_CALL_TABLE_CAPACITY = 256;
/** 缺省单会话形态表容量。 */
export const DEFAULT_FORM_CAPACITY = 256;
/** 缺省自记集合容量。 */
export const DEFAULT_SELF_DECIDED_CAPACITY = 512;
/** 缺省自记集合保留窗口：5 min。 */
export const DEFAULT_SELF_DECIDED_TTL_MS = 300_000;
/** 命令类规则的内置适用工具。 */
export const SHELL_TOOLS: readonly string[] = ["bash", "pwsh", "shell"];

const MODES: readonly AutoApproveMode[] = ["off", "rules", "rules+llm", "all"];

function asMode(value: unknown): AutoApproveMode | undefined {
  return typeof value === "string" &&
    (MODES as readonly string[]).includes(value)
    ? (value as AutoApproveMode)
    : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function asPositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/** 带诊断的整数读数（新增学习键用：非法值回落缺省并记一条诊断）。 */
function intWithDiagnostic(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
  diagnostics: string[],
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.floor(value);
    if (rounded >= min && rounded <= max) return rounded;
  }
  diagnostics.push(`${label} 非法（已回落 ${fallback}）：${String(value)}`);
  return fallback;
}

/** 带诊断的布尔读数（只接受 true / false）。 */
function boolWithDiagnostic(
  value: unknown,
  fallback: boolean,
  label: string,
  diagnostics: string[],
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  diagnostics.push(
    `${label} 不是布尔值（已回落 ${fallback}）：${String(value)}`,
  );
  return fallback;
}

function compile(
  source: string,
  label: string,
  diagnostics: string[],
): RegExp | undefined {
  try {
    return new RegExp(source);
  } catch (error) {
    diagnostics.push(`${label} 正则非法（已忽略）：${String(error)}`);
    return undefined;
  }
}

function compileAllowTable(
  table: Readonly<Record<string, readonly string[]>> | undefined,
  layer: "commands" | "paths",
  diagnostics: string[],
): readonly AllowRule[] {
  if (table === undefined || table === null || typeof table !== "object")
    return [];
  const out: AllowRule[] = [];
  for (const [tool, patterns] of Object.entries(table)) {
    const list = asStringArray(patterns);
    if (list === undefined) {
      diagnostics.push(`allow.${layer}.${tool} 不是字符串数组（已忽略）`);
      continue;
    }
    list.forEach((pattern, index) => {
      const compiled = compile(
        pattern,
        `allow.${layer}.${tool}[${index}]`,
        diagnostics,
      );
      if (compiled === undefined) return;
      out.push({
        id: `allow.${layer}:${tool}:${index}`,
        tool,
        pattern: compiled,
      });
    });
  }
  return out;
}

function compileEscalation(
  config: EscalationConfig | undefined,
  diagnostics: string[],
): Pick<ResolvedConfig, "escalationMode" | "escalationTo" | "escalationRules"> {
  const rawRules = Array.isArray(config?.allow) ? config.allow : [];
  const globalTo = asStringArray(config?.to) ?? [];
  const rules: EscalationRule[] = [];
  rawRules.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object") {
      diagnostics.push(`escalation.allow[${index}] 不是对象（已忽略）`);
      return;
    }
    const record = raw as Record<string, unknown>;
    const id =
      typeof record["id"] === "string" && record["id"].length > 0
        ? record["id"]
        : `escalation:${index}`;
    const to = asStringArray(record["to"]) ?? globalTo;
    const tools = asStringArray(record["tools"]) ?? [];
    const commandSource = record["match"];
    const pathSource = record["path"];
    const command =
      typeof commandSource === "string"
        ? compile(
            commandSource,
            `escalation.allow[${index}].match`,
            diagnostics,
          )
        : undefined;
    const path =
      typeof pathSource === "string"
        ? compile(pathSource, `escalation.allow[${index}].path`, diagnostics)
        : undefined;
    if (command === undefined && path === undefined) {
      diagnostics.push(
        `escalation.allow[${index}] 既无 match 也无 path（已忽略）`,
      );
      return;
    }
    if (command !== undefined && path !== undefined) {
      diagnostics.push(
        `escalation.allow[${index}] 同时给了 match 与 path（按 match 生效）`,
      );
    }
    if (to.length === 0) {
      diagnostics.push(
        `escalation.allow[${index}] 没有可允许的目标模式（该规则不会放行任何升级）`,
      );
      return;
    }
    rules.push(
      command !== undefined
        ? { id, command, to, tools }
        : { id, path: path as RegExp, to, tools },
    );
  });
  const mode = config?.mode === "any" ? "any" : "match";
  return {
    escalationMode: mode,
    escalationTo: globalTo,
    escalationRules: rules,
  };
}

/** 归一配置（非法值回退缺省并记诊断；永不抛错）。 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  const diagnostics: string[] = [];
  const raw = config ?? {};
  const modeValue = raw.mode;
  const mode = asMode(modeValue) ?? "rules";
  if (modeValue !== undefined && asMode(modeValue) === undefined) {
    diagnostics.push(`mode 非法（已回落 rules）：${String(modeValue)}`);
  }
  const enabled = raw.enabled !== false;
  const reviewRaw = raw.review ?? {};
  const maxRisk =
    reviewRaw.maxRiskAllow === "low" ||
    reviewRaw.maxRiskAllow === "medium" ||
    reviewRaw.maxRiskAllow === "high"
      ? reviewRaw.maxRiskAllow
      : "medium";
  const provider =
    typeof reviewRaw.provider === "string" && reviewRaw.provider.length > 0
      ? reviewRaw.provider
      : undefined;
  const model =
    typeof reviewRaw.model === "string" && reviewRaw.model.length > 0
      ? reviewRaw.model
      : undefined;
  const auditRaw = raw.audit ?? {};
  const denyRaw = raw.deny ?? {};
  const learnReviewRaw = raw.learnReview ?? {};
  const generalizeRaw = raw.learnGeneralize;
  let learnGeneralize = true;
  if (generalizeRaw !== undefined) {
    if (generalizeRaw === "off") learnGeneralize = false;
    else if (generalizeRaw !== "on") {
      diagnostics.push(
        `learnGeneralize 非法（已回落 on）：${String(generalizeRaw)}`,
      );
    }
  }
  const reviewOnFailure = learnReviewRaw.onFailure;
  if (reviewOnFailure !== undefined && reviewOnFailure !== "skip") {
    diagnostics.push(
      `learnReview.onFailure 非法（已回落 skip）：${String(reviewOnFailure)}`,
    );
  }
  return {
    enabled,
    mode,
    readonlyTools: asStringArray(raw.readonlyTools) ?? DEFAULT_READONLY_TOOLS,
    bypassTools: asStringArray(raw.bypassTools) ?? DEFAULT_BYPASS_TOOLS,
    gateTools: asStringArray(raw.gateTools) ?? [],
    fingerprintCapacity: asPositiveInt(
      raw.fingerprintCapacity,
      DEFAULT_FINGERPRINT_CAPACITY,
      1,
      4096,
    ),
    callTableCapacity: asPositiveInt(
      raw.callTableCapacity,
      DEFAULT_CALL_TABLE_CAPACITY,
      1,
      4096,
    ),
    learnFromManual: boolWithDiagnostic(
      raw.learnFromManual,
      true,
      "learnFromManual",
      diagnostics,
    ),
    learnGeneralize,
    learnReview: {
      enabled: boolWithDiagnostic(
        learnReviewRaw.enabled,
        true,
        "learnReview.enabled",
        diagnostics,
      ),
      onFailure: "skip",
    },
    formCapacity: intWithDiagnostic(
      raw.formCapacity,
      DEFAULT_FORM_CAPACITY,
      1,
      4096,
      "formCapacity",
      diagnostics,
    ),
    selfDecidedCapacity: intWithDiagnostic(
      raw.selfDecidedCapacity,
      DEFAULT_SELF_DECIDED_CAPACITY,
      1,
      4096,
      "selfDecidedCapacity",
      diagnostics,
    ),
    selfDecidedTtlMs: intWithDiagnostic(
      raw.selfDecidedTtlMs,
      DEFAULT_SELF_DECIDED_TTL_MS,
      1000,
      86_400_000,
      "selfDecidedTtlMs",
      diagnostics,
    ),
    learnRehydrate: boolWithDiagnostic(
      raw.learnRehydrate,
      true,
      "learnRehydrate",
      diagnostics,
    ),
    allowCommands: compileAllowTable(
      raw.allow?.commands,
      "commands",
      diagnostics,
    ),
    allowPaths: compileAllowTable(raw.allow?.paths, "paths", diagnostics),
    denyTools: asStringArray(denyRaw.tools) ?? [],
    denyEscalationTo: asStringArray(denyRaw.escalation?.to) ?? [],
    denyMissingArguments: denyRaw.missingArguments === true,
    ...compileEscalation(raw.escalation, diagnostics),
    review: {
      enabled: reviewRaw.enabled !== false,
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      timeoutMs: asPositiveInt(
        reviewRaw.timeoutMs,
        DEFAULT_REVIEW_TIMEOUT_MS,
        100,
        600_000,
      ),
      maxRiskAllow: maxRisk,
      onFailure: reviewRaw.onFailure === "reject" ? "reject" : "panel",
    },
    audit: {
      project: auditRaw.project !== false,
      maxBytes: asPositiveInt(
        auditRaw.maxBytes,
        DEFAULT_AUDIT_MAX_BYTES,
        64 * 1024,
        1024 * 1024 * 1024,
      ),
    },
    diagnostics,
  };
}

/** 是否 LLM 审查段生效（模式含 llm 且 `review.enabled`）。 */
export function reviewActive(config: ResolvedConfig): boolean {
  return config.mode === "rules+llm" && config.review.enabled;
}
