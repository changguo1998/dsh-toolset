/**
 * src/actions.ts — 十个动作的参数校验、argv / 报文拼装与结果解析（库面核心）
 *
 * 通道划分（设计文档决策项 1 的逐动作表）：
 *   CLI：create / list / send_text / send_keys / run / label / info / close
 *        以及 wait 的 `match` / `regex`（服务端 `wait-output` 先搜既有输出再轮询）
 *   socket：read（拿 `revision` / `truncated`）、wait 的 `stable`（靠 `revision` 判稳）
 *
 * 本模块**不碰宿主**：runner / reader / registry / guard 检查器全部经 `DispatchDeps` 注入，
 * 故可完全单测（fake runner + fake reader + 假时钟，不依赖真机 herdr）。
 *
 * 回执口径：错误一律返回结构化失败（`ActionFailure`），**超时不抛错**；
 * herdr 错误信封归一为 `{code, message}`（code 原样透传，如 `pane_not_found` / `timeout`）。
 */

import type { CliRunResult, HerdrRunner, ParsedEnvelope } from "./cli.ts";
import { classifyExit, createDefaultRunner, parseEnvelope } from "./cli.ts";
import { checkOwnership, isOwnedAction } from "./policy.ts";
import type { GuardCheck } from "./policy.ts";
import { closeArgs, renameArgs } from "./registry.ts";
import type { PaneRegistry } from "./registry.ts";
import { waitForStable } from "./socket.ts";
import type { Clock, PaneReader } from "./socket.ts";
import {
  DEFAULT_READ_LINES,
  DEFAULT_SETTLE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  PANE_ACTIONS,
  failure,
  success,
} from "./types.ts";
import type {
  ActionResult,
  HerdrErrorCode,
  HerdrPaneAction,
  ReadFormat,
  ReadSource,
  ResolvedConfig,
} from "./types.ts";

/** 动作派发依赖（全部可注入，生产路径在 `main.ts` 组装）。 */
export interface DispatchDeps {
  /** 归一化配置。 */
  config: ResolvedConfig;
  /** CLI 执行面（生产为 `createDefaultRunner(bin)`）。 */
  runner: HerdrRunner;
  /** socket 读通道（生产为 `createPaneReader`）。 */
  reader: PaneReader;
  /** 归属登记表。 */
  registry: PaneRegistry;
  /** 调用者所在 pane id（`create` 的 `--current` 目标；与 `HERDR_PANE_ID` 一致）。 */
  callerPaneId: string;
  /** 命令复查器（缺省不过复查：注入空实现，便于库面单测）。 */
  guardCheck?: (text: string, action: HerdrPaneAction) => GuardCheck;
  /** 时钟（stable 判稳用；缺省真实时钟）。 */
  clock?: Clock;
}

/** 参数读取：字符串（空串视为未给）。 */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 参数读取：布尔（只认 `true`）。 */
function flag(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

/** 参数读取：正整数（非有限 / 非正 → undefined）。 */
function posInt(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** 参数读取：字符串数组（非数组 / 含非字符串元素 → undefined）。 */
function strList(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== "string" || item === "")) {
    return undefined;
  }
  return value as string[];
}

/** 读来源归一（非法值回退缺省；连字符与下划线两种写法都收）。 */
function readSource(value: unknown): ReadSource {
  if (value === "visible" || value === "recent" || value === "detection") {
    return value;
  }
  if (value === "recent-unwrapped" || value === "recent_unwrapped") {
    return "recent-unwrapped";
  }
  return "recent-unwrapped";
}

/** 读格式归一（缺省 text）。 */
function readFormat(value: unknown): ReadFormat {
  return value === "ansi" ? "ansi" : "text";
}

/**
 * 命令复查的待检文本（guard 复查与 security-guard 登记**同源**的参数面）：
 * `command`（run）/ `text`（send_text）/ `keys`（send_keys，逐键）；
 * 其余动作无命令文本（`label` / `close` / `read` / `info` / `create` / `list`）。
 */
export function inspectedText(
  action: string,
  args: Record<string, unknown>,
): string | undefined {
  if (action === "run") return str(args, "command");
  if (action === "send_text") return str(args, "text");
  if (action === "send_keys") {
    const keys = strList(args, "keys");
    return keys === undefined || keys.length === 0 ? undefined : keys.join(" ");
  }
  return undefined;
}

/**
 * 动作是否要求自有 pane（`wait` 只在 stable 模式要求；其余按 `policy.ts` 的写类集合）。
 * 供 `main.ts` 的审批门在执行前做一次同样的归属判定。
 */
export function needsOwnership(
  action: string,
  args: Record<string, unknown>,
): boolean {
  if (action === "wait") return flag(args, "stable");
  return isOwnedAction(action);
}

/** 目标 pane id（审批门与回执用；无目标动作返回 undefined）。 */
export function paneTargetFor(
  action: string,
  args: Record<string, unknown>,
): string | undefined {
  return str(args, "pane_id");
}

/** herdr CLI 信封 → 统一失败（错误码透传，退出码兜底）。 */
function cliFailure(
  action: HerdrPaneAction,
  paneId: string | undefined,
  envelope: ParsedEnvelope,
  result: CliRunResult,
  timeoutMs: number,
): ActionResult {
  if (result.timedOut) {
    return failure(
      action,
      "herdr-timeout",
      `herdr CLI 超时（${timeoutMs}ms）被终止`,
      {
        ...(paneId === undefined ? {} : { paneId }),
        hint: "长耗时场景用 wait 的 timeout_ms 参数放宽总超时，或把配置 timeoutMs 调大。",
      },
    );
  }
  if (envelope.kind === "error") {
    const code = envelope.error.code;
    const mapped: HerdrErrorCode =
      code === "timeout" ? "timeout" : "herdr-cli-error";
    return failure(action, mapped, `${code}: ${envelope.error.message}`, {
      ...(paneId === undefined ? {} : { paneId }),
      ...(code === "timeout"
        ? {
            hint: "服务端在 timeout_ms 内没等到匹配；可放宽 timeout_ms 或改匹配串。",
          }
        : {}),
    });
  }
  const kind = classifyExit(result.exitCode);
  if (kind === "usage") {
    return failure(
      action,
      "herdr-cli-error",
      `herdr CLI 语法错误（exit 2）：${result.stderr.trim() || "（无 stderr）"}`,
      { ...(paneId === undefined ? {} : { paneId }) },
    );
  }
  return failure(
    action,
    "herdr-cli-error",
    `herdr CLI 失败（exit ${result.exitCode}）：${(result.stderr || result.stdout).trim() || "（无输出）"}`,
    { ...(paneId === undefined ? {} : { paneId }) },
  );
}

/** 成功信封的 `result` 取对象字段（非对象给 undefined）。 */
function resultObject(
  envelope: ParsedEnvelope,
  key: string,
): Record<string, unknown> | undefined {
  if (envelope.kind !== "ok") return undefined;
  const value = envelope.result[key];
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 从 `unknown` 取「对象数组」（非数组给空数组）。
 *
 * 不直接对 `Array.isArray(x) ? x.filter(...) : []` 做收窄：`any[]` 上跑类型谓词会让
 * 三元表达式两边推断不一致（一边 `Record[]`、一边 `never[]`），下游 `.map` 的可调用性
 * 就依赖编译器的具体行为。先落一个 `unknown[]` 再过滤，类型面稳定。
 */
function objectList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const list: unknown[] = value;
  return list.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object",
  );
}

/** `pane list` 摘要（只保留工具回执需要的字段）。 */
export function summarizePane(
  pane: Record<string, unknown>,
  isRegistered: (paneId: string) => boolean,
): Record<string, unknown> {
  const paneId = typeof pane.pane_id === "string" ? pane.pane_id : "";
  const scroll =
    pane.scroll !== null && typeof pane.scroll === "object"
      ? (pane.scroll as Record<string, unknown>)
      : undefined;
  return {
    pane_id: paneId,
    ...(typeof pane.label === "string" ? { label: pane.label } : {}),
    ...(typeof pane.workspace_id === "string"
      ? { workspace_id: pane.workspace_id }
      : {}),
    ...(typeof pane.tab_id === "string" ? { tab_id: pane.tab_id } : {}),
    ...(typeof pane.cwd === "string" ? { cwd: pane.cwd } : {}),
    ...(typeof pane.agent === "string" ? { agent: pane.agent } : {}),
    ...(typeof pane.agent_status === "string"
      ? { agent_status: pane.agent_status }
      : {}),
    focused: pane.focused === true,
    ...(scroll === undefined || typeof scroll.offset_from_bottom !== "number"
      ? {}
      : { scroll_offset: scroll.offset_from_bottom }),
    /** 本插件登记标记（写类动作的前置条件）。 */
    registered: paneId !== "" && isRegistered(paneId),
  };
}

/** 布局探测（`create` 缺方向时按调用者 pane 的宽高自动选 right / down）。 */
async function detectDirection(deps: DispatchDeps): Promise<"right" | "down"> {
  const result = await deps.runner.run(
    ["pane", "layout", "--pane", deps.callerPaneId],
    deps.config.timeoutMs,
  );
  const area = resultObject(
    parseEnvelope(result.stdout, result.stderr),
    "layout",
  );
  const rect =
    area?.area !== null && typeof area?.area === "object"
      ? (area?.area as Record<string, unknown>)
      : undefined;
  const width = typeof rect?.width === "number" ? rect.width : undefined;
  const height = typeof rect?.height === "number" ? rect.height : undefined;
  // 官方技能：宽 pane 向右切、窄 / 高 pane 向下切；探测失败时按「向右」兜底（最常见布局）
  if (width === undefined || height === undefined) return "right";
  return width >= height ? "right" : "down";
}

/** `create`：切一个兄弟 pane（`--current` + `--no-focus` + 显式 cwd），成功后自动打 label。 */
async function createAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const requested = str(args, "direction");
  const direction =
    requested === "right" || requested === "down"
      ? requested
      : await detectDirection(deps);
  const cwd = str(args, "cwd");
  const label = str(args, "label") ?? deps.config.label;
  const commandArgs = [
    "pane",
    "split",
    "--current",
    "--direction",
    direction,
    ...(cwd === undefined ? [] : ["--cwd", cwd]),
    "--no-focus",
  ];
  const result = await deps.runner.run(commandArgs, deps.config.timeoutMs);
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "create",
      undefined,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  const pane = resultObject(envelope, "pane");
  const paneId = typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
  if (paneId === undefined || paneId === "") {
    return failure(
      "create",
      "herdr-bad-response",
      `pane split 成功但取不到新 pane id（期望 .result.pane.pane_id）：${result.stdout.slice(0, 200)}`,
    );
  }
  deps.registry.register({
    paneId,
    label,
    ...(cwd === undefined ? {} : { cwd }),
  });
  // 创建成功后自动打一次 label（崩溃残留可被 list 与人工识别）；失败只记 note，不回滚创建
  const notes: string[] = [];
  const labeled = await deps.runner.run(
    renameArgs(paneId, label),
    deps.config.timeoutMs,
  );
  if (
    labeled.timedOut ||
    parseEnvelope(labeled.stdout, labeled.stderr).kind !== "ok"
  ) {
    notes.push(
      `自动打 label 失败（pane ${paneId} 已创建并登记，仍可显式调 label 动作）：${labeled.stderr.trim() || `exit ${labeled.exitCode}`}`,
    );
  }
  return success(
    "create",
    {
      pane_id: paneId,
      direction,
      label,
      ...(cwd === undefined ? {} : { cwd }),
      ...(typeof pane?.pane_id === "string" ? { created: true } : {}),
    },
    { paneId, ...(notes.length === 0 ? {} : { notes }) },
  );
}

/** `list`：列出 pane 摘要与本插件登记标记。 */
async function listAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const workspace = str(args, "workspace");
  const commandArgs = [
    "pane",
    "list",
    ...(workspace === undefined ? [] : ["--workspace", workspace]),
  ];
  const result = await deps.runner.run(commandArgs, deps.config.timeoutMs);
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "list",
      undefined,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  const panes = objectList(envelope.result.panes).map((item) =>
    summarizePane(item, (id) => deps.registry.has(id)),
  );
  return success("list", {
    panes,
    registered: deps.registry.panes.map((record) => record.paneId),
    ...(workspace === undefined ? {} : { workspace }),
  });
}

/** `read`：走 socket（`revision` / `truncated` 是 socket 独有信息）。 */
async function readAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const paneId = str(args, "pane_id");
  if (paneId === undefined) {
    return failure("read", "pane-required", "read 需要 pane_id 参数");
  }
  if (paneId === deps.callerPaneId) {
    return failure(
      "read",
      "invalid-params",
      `pane_id 不能是调用者自己所在的 pane（${paneId}）：那是 dsh 自己的界面，读它会读到本次调用自身的回显`,
      {
        paneId,
        hint: "用 create 建一个新 pane 后再读，或用 list 选一个自有 pane。",
      },
    );
  }
  const source = readSource(args.source);
  const lines = posInt(args, "lines") ?? DEFAULT_READ_LINES;
  const format = readFormat(args.format);
  const outcome = await deps.reader.readPane({ paneId, source, lines, format });
  if (!outcome.ok) {
    return failure("read", outcome.code, outcome.message, { paneId });
  }
  return success(
    "read",
    {
      pane_id: paneId,
      source,
      format,
      lines,
      text: outcome.read.text,
      ...(outcome.read.revision === undefined
        ? {}
        : { revision: outcome.read.revision }),
      ...(outcome.read.truncated === undefined
        ? {}
        : { truncated: outcome.read.truncated }),
    },
    { paneId },
  );
}

/** `wait`：`match` / `regex` 走 CLI `wait-output`，`stable` 走 socket 判稳。 */
async function waitAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const paneId = str(args, "pane_id");
  if (paneId === undefined) {
    return failure("wait", "pane-required", "wait 需要 pane_id 参数");
  }
  const match = str(args, "match");
  const regex = str(args, "regex");
  const stable = flag(args, "stable");
  if (stable && (match !== undefined || regex !== undefined)) {
    return failure(
      "wait",
      "invalid-params",
      "stable 与 match / regex 互斥：静默判定等「屏内容不再变化」，不叠加匹配条件",
      { paneId },
    );
  }
  if (!stable && match !== undefined && regex !== undefined) {
    return failure(
      "wait",
      "invalid-params",
      "match 与 regex 二选一，不能同时给出",
      {
        paneId,
      },
    );
  }
  if (!stable && match === undefined && regex === undefined) {
    return failure(
      "wait",
      "invalid-params",
      "wait 需要 match / regex / stable 之一：match 等字面量出现，regex 等正则匹配，stable 等屏内容不再变化",
      { paneId },
    );
  }
  const source = readSource(args.source);
  const lines = posInt(args, "lines") ?? DEFAULT_READ_LINES;
  const timeoutMs = posInt(args, "timeout_ms") ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (stable) {
    return waitStableAction(deps, paneId, { source, lines, timeoutMs }, args);
  }
  const commandArgs = [
    "pane",
    "wait-output",
    paneId,
    ...(match === undefined ? ["--regex", regex ?? ""] : ["--match", match]),
    "--source",
    source,
    "--lines",
    String(lines),
    "--timeout",
    String(timeoutMs),
  ];
  // CLI 侧留 5s 余量等进程收尾（服务端到点先返回错误信封，退出码 1）
  const result = await deps.runner.run(commandArgs, timeoutMs + 5000);
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (envelope.kind === "ok") {
    const read = resultObject(envelope, "read");
    const matchedLine =
      typeof envelope.result.matched_line === "string"
        ? envelope.result.matched_line
        : undefined;
    return success(
      "wait",
      {
        pane_id: paneId,
        matched: true,
        stable: false,
        ...(matchedLine === undefined ? {} : { matched_line: matchedLine }),
        ...(read === undefined || typeof read.text !== "string"
          ? {}
          : { text: read.text }),
        ...(read === undefined || typeof read.revision !== "number"
          ? {}
          : { revision: read.revision }),
      },
      { paneId },
    );
  }
  if (result.timedOut) {
    return cliFailure("wait", paneId, envelope, result, timeoutMs + 5000);
  }
  // 服务端超时（错误信封 code=timeout）→ 结构化超时结果，不抛错
  if (envelope.kind === "error" && envelope.error.code === "timeout") {
    return failure(
      "wait",
      "timeout",
      `等待超时（${timeoutMs}ms）：未在 pane 输出里等到${
        match === undefined ? `正则 ${regex ?? ""}` : `字面量 ${match}`
      }`,
      {
        paneId,
        hint: "可放宽 timeout_ms；或用 read 看当前屏内容确认程序是否已起。",
      },
    );
  }
  return cliFailure("wait", paneId, envelope, result, timeoutMs + 5000);
}

/** `wait` 的 stable 分支（socket 判稳；超时返回结构化结果）。 */
async function waitStableAction(
  deps: DispatchDeps,
  paneId: string,
  params: { source: ReadSource; lines: number; timeoutMs: number },
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const settleMs = posInt(args, "settle_ms") ?? DEFAULT_SETTLE_MS;
  const clock = deps.clock;
  const outcome = await waitForStable(
    deps.reader,
    {
      paneId,
      source: params.source,
      lines: params.lines,
      format: "text",
    },
    { settleMs, timeoutMs: params.timeoutMs },
    ...(clock === undefined ? [] : [clock]),
  );
  if (outcome.error !== undefined) {
    return failure("wait", "socket-error", outcome.error, { paneId });
  }
  if (!outcome.stable) {
    return failure(
      "wait",
      "timeout",
      `等待超时（${params.timeoutMs}ms）：屏内容仍在变化，未判稳`,
      {
        paneId,
        hint: "可放宽 timeout_ms / settle_ms；或用 read 直接看当前屏内容。",
      },
    );
  }
  return success(
    "wait",
    {
      pane_id: paneId,
      matched: true,
      stable: true,
      basis: outcome.basis,
      changes: outcome.changes,
      elapsed_ms: outcome.elapsedMs,
      text: outcome.text,
      ...(outcome.revision === undefined ? {} : { revision: outcome.revision }),
    },
    { paneId },
  );
}

/** `send_text`：字面量文本（不追加回车）。 */
async function sendTextAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const paneId = str(args, "pane_id");
  if (paneId === undefined) {
    return failure("send_text", "pane-required", "send_text 需要 pane_id 参数");
  }
  const text = str(args, "text");
  if (text === undefined) {
    return failure("send_text", "invalid-params", "send_text 需要 text 参数", {
      paneId,
    });
  }
  const result = await deps.runner.run(
    ["pane", "send-text", paneId, text],
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "send_text",
      paneId,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  return success(
    "send_text",
    { pane_id: paneId, chars: text.length },
    { paneId },
  );
}

/** `send_keys`：按键序列（如 `["ctrl+c"]` / `["esc"]` / `["up"]`）。 */
async function sendKeysAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const paneId = str(args, "pane_id");
  if (paneId === undefined) {
    return failure("send_keys", "pane-required", "send_keys 需要 pane_id 参数");
  }
  const keys = strList(args, "keys");
  if (keys === undefined || keys.length === 0) {
    return failure(
      "send_keys",
      "invalid-params",
      'send_keys 需要非空的 keys 字符串数组（如 ["ctrl+c"] / ["esc"] / ["up"]）',
      { paneId },
    );
  }
  const result = await deps.runner.run(
    ["pane", "send-keys", paneId, ...keys],
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "send_keys",
      paneId,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  return success("send_keys", { pane_id: paneId, keys }, { paneId });
}

/** `run`：文本 + 回车一次提交。 */
async function runAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const paneId = str(args, "pane_id");
  if (paneId === undefined) {
    return failure("run", "pane-required", "run 需要 pane_id 参数");
  }
  const command = str(args, "command");
  if (command === undefined) {
    return failure("run", "invalid-params", "run 需要 command 参数", {
      paneId,
    });
  }
  const result = await deps.runner.run(
    ["pane", "run", paneId, command],
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure("run", paneId, envelope, result, deps.config.timeoutMs);
  }
  return success("run", { pane_id: paneId, command }, { paneId });
}

/** `label`：打 / 清归属标记（空串 = 清除）。 */
async function labelAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const paneId = str(args, "pane_id");
  if (paneId === undefined) {
    return failure("label", "pane-required", "label 需要 pane_id 参数");
  }
  // 只有显式空串表示清除；未给则写配置缺省 label
  const rawLabel = args.label;
  const label = typeof rawLabel === "string" ? rawLabel : deps.config.label;
  const result = await deps.runner.run(
    renameArgs(paneId, label),
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure("label", paneId, envelope, result, deps.config.timeoutMs);
  }
  const record = deps.registry.get(paneId);
  if (record !== undefined) {
    if (label === "") {
      deps.registry.unregister(paneId);
    } else {
      deps.registry.register({
        paneId,
        label,
        ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
      });
    }
  }
  return success(
    "label",
    { pane_id: paneId, label, cleared: label === "" },
    { paneId },
  );
}

/** `info`：进程探活（`foreground_processes` / `shell_pid`，用于判「命令是否还在跑」）。 */
async function infoAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const paneId = str(args, "pane_id");
  if (paneId === undefined) {
    return failure("info", "pane-required", "info 需要 pane_id 参数");
  }
  const result = await deps.runner.run(
    ["pane", "process-info", "--pane", paneId],
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure("info", paneId, envelope, result, deps.config.timeoutMs);
  }
  const info = resultObject(envelope, "process_info");
  if (info === undefined) {
    return failure(
      "info",
      "herdr-bad-response",
      `process-info 响应缺少 result.process_info：${result.stdout.slice(0, 200)}`,
      { paneId },
    );
  }
  const processes = objectList(info.foreground_processes);
  return success(
    "info",
    {
      pane_id: paneId,
      // 与官方 bash 工具「命令是否还在跑」的判定口径一致：有前台进程 = 在跑
      running: processes.length > 0,
      shell_pid: typeof info.shell_pid === "number" ? info.shell_pid : null,
      foreground_processes: processes.map((process) => ({
        pid: typeof process.pid === "number" ? process.pid : null,
        name: typeof process.name === "string" ? process.name : "",
        cmdline: typeof process.cmdline === "string" ? process.cmdline : "",
        ...(typeof process.cwd === "string" ? { cwd: process.cwd } : {}),
      })),
      ...(typeof info.foreground_process_group_id === "number"
        ? { foreground_process_group_id: info.foreground_process_group_id }
        : {}),
      ...(typeof info.tty === "string" ? { tty: info.tty } : {}),
    },
    { paneId },
  );
}

/** `close`：关闭 pane（只关登记过的；`force` 需配置 `allowForeignPanes`）。 */
async function closeAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const paneId = str(args, "pane_id");
  if (paneId === undefined) {
    return failure("close", "pane-required", "close 需要 pane_id 参数");
  }
  const result = await deps.runner.run(
    closeArgs(paneId),
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure("close", paneId, envelope, result, deps.config.timeoutMs);
  }
  const wasRegistered = deps.registry.has(paneId);
  deps.registry.unregister(paneId);
  return success(
    "close",
    { pane_id: paneId, was_registered: wasRegistered },
    { paneId },
  );
}

/** 动作分派表。 */
const HANDLERS: Record<
  HerdrPaneAction,
  (deps: DispatchDeps, args: Record<string, unknown>) => Promise<ActionResult>
> = {
  create: createAction,
  list: listAction,
  read: readAction,
  wait: waitAction,
  send_text: sendTextAction,
  send_keys: sendKeysAction,
  run: runAction,
  label: labelAction,
  info: infoAction,
  close: closeAction,
};

/**
 * 派发一个动作（**唯一的执行入口**：工具面、真机验证脚本、库面消费者都走它）。
 *
 * 顺序固定：参数面判定（动作名 / pane 归属 / force）→ guard 复查 → 归属登记校验 → 执行。
 * 审批门（闸③）在宿主 `tools/pre-execute` 里、先于本函数触发；本函数再复核一次归属，
 * 是因为库面调用（不经宿主工具链）不该绕开归属限制。
 */
export async function dispatchAction(
  action: string,
  args: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<ActionResult> {
  if (!Object.hasOwn(HANDLERS, action)) {
    return failure(
      "list",
      "unknown-action",
      `未知 action：${String(action)}（可选 ${PANE_ACTIONS.join(" / ")}）`,
    );
  }
  const typedAction = action as HerdrPaneAction;
  const paneId = paneTargetFor(action, args);
  // 归属前置校验：写类 / wait-stable 要求登记过（读类放行）。
  // `allowForeignPanes: true` 是这条限制的**总开关**（决策项 6 的「缺省」出口）：
  // 打开后写类动作可作用于他人的 pane，但审批门（闸③，foreign 档）会先打断一次；
  // `close` 另要求 `force: true`（关闭是破坏性的，多一道显式信号）。
  if (paneId !== undefined && needsOwnership(action, args)) {
    const closeNeedsForce = typedAction === "close" && !flag(args, "force");
    const foreignAllowed = deps.config.allowForeignPanes && !closeNeedsForce;
    if (!foreignAllowed) {
      const verdict = checkOwnership(
        typedAction,
        paneId,
        (id) => deps.registry.has(id),
        { waitStable: flag(args, "stable") },
      );
      if (!verdict.allowed) {
        return failure(
          typedAction,
          "pane-not-registered",
          closeNeedsForce && deps.config.allowForeignPanes
            ? `pane ${paneId} 不是本插件创建的，关闭它需要显式 force: true`
            : `pane ${paneId} 不是本插件创建的，写类动作缺省不作用于它`,
          { paneId, hint: ownershipHintFor(typedAction) },
        );
      }
    }
  }
  // 闸① guard 复查（只看命令文本参数；fail-open 口径见 policy.ts）
  const text = inspectedText(action, args);
  if (text !== undefined && deps.guardCheck !== undefined) {
    const check = deps.guardCheck(text, typedAction);
    if (check.outcome === "deny") {
      return failure(
        typedAction,
        "guard-denied",
        check.receipt === undefined
          ? "被 security-guard 拦截（无回执文本）"
          : check.receipt,
        {
          ...(paneId === undefined ? {} : { paneId }),
          hint: "命令未送达 pane。放行方式见回执里的 security-guard 说明。",
        },
      );
    }
  }
  const handler = HANDLERS[typedAction];
  if (paneId === undefined) {
    return handler(deps, args);
  }
  // 同 pane 串行化：同一 pane 上的建 / 发 / 关按提交顺序执行
  return deps.registry.serialize(paneId, () => handler(deps, args));
}

/** 归属被拒的放行方式（`close` 的 force 与通用写类分开写，避免暗示「设了 force 就能发输入」）。 */
function ownershipHintFor(action: HerdrPaneAction): string {
  if (action === "close") {
    return (
      "放行方式：关非本插件创建的 pane 需同时满足配置 allowForeignPanes: true 与 close 的 force: true" +
      "（审批门仍按 requireApproval 档要求人工确认）。"
    );
  }
  return (
    "放行方式：用 herdr_pane 的 create 建新 pane 后对它操作；" +
    "或把插件配置 allowForeignPanes 置 true 让写类动作可作用于他人的 pane" +
    "（此时审批门按 requireApproval 档先打断一次）。读类动作可读任意 pane。"
  );
}

/** 生产路径的 runner 构造（`main.ts` 用；库面消费者可自备）。 */
export function defaultRunner(binPath: string): HerdrRunner {
  return createDefaultRunner(binPath);
}
