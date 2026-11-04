/**
 * 配置层: 用户配置 (`SecurityGuardConfig` / `Config`) 与解析后的内部配置 (`ResolvedConfig`).
 * 只做缺省归一与编译, 不做判定; 对外面只经 `security-guard/src/index.ts` 统一 re-export.
 */
import { homedir } from "node:os";
import {
  compileAllowPatterns,
  DEFAULT_COMMAND_RULES,
  type CommandRule,
} from "./blacklist.ts";
import {
  compileSensitiveRules,
  DEFAULT_SENSITIVE_RULES,
  type CompiledSensitiveRule,
  type SensitiveRule,
} from "./sensitive.ts";

/** 用户层配置（profile 的 cordis.patch.yml 在 security-guard 条目下 config 键）。 */
export interface SecurityGuardConfig {
  /** 总开关（默认 true）。 */
  enabled?: boolean;
  /** 家目录展开用（默认 os.homedir()；测试可注入）。 */
  homeDir?: string;
  /** 命令黑名单层（bash/shell/run_code 的命令文本）。 */
  commandBlacklist?: {
    /** 层开关（默认 true）。 */
    enabled?: boolean;
    /** 追加的用户层规则（正则源）；默认规则不可移除，只能追加。 */
    rules?: readonly string[];
    /** 放行正则源：命令文本匹配任一则跳过黑名单层（不放开敏感文件层）。 */
    allowPatterns?: readonly string[];
  };
  /**
   * 未登记工具策略（默认 "allow"）。
   * - `"allow"`：一律放行（历史行为）；
   * - `"check"`：不整工具硬拦，把 watched 键下的字符串值按键类定向过既有两层
   *   （命令键 → 命令黑名单层；路径键与值面绝对路径 → 敏感文件层；代码键
   *   `script` / `code` / `program` 只做路径提取，不整段送命令层），命中才拦；
   * - `"deny"`：整工具拦（仅限「携带潜在路径/命令参数」的未登记工具，键名启发见
   *   unknownToolSensitiveKeys）。
   * 非法值（非以上三值）按 `"allow"` 生效并 `console.warn` 一次，`policy()` 标 `invalid: true`。
   */
  unknownToolPolicy?: "allow" | "check" | "deny";
  /**
   * 未登记工具放行名单（工具名精确匹配；以 `*` 结尾为前缀通配，如 `mcp__*`）。
   * 在三态策略**之前**判定：命中即无条件放行（`deny` 下的显式例外 / MCP 工具名）。
   */
  unknownToolAllowlist?: readonly string[];
  /** 敏感文件层（shell 命令文本中的路径 + 内置文件工具的路径参数）。 */
  sensitiveFiles?: {
    /** 层开关（默认 true）。 */
    enabled?: boolean;
    /** 追加的保护路径条目（字面前缀或 glob，见 sensitive.ts 语义）。 */
    rules?: readonly string[];
    /** 放行的路径（字面前缀或 glob；命中则该路径跳过敏感文件层）。 */
    allowedPaths?: readonly string[];
  };
}

/**
 * Config 契约别名（DSH bundle §0 的 `Config`）：仅类型级导出，不新增运行时 schema——
 * cordis `resolveConfig()` 只在本导出带 `'~standard'` 校验接口时才校验配置，无 schema 即
 * 原样透传，故不改变本包既有的缺省归一化/非法规则保守处理语义（避免 fail-closed 改变行为）。
 */
export type Config = SecurityGuardConfig;

/**
 * 未登记工具放行名单（编译后）：工具名精确匹配 + `*` 结尾前缀通配。
 * 在策略之前判定（`allow` / `check` / `deny` 三态一致）：命中即无条件放行。
 * `"*"` 等价于放行全部未登记工具（前缀为空串）。
 */
export interface UnknownToolAllowlist {
  exact: ReadonlySet<string>;
  prefixes: readonly string[];
}

/** 编译未登记工具放行名单（非字符串 / 空串条目忽略——配置无运行时 schema 校验）。 */
function compileUnknownToolAllowlist(
  list: readonly string[],
): UnknownToolAllowlist {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (name.length === 0) continue;
    if (name.endsWith("*")) prefixes.push(name.slice(0, -1));
    else exact.add(name);
  }
  return { exact, prefixes };
}

/** 未登记工具是否在放行名单内（精确或 `*` 前缀通配）。 */
export function unknownToolAllowed(
  toolName: string,
  list: UnknownToolAllowlist,
): boolean {
  return (
    list.exact.has(toolName) ||
    list.prefixes.some((prefix) => toolName.startsWith(prefix))
  );
}

/** 解析后的内部配置（编译后，构造一次）。 */
export interface ResolvedConfig {
  /** 未登记工具策略（**生效值**；非法值按 "allow" 生效）。 */
  unknownToolPolicy: "allow" | "check" | "deny";
  /** 配置里的原始值（policy() 展示；非法值原样保留）。 */
  unknownToolPolicyRaw: unknown;
  /** 原始值非法（非 undefined / "allow" / "check" / "deny"）。 */
  unknownToolPolicyInvalid: boolean;
  /** 未登记工具放行名单（原始配置，policy() 展示）。 */
  unknownToolAllowlist: readonly string[];
  /** 未登记工具放行名单（编译后，判定用）。 */
  unknownToolAllowlistRules: UnknownToolAllowlist;
  enabled: boolean;
  home: string;
  commandBlacklist: {
    enabled: boolean;
    rules: readonly CommandRule[];
    allowPatterns: readonly RegExp[];
  };
  sensitiveFiles: {
    enabled: boolean;
    rules: readonly CompiledSensitiveRule[];
    allowedPaths: readonly CompiledSensitiveRule[];
  };
}

/** 解析用户配置为编译后的内部配置（默认值 + 用户层合并）。 */
export function resolveGuardConfig(
  config: SecurityGuardConfig,
): ResolvedConfig {
  const home = config.homeDir ?? homedir();
  // 命令黑名单：默认规则 + 用户追加（id 稳定，便于回执定位）
  const userCommandRules: CommandRule[] = (
    config.commandBlacklist?.rules ?? []
  ).map((pattern, i) => ({
    id: `user-rule-${i + 1}`,
    reason: `命中用户层自定义黑名单规则 #${i + 1}`,
    pattern,
  }));
  const commandRules = [...DEFAULT_COMMAND_RULES, ...userCommandRules];
  // 敏感文件：默认清单 + 用户追加（追加条目 id 为 user-path-N）
  const userPathRules: SensitiveRule[] = (
    config.sensitiveFiles?.rules ?? []
  ).map((path, i) => ({
    id: `user-path-${i + 1}`,
    path,
    reason: `命中用户层自定义保护路径 #${i + 1}`,
  }));
  const sensitiveRules = compileSensitiveRules(
    [...DEFAULT_SENSITIVE_RULES, ...userPathRules],
    home,
  );
  // 放行清单：与保护清单同一匹配语义（字面前缀 / glob）
  const allowedRules: CompiledSensitiveRule[] = compileSensitiveRules(
    (config.sensitiveFiles?.allowedPaths ?? []).map((path, i) => ({
      id: `allowed-${i + 1}`,
      path,
      reason: "用户层放行路径",
    })),
    home,
  );
  // 未登记工具策略：缺省 allow；非法值按 allow 生效（fail-open 语义不变），但告警一次并标 invalid
  const rawPolicy: unknown = config.unknownToolPolicy;
  const policyInvalid =
    rawPolicy !== undefined &&
    rawPolicy !== "allow" &&
    rawPolicy !== "check" &&
    rawPolicy !== "deny";
  if (policyInvalid) {
    console.warn(
      `[security-guard] 非法配置 unknownToolPolicy=${JSON.stringify(rawPolicy)}，已按 "allow" 生效` +
        '（可选值："allow" | "check" | "deny"）；policy() 快照标记 invalid=true。',
    );
  }
  const effectivePolicy: "allow" | "check" | "deny" =
    rawPolicy === "check" || rawPolicy === "deny" ? rawPolicy : "allow";
  const allowlist = [...(config.unknownToolAllowlist ?? [])];
  return {
    unknownToolPolicy: effectivePolicy,
    unknownToolPolicyRaw: rawPolicy,
    unknownToolPolicyInvalid: policyInvalid,
    unknownToolAllowlist: allowlist,
    unknownToolAllowlistRules: compileUnknownToolAllowlist(allowlist),
    enabled: config.enabled ?? true,
    home,
    commandBlacklist: {
      enabled: config.commandBlacklist?.enabled ?? true,
      rules: commandRules,
      allowPatterns: compileAllowPatterns(
        config.commandBlacklist?.allowPatterns ?? [],
      ),
    },
    sensitiveFiles: {
      enabled: config.sensitiveFiles?.enabled ?? true,
      rules: sensitiveRules,
      allowedPaths: allowedRules,
    },
  };
}
