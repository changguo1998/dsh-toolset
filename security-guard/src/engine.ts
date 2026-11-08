/**
 * 判定层: `GuardEngine` (纯判定, 不做宿主 I/O) 与判定记录 / 策略快照 / 服务面类型.
 * 对外面只经 `security-guard/src/index.ts` 统一 re-export.
 */
import { isCommandAllowed, matchCommand } from "./blacklist.ts";
import {
  checkSensitivePath,
  extractCommandPaths,
  extractPatchPaths,
  normalizePath,
} from "./sensitive.ts";
import {
  asStringRecord,
  firstString,
  pluginCommands,
  pluginFilePaths,
  scanUnknownToolArgs,
  unknownToolSensitiveKeys,
} from "./arg-scan.ts";
import {
  resolveGuardConfig,
  unknownToolAllowed,
  type ResolvedConfig,
  type SecurityGuardConfig,
} from "./config.ts";
import {
  formatCommandReceipt,
  formatPluginCommandSource,
  formatSensitiveReceipt,
  formatUnknownToolCommandSource,
  formatUnknownToolPathSource,
  formatUnknownToolReceipt,
  formatUnknownToolTruncatedReceipt,
  receiptLabelLine,
} from "./receipt.ts";
import {
  FILE_PATH_KEYS,
  FILE_TOOLS,
  MAX_WALK_DEPTH,
  MAX_WALK_NODES,
  pluginCommandTool,
  pluginFileTool,
  RUN_CODE_TOOLS,
  SHELL_TOOLS,
  toolOperation,
} from "./tool-registry.ts";

/** 一次判定的审计记录（recent() 返回，新在前）。 */
export interface GuardRecord {
  /**
   * 工具名**或**来源标注：常规判定记工具名（`bash` / `md_logic replace` …）；
   * 外部命令复查（`inspectCommand(command, source)`）记 `source`（如 `metric_loop{tick} id=x`）。
   */
  toolName: string;
  /** 判定结果：放行 / 拦截。 */
  verdict: "allow" | "deny";
  /** deny 时的完整回执（含原因 + 放行方式）。 */
  reason?: string;
  /** 判定时刻（epoch 毫秒）。 */
  time: number;
}

/** 当前策略/规则快照（policy() 返回，供 TUI /guard 展示）。 */
export interface PolicySnapshot {
  enabled: boolean;
  /** 未登记工具策略：配置原始值 / 生效值 / 是否非法（非法按 "allow" 生效并告警一次）。 */
  unknownToolPolicy: {
    /** 配置里写的原始值（未归一化；非法值原样展示，如 `true` / `"Deny"`）。 */
    value: unknown;
    /** 实际生效的策略。 */
    effective: "allow" | "check" | "deny";
    /** 原始值非法（非 undefined / 三值之一）→ 已按 "allow" 生效。 */
    invalid: boolean;
  };
  /** 未登记工具放行名单（工具名精确或 `*` 结尾前缀通配）。 */
  unknownToolAllowlist: readonly string[];
  commandBlacklist: {
    enabled: boolean;
    /** 规则 id + 人话原因（不含正则/谓词实现细节）。 */
    rules: readonly { id: string; reason: string }[];
    /** 放行正则源（按配置顺序）。 */
    allowPatterns: readonly string[];
  };
  sensitiveFiles: {
    enabled: boolean;
    rules: readonly { id: string; reason: string }[];
    allowedPaths: readonly { id: string; reason: string }[];
  };
}

/**
 * guard 服务面（`apply` 里 `provide("guard")` → 宿主 `ctx.get('guard')`）：
 * 只读查询（TUI /guard） + 外部命令复查（插件自查，如 metric-loop 的 tick）。
 */
export interface GuardService {
  /**
   * 最近判定记录（新→旧）。记录里的 `toolName` = **工具名或来源标注**
   * （语义见 `GuardRecord.toolName`）：外部命令复查 `inspectCommand` 记的是 `source`，不是工具名。
   */
  recent(): readonly GuardRecord[];
  /**
   * 当前策略/规则快照（开关 / 未登记工具策略 / 规则 id+原因 / 放行正则源）。
   * 这是**策略面**视图，不含逐次判定的工具名/来源标注（那在 `recent()` 里）。
   */
  policy(): PolicySnapshot;
  /**
   * 复查一条**不在工具入参里**的命令文本（与 shell 工具同口径：命令黑名单层 +
   * 命令内路径的敏感文件层）。返回 null = 放行；字符串 = deny 回执。
   * `source` 标注命令来源（回执首行 + 敏感层标签行「来源：<source>」 + `recent()` 的 `toolName`）。
   */
  inspectCommand(command: string, source?: string): string | null;
}

/** 记录缓冲上限（有界，超出丢弃最旧）。 */
const MAX_RECORDS = 200;

/** 核心引擎：纯判定，不做任何宿主 I/O（可独立单测）。 */
export class GuardEngine {
  #cfg: ResolvedConfig;
  #records: GuardRecord[] = [];
  /** 未登记工具的参数扫描失败（畸形参数）是否已告警（只告警一次，避免被刷屏）。 */
  #unknownToolScanWarned = false;
  /** 未登记工具的参数面超出遍历上限（截断 → 保守拦）是否已告警（只告警一次）。 */
  #unknownToolTruncationWarned = false;

  constructor(config: SecurityGuardConfig = {}) {
    this.#cfg = resolveGuardConfig(config);
  }

  /**
   * 检查一次工具调用（判定记入缓冲时 `toolName` 就是**本次工具名**）。
   * 返回 null = 放行；返回字符串 = deny 回执（含原因 + 放行方式）。
   * 检查顺序：命令黑名单层 → 敏感文件层（两层独立、独立放行）。
   * 每次判定都会记入缓冲（recent() 可查），不改变判定逻辑与返回值。
   */
  inspect(toolName: string, rawArguments: unknown): string | null {
    const receipt = this.#decide(toolName, rawArguments);
    this.#record(toolName, receipt);
    return receipt;
  }

  /**
   * 最近判定记录（新→旧），返回副本，外部修改不影响内部缓冲。
   * 记录里的 `toolName` = 工具名**或**来源标注（见 `GuardRecord.toolName`）。
   */
  recent(): readonly GuardRecord[] {
    return [...this.#records].reverse();
  }

  /** 当前策略/规则快照（enabled、未登记工具策略、规则 id+原因、放行正则源）。 */
  policy(): PolicySnapshot {
    const cfg = this.#cfg;
    return {
      enabled: cfg.enabled,
      unknownToolPolicy: {
        value: cfg.unknownToolPolicyRaw,
        effective: cfg.unknownToolPolicy,
        invalid: cfg.unknownToolPolicyInvalid,
      },
      unknownToolAllowlist: [...cfg.unknownToolAllowlist],
      commandBlacklist: {
        enabled: cfg.commandBlacklist.enabled,
        rules: cfg.commandBlacklist.rules.map((r) => ({
          id: r.id,
          reason: r.reason,
        })),
        allowPatterns: cfg.commandBlacklist.allowPatterns.map(
          (re) => re.source,
        ),
      },
      sensitiveFiles: {
        enabled: cfg.sensitiveFiles.enabled,
        rules: cfg.sensitiveFiles.rules.map((r) => ({
          id: r.id,
          reason: r.reason,
        })),
        allowedPaths: cfg.sensitiveFiles.allowedPaths.map((r) => ({
          id: r.id,
          reason: r.reason,
        })),
      },
    };
  }

  #record(toolName: string, receipt: string | null): void {
    this.#records.push({
      toolName,
      verdict: receipt === null ? "allow" : "deny",
      ...(receipt !== null ? { reason: receipt } : {}),
      time: Date.now(),
    });
    // ponytail: 单数组先进先出上限缓冲；需要按工具/时间筛选时再升级
    if (this.#records.length > MAX_RECORDS) this.#records.shift();
  }

  #decide(toolName: string, rawArguments: unknown): string | null {
    const cfg = this.#cfg;
    if (!cfg.enabled) return null;
    const args = asStringRecord(rawArguments);
    // 待过命令黑名单层的命令文本（sourceLine = 插件命令工具的来源标注行）
    const commands: {
      text: string;
      sourceLine?: string;
      kind?: "shell" | "code";
    }[] = [];
    const paths: string[] = [];
    if (SHELL_TOOLS.has(toolName)) {
      // shell 工具：命令文本过黑名单层；文本中的路径 + workdir 过敏感文件层
      const commandText = firstString(args, ["command", "script"]);
      if (commandText !== undefined) {
        commands.push({ text: commandText });
        paths.push(...extractCommandPaths(commandText));
      }
      const workdir = firstString(args, ["workdir"]);
      if (workdir !== undefined) paths.push(workdir);
    } else if (RUN_CODE_TOOLS.has(toolName)) {
      // run_code：代码文本整体过黑名单层（其子分发工具调用会再走一遍管线）
      const codeText = firstString(args, ["code", "program"]);
      if (codeText !== undefined)
        commands.push({ text: codeText, kind: "code" });
    } else if (FILE_TOOLS.has(toolName)) {
      // 内置文件工具：路径参数过敏感文件层
      if (toolName === "apply_patch") {
        // 补丁工具的参数面只有整段补丁文本（路径写在 `*** Add / Update / Delete File:`
        // 与 `*** Move to:` 标记行里），故走文本解析而不是 FILE_PATH_KEYS；
        // 解析不出标记时路径集为空 → 敏感文件层无事可做（边界见 README「覆盖边界」）
        const patchText = firstString(args, ["input"]);
        if (patchText !== undefined)
          paths.push(...extractPatchPaths(patchText));
      } else {
        for (const key of FILE_PATH_KEYS) {
          const v = args[key];
          if (typeof v === "string" && v.length > 0) paths.push(v);
        }
      }
    } else {
      const plugin = pluginFileTool(toolName);
      const commandTool = pluginCommandTool(toolName);
      // 未登记工具：先过放行名单（命中即无条件放行），再按 unknownToolPolicy 三态判定
      if (plugin === undefined && commandTool === undefined) {
        // 未登记工具的键面/值面扫描对**模型给的任意 JSON** 做递归：结构可能畸形（超深数组 / 环 /
        // 枚举即抛错的 Proxy 等）。任何异常一律 fail-open（告警一次 + 按放行处理，与「guard 缺失」
        // 同口径），绝不让 inspect 抛到宿主 listener —— 否则一个畸形参数就能把 pre-execute 打崩。
        try {
          if (unknownToolAllowed(toolName, cfg.unknownToolAllowlistRules)) {
            return null;
          }
          if (cfg.unknownToolPolicy === "allow") return null;
          if (cfg.unknownToolPolicy === "deny") {
            // deny：整工具拦「携带潜在路径/命令参数」的未登记工具（键名启发：
            // walkUnknownToolArgs 深度递归出**完整键路径**，键深上限 UNKNOWN_TOOL_KEY_DEPTH = 3 层，
            // 键名小写归一；回执按路径展示，便于定位嵌套位置）
            const scanned = unknownToolSensitiveKeys(args);
            if (scanned.paths.length > 0) {
              return formatUnknownToolReceipt(toolName, scanned.paths);
            }
            // 资源上限截断：键没查完 ≠ 没查到 → 保守拦（宁可误拦不可漏拦）
            return scanned.truncated
              ? formatUnknownToolTruncatedReceipt(toolName)
              : null;
          }
          // check：不整工具硬拦，把 watched 键下的字符串值按语义派发到既有两层
          return this.#checkUnknownTool(toolName, args);
        } catch (error) {
          this.#warnUnknownToolScanFailure(toolName, error);
          return null;
        }
      }
      // 插件文件工具（登记表）：按各自 pathKeys / pathArrayKeys 提取路径，
      // 与官方文件工具同一路径解析与敏感文件层口径
      if (plugin !== undefined) paths.push(...pluginFilePaths(args, plugin));
      // 插件命令工具（登记表）：按 commandKeys / commandPaths 提取命令文本，
      // 与 shell 工具同一命令黑名单层 + 路径抽取口径（同登记文件表时两套都走，互不覆盖）
      if (commandTool !== undefined) {
        for (const c of pluginCommands(args, commandTool)) {
          commands.push({
            text: c.text,
            sourceLine: formatPluginCommandSource(toolName, c.keyPath),
          });
          paths.push(...extractCommandPaths(c.text));
        }
      }
    }
    return this.#decideCollected(toolName, args, commands, paths);
  }

  /**
   * 未登记工具的参数扫描失败（畸形参数：超深结构、抛错的 Proxy 等）：
   * `console.warn` **一次**（不随调用重复，避免刷屏）+ 按**放行**处理 —— fail-open 口径与
   * 「guard 缺失」一致（安全策略层不该把可用性一起赔进去），且绝不让异常抛到宿主 listener。
   */
  #warnUnknownToolScanFailure(toolName: string, error: unknown): void {
    if (this.#unknownToolScanWarned) return;
    this.#unknownToolScanWarned = true;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[security-guard] 未登记工具「${toolName}」的参数扫描失败（${detail}），已按放行处理` +
        "（fail-open；本次会话只告警一次）。",
    );
  }

  /**
   * 参数面超出遍历资源上限（超深 / 超大）：`console.warn` **一次** + **按拦处理**。
   * 「截断」不是放行理由 —— 查不完就保守拦（宁可误拦不可漏拦），与 deny 口径一致。
   */
  #warnUnknownToolScanTruncated(toolName: string): void {
    if (this.#unknownToolTruncationWarned) return;
    this.#unknownToolTruncationWarned = true;
    console.warn(
      `[security-guard] 未登记工具「${toolName}」的参数面超出遍历上限` +
        `（${MAX_WALK_NODES} 个容器节点 / ${MAX_WALK_DEPTH} 层嵌套），已按保守口径拦截` +
        "（fail-closed；本次会话只告警一次）。",
    );
  }

  /**
   * `unknownToolPolicy: "check"`：未登记工具**不整工具硬拦**——把携带的 watched 键下的字符串值
   * （含数组元素）**按键类定向**派发：命令键（`command` / `measureCmd` / `cmd`）→ 命令黑名单层
   * （`commandBlacklist.allowPatterns` 可放行）；路径键与值面绝对路径（`cwd:` 前缀 / `/`、`~/`）→
   * 敏感文件层（`sensitiveFiles.allowedPaths` 可放行）；代码键（`script` / `code` / `program`）只做
   * 路径提取后过敏感文件层、**不整段送命令层**。命中才拦（标准回执前置一行来源标注，标注里的参数
   * 用**完整键路径**，如 `children[].acceptance[].command`），否则放行；
   * 参数面被资源上限**截断**时按保守口径处置：告警一次 + 拦（绝不静默放行）。
   */
  #checkUnknownTool(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    const scan = scanUnknownToolArgs(args);
    const collected = scan.commands.length + scan.paths.length;
    if (collected === 0) {
      if (!scan.truncated) return null;
      this.#warnUnknownToolScanTruncated(toolName);
      return formatUnknownToolTruncatedReceipt(toolName);
    }
    const decided = this.#decideCollected(
      toolName,
      args,
      scan.commands.map((c) => ({
        text: c.text,
        sourceLine: formatUnknownToolCommandSource(toolName, c.keyPath),
      })),
      scan.paths.map((p) => ({
        path: p.path,
        sourceLine: formatUnknownToolPathSource(toolName, p.keyPath),
      })),
      // 未登记工具的操作面未知：敏感层按读写两面标注（与 shell 命令同款措辞）
      "read-write",
    );
    // 已收集值均未命中，但遍历未完成（截断）→ 不得静默放行（保守拦）
    if (decided === null && scan.truncated) {
      this.#warnUnknownToolScanTruncated(toolName);
      return formatUnknownToolTruncatedReceipt(toolName, collected);
    }
    return decided;
  }

  /**
   * 复查一条**不在工具入参里**的命令文本——给「命令来自状态文件 / 契约」这类旁路补执行前检查点
   * （调用方：metric-loop 的 tick 执行 `spec.measureCmd` 前；task-engine 的 executor / 验收执行期）。
   * 与 shell 工具同一口径：命令黑名单层 + 命令内路径的敏感文件层（`allowPatterns` / `allowedPaths`
   * 同样生效）；判定同样记入 `recent()` —— 记录的 `toolName` 存的是**来源标注** `source`
   * （如 `metric_loop{tick} id=x`；字段语义见 `GuardRecord.toolName`）。
   * 回执首行是来源标注；敏感层命中的标签行渲染为「来源：<source>」（D3，不再借「工具：」字段）。
   * 返回 null = 放行；字符串 = deny 回执。
   */
  inspectCommand(command: string, source = "external-command"): string | null {
    // 防御：服务面经跨包结构调用，非字符串按「无命令」处理（类型由调用方保证）
    if (typeof command !== "string") return null;
    const label =
      typeof source === "string" && source.length > 0
        ? source
        : "external-command";
    const receipt = this.#decideCollected(
      label,
      { command },
      [
        {
          text: command,
          sourceLine: `[security-guard] 命令复查来源：${label}。`,
        },
      ],
      extractCommandPaths(command),
      // 命令面读写都可能（与 shell 工具同款措辞），避免误标成「读取」
      "read-write",
      // 标签行用「来源：」形态：这条命令不来自工具入参，写「工具：」会误导
      "source",
    );
    this.#record(label, receipt);
    return receipt;
  }

  /**
   * 「命令文本 + 路径」收集完成后的最终判定：命令黑名单层 → 敏感文件层（两层独立、独立放行）。
   * 官方 shell 工具、插件命令工具、`check` 模式的未登记工具与 `inspectCommand`（外部命令复查）
   * 共用同一口径；`sourceLine` 非空时前置一行来源标注（回执首行）；
   * `operation` 缺省按工具/参数推导（命令面为 read-write），供外部复查标注操作面；
   * `labelKind` 决定敏感层回执的标签行：「工具：」（缺省）还是「来源：」（外部复查）。
   */
  #decideCollected(
    toolName: string,
    args: Record<string, unknown>,
    commands: readonly {
      text: string;
      sourceLine?: string;
      /** `shell`（缺省）= 命令文本；`code` = 代码文本（命令位规则退化为整段判定）。 */
      kind?: "shell" | "code";
    }[],
    paths: readonly (string | { path: string; sourceLine?: string })[],
    operation?: "read" | "write" | "read-write",
    labelKind: "tool" | "source" = "tool",
  ): string | null {
    const cfg = this.#cfg;
    if (!cfg.enabled) return null;
    // 命令黑名单层（allowPatterns 仅放开本层）：逐条命令文本同一口径判定
    if (cfg.commandBlacklist.enabled) {
      for (const c of commands) {
        if (isCommandAllowed(c.text, cfg.commandBlacklist.allowPatterns)) {
          continue;
        }
        const hit = matchCommand(
          c.text,
          cfg.commandBlacklist.rules,
          c.kind ?? "shell",
        );
        if (hit !== null) {
          const receipt = formatCommandReceipt(hit);
          return c.sourceLine === undefined
            ? receipt
            : `${c.sourceLine}\n${receipt}`;
        }
      }
    }
    // 敏感文件层（allowedPaths 仅放开本层）
    if (cfg.sensitiveFiles.enabled) {
      for (const entry of paths) {
        const candidate = typeof entry === "string" ? { path: entry } : entry;
        const norm = normalizePath(candidate.path, cfg.home);
        if (cfg.sensitiveFiles.allowedPaths.some((r) => r.matchPath(norm)))
          continue;
        const hit = checkSensitivePath(
          candidate.path,
          cfg.sensitiveFiles.rules,
          cfg.home,
        );
        if (hit !== null) {
          const receipt = formatSensitiveReceipt(
            hit,
            receiptLabelLine(toolName, args, labelKind),
            operation ?? toolOperation(toolName, args),
          );
          return candidate.sourceLine === undefined
            ? receipt
            : `${candidate.sourceLine}\n${receipt}`;
        }
      }
    }
    return null;
  }
}
