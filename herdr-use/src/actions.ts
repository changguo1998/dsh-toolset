/**
 * src/actions.ts — 十个动作的参数校验、argv / 报文拼装与结果解析（库面核心）
 *
 * 通道划分：
 *   CLI：create / list / close / label / text / key / run / info，以及 wait 的 `match` / `regex`
 *   socket：read（拿 `revision` / `truncated`）、wait 的 `stable`（靠 `revision` 判稳）
 *
 * 终端单层（2026-10-23）：一个终端 = 一个 tab + 自带 root pane；`terminal_id` 即 root pane id。
 * 所有带 `terminal_id` 的动作只接受**已登记**终端；`list` / `create` 走本会话 workspace。
 * 工具面不出现 pane / tab / workspace 概念，于是也没有外来对象、force、审批档。
 *
 * lane：foreground 继承父会话 herdr session；background 的每条命令前置 `--session dshbg`。
 *
 * 本模块**不碰宿主**：runner / reader / registry / guard / 会话解析全部经 `DispatchDeps` 注入，
 * 故可完全单测（fake runner + fake reader + 假时钟，不依赖真机 herdr）。
 */

import type { CliRunResult, HerdrRunner, ParsedEnvelope } from "./cli.ts";
import { classifyExit, createDefaultRunner, parseEnvelope } from "./cli.ts";
import type { GuardCheck } from "./policy.ts";
import {
  paneRenameArgs,
  tabCloseArgs,
  tabRenameArgs,
  TerminalRegistry,
} from "./registry.ts";
import { waitForStable } from "./socket.ts";
import type { Clock, PaneReader } from "./socket.ts";
import {
  ALL_ACTIONS,
  DEFAULT_READ_LINES,
  DEFAULT_SETTLE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  failure,
  success,
} from "./types.ts";
import type {
  ActionResult,
  HerdrErrorCode,
  HerdrUseAction,
  Lane,
  ReadFormat,
  ReadSource,
  ResolvedConfig,
  TerminalRecord,
} from "./types.ts";
import {
  ensureWorkspace,
  laneRunner,
  readSessionContext,
} from "./workspace.ts";
import type { SessionContext, SessionResolver } from "./workspace.ts";

/** 动作派发依赖（全部可注入，生产路径在 `main.ts` 组装）。 */
export interface DispatchDeps {
  /** 归一化配置。 */
  config: ResolvedConfig;
  /** CLI 执行面（生产为 `createDefaultRunner(bin)`；lane 前缀由动作层加）。 */
  runner: HerdrRunner;
  /** 按 lane 取 socket 读通道（生产为同一连接器、不同 socket 路径）。 */
  readerFor: (lane: Lane) => PaneReader | Promise<PaneReader>;
  /** 终端登记表。 */
  registry: TerminalRegistry;
  /** 调用者所在 pane id（同 pane 读护栏；不在 herdr 内时 undefined）。 */
  callerPaneId?: string;
  /** 调用者所在 tab id（`herdr_close` 的防御性护栏；不在 herdr 内时 undefined）。 */
  callerTabId?: string;
  /** 会话解析器（缺省从 `context` 读：工具 exec / `{ session }` / `{ id, cwd }` 三种形态）。 */
  resolveSession?: SessionResolver;
  /** 命令复查器（缺省不过复查：注入空实现，便于库面单测）。 */
  guardCheck?: (text: string, action: HerdrUseAction) => GuardCheck;
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
 * `run.command` / `text.text` / `key.keys` 逐键；其余动作无命令文本。
 */
export function inspectedText(
  action: string,
  args: Record<string, unknown>,
): string | undefined {
  if (action === "run") return str(args, "command");
  if (action === "text") return str(args, "text");
  if (action === "key") {
    const keys = strList(args, "keys");
    return keys === undefined || keys.length === 0 ? undefined : keys.join(" ");
  }
  return undefined;
}

/** 从上下文解析会话（缺省 `readSessionContext`；单测可注入固定会话）。 */
function sessionOf(
  deps: DispatchDeps,
  context: unknown,
): SessionContext | undefined {
  return deps.resolveSession === undefined
    ? readSessionContext(context)
    : deps.resolveSession(context);
}

/** 会话缺失的统一失败。 */
function sessionFailure(action: HerdrUseAction): ActionResult {
  return failure(
    action,
    "session-unavailable",
    "拿不到调用方的 dsh 会话：工具调用需经宿主 exec，服务面请传 exec / { session: { id, cwd } } / { id, cwd }",
    {
      hint: "服务面消费方把自己会话对象作为末参传入；不要在插件内部猜会话。",
    },
  );
}

/** herdr CLI 信封 → 统一失败（错误码透传，退出码兜底）。 */
function cliFailure(
  action: HerdrUseAction,
  terminalId: string | undefined,
  envelope: ParsedEnvelope,
  result: CliRunResult,
  timeoutMs: number,
): ActionResult {
  const extra = terminalId === undefined ? {} : { terminalId };
  if (result.timedOut) {
    return failure(
      action,
      "herdr-timeout",
      `herdr CLI 超时（${timeoutMs}ms）被终止`,
      {
        ...extra,
        hint: "长耗时场景用 herdr_wait 的 timeout_ms 参数放宽总超时，或把配置 timeoutMs 调大。",
      },
    );
  }
  if (envelope.kind === "error") {
    const code = envelope.error.code;
    const mapped: HerdrErrorCode =
      code === "timeout" ? "timeout" : "herdr-cli-error";
    return failure(action, mapped, `${code}: ${envelope.error.message}`, {
      ...extra,
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
      extra,
    );
  }
  return failure(
    action,
    "herdr-cli-error",
    `herdr CLI 失败（exit ${result.exitCode}）：${
      (result.stderr || result.stdout).trim() || "（无输出）"
    }`,
    extra,
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

/** 从 `unknown` 取「对象数组」（非数组给空数组）。 */
function objectList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const list: unknown[] = value;
  return list.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object",
  );
}

/** 终端查找（集中处理 required / ambiguous / not-registered）。 */
type TargetResult =
  { ok: true; record: TerminalRecord } | { ok: false; result: ActionResult };

function targetOf(
  deps: DispatchDeps,
  action: HerdrUseAction,
  args: Record<string, unknown>,
): TargetResult {
  const terminalId = str(args, "terminal_id");
  if (terminalId === undefined) {
    return {
      ok: false,
      result: failure(action, "terminal-required", "缺少 terminal_id 参数"),
    };
  }
  const lookup = deps.registry.find(terminalId);
  if (lookup.ambiguous === true) {
    return {
      ok: false,
      result: failure(
        action,
        "ambiguous-terminal",
        `terminal_id ${terminalId} 在两个 lane 里各有一条登记`,
        {
          terminalId,
          hint: "用 herdr_list 重取带 foreground 标记的终端条目后再操作。",
        },
      ),
    };
  }
  if (lookup.record === undefined) {
    return {
      ok: false,
      result: failure(
        action,
        "terminal-not-registered",
        `terminal ${terminalId} 不是本插件登记的终端`,
        {
          terminalId,
          hint: "用 herdr_create 建新终端；herdr_list 里 registered: false 的残留终端需人工在 herdr 里关闭。",
        },
      ),
    };
  }
  return { ok: true, record: lookup.record };
}

/** `herdr_list`：汇总两个 lane 的绑定 workspace，逐条标 foreground / registered。 */
async function listAction(
  deps: DispatchDeps,
  _args: Record<string, unknown>,
  context: unknown,
): Promise<ActionResult> {
  const session = sessionOf(deps, context);
  if (session === undefined) return sessionFailure("list");
  const rows: Record<string, unknown>[] = [];
  for (const lane of ["foreground", "background"] as const) {
    const binding = deps.registry.getBinding(session.id, lane);
    if (binding === undefined) continue;
    const runner = laneRunner(deps.runner, lane);
    const tabsResult = await runner.run(
      ["tab", "list", "--workspace", binding.workspaceId],
      deps.config.timeoutMs,
    );
    const tabsEnvelope = parseEnvelope(
      tabsResult.stdout,
      tabsResult.stderr,
      tabsResult.exitCode,
    );
    if (tabsResult.timedOut || tabsEnvelope.kind !== "ok") {
      return cliFailure(
        "list",
        undefined,
        tabsEnvelope,
        tabsResult,
        deps.config.timeoutMs,
      );
    }
    const panesResult = await runner.run(
      ["pane", "list", "--workspace", binding.workspaceId],
      deps.config.timeoutMs,
    );
    const panesEnvelope = parseEnvelope(
      panesResult.stdout,
      panesResult.stderr,
      panesResult.exitCode,
    );
    if (panesResult.timedOut || panesEnvelope.kind !== "ok") {
      return cliFailure(
        "list",
        undefined,
        panesEnvelope,
        panesResult,
        deps.config.timeoutMs,
      );
    }
    const panesByTab = new Map<string, Record<string, unknown>[]>();
    for (const pane of objectList(panesEnvelope.result.panes)) {
      const tabId = typeof pane.tab_id === "string" ? pane.tab_id : "";
      if (tabId === "") continue;
      const list = panesByTab.get(tabId) ?? [];
      list.push(pane);
      panesByTab.set(tabId, list);
    }
    for (const tab of objectList(tabsEnvelope.result.tabs)) {
      const tabId = typeof tab.tab_id === "string" ? tab.tab_id : "";
      if (tabId === "") continue;
      const registered = deps.registry.terminals.find(
        (record) => record.tabId === tabId && record.lane === lane,
      );
      const panes = panesByTab.get(tabId) ?? [];
      const firstPane = panes.find(
        (pane) => typeof pane.pane_id === "string" && pane.pane_id !== "",
      );
      const terminalId =
        registered?.paneId ??
        (typeof firstPane?.pane_id === "string"
          ? firstPane.pane_id
          : undefined);
      if (terminalId === undefined) continue;
      rows.push({
        terminal_id: terminalId,
        label:
          typeof tab.label === "string" ? tab.label : (registered?.label ?? ""),
        foreground: lane === "foreground",
        registered: registered !== undefined,
        focused: tab.focused === true,
        pane_count: typeof tab.pane_count === "number" ? tab.pane_count : null,
      });
    }
  }
  return success("list", { terminals: rows, count: rows.length });
}

/** `herdr_read`：走 socket（`revision` / `truncated` 是 socket 独有信息）。 */
async function readAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
  _context: unknown,
  record: TerminalRecord,
): Promise<ActionResult> {
  if (record.paneId === deps.callerPaneId) {
    return failure(
      "read",
      "invalid-params",
      `terminal_id 不能是调用者自己所在的 pane（${record.paneId}）：那是 dsh 自己的界面，读它会读到本次调用自身的回显`,
      { terminalId: record.paneId, hint: "用 herdr_create 建新终端后再读。" },
    );
  }
  const source = readSource(args.source);
  const lines = posInt(args, "lines") ?? DEFAULT_READ_LINES;
  const format = readFormat(args.format);
  const reader = await deps.readerFor(record.lane);
  const outcome = await reader.readPane({
    paneId: record.paneId,
    source,
    lines,
    format,
  });
  if (!outcome.ok) {
    return failure("read", outcome.code, outcome.message, {
      terminalId: record.paneId,
    });
  }
  return success(
    "read",
    {
      terminal_id: record.paneId,
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
    { terminalId: record.paneId },
  );
}

/** `herdr_info`：进程探活（`foreground_processes` / `shell_pid`）。 */
async function infoAction(
  deps: DispatchDeps,
  _args: Record<string, unknown>,
  _context: unknown,
  record: TerminalRecord,
): Promise<ActionResult> {
  const runner = laneRunner(deps.runner, record.lane);
  const result = await runner.run(
    ["pane", "process-info", "--pane", record.paneId],
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr, result.exitCode);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "info",
      record.paneId,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  const info = resultObject(envelope, "process_info");
  if (info === undefined) {
    return failure(
      "info",
      "herdr-bad-response",
      `process-info 响应缺少 result.process_info：${result.stdout.slice(0, 200)}`,
      { terminalId: record.paneId },
    );
  }
  const processes = objectList(info.foreground_processes);
  return success(
    "info",
    {
      terminal_id: record.paneId,
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
    { terminalId: record.paneId },
  );
}

/** `herdr_wait`：`match` / `regex` 走 CLI，`stable` 走 socket 判稳。 */
async function waitAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
  _context: unknown,
  record: TerminalRecord,
): Promise<ActionResult> {
  const match = str(args, "match");
  const regex = str(args, "regex");
  const stable = flag(args, "stable");
  if (stable && (match !== undefined || regex !== undefined)) {
    return failure(
      "wait",
      "invalid-params",
      "stable 与 match / regex 互斥：静默判定等「屏内容不再变化」，不叠加匹配条件",
      { terminalId: record.paneId },
    );
  }
  if (!stable && match !== undefined && regex !== undefined) {
    return failure(
      "wait",
      "invalid-params",
      "match 与 regex 二选一，不能同时给出",
      {
        terminalId: record.paneId,
      },
    );
  }
  if (!stable && match === undefined && regex === undefined) {
    return failure(
      "wait",
      "invalid-params",
      "wait 需要 match / regex / stable 之一：match 等字面量出现，regex 等正则匹配，stable 等屏内容不再变化",
      { terminalId: record.paneId },
    );
  }
  const source = readSource(args.source);
  const lines = posInt(args, "lines") ?? DEFAULT_READ_LINES;
  const timeoutMs = posInt(args, "timeout_ms") ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (stable) {
    const settleMs = posInt(args, "settle_ms") ?? DEFAULT_SETTLE_MS;
    const reader = await deps.readerFor(record.lane);
    const clock = deps.clock;
    const outcome = await waitForStable(
      reader,
      {
        paneId: record.paneId,
        source,
        lines,
        format: "text",
      },
      { settleMs, timeoutMs },
      ...(clock === undefined ? [] : [clock]),
    );
    if (outcome.error !== undefined) {
      return failure("wait", "socket-error", outcome.error, {
        terminalId: record.paneId,
      });
    }
    if (!outcome.stable) {
      return failure(
        "wait",
        "timeout",
        `等待超时（${timeoutMs}ms）：屏内容仍在变化，未判稳`,
        {
          terminalId: record.paneId,
          hint: "可放宽 timeout_ms / settle_ms；或用 herdr_read 直接看当前屏内容。",
        },
      );
    }
    return success(
      "wait",
      {
        terminal_id: record.paneId,
        matched: true,
        stable: true,
        basis: outcome.basis,
        changes: outcome.changes,
        elapsed_ms: outcome.elapsedMs,
        text: outcome.text,
        ...(outcome.revision === undefined
          ? {}
          : { revision: outcome.revision }),
      },
      { terminalId: record.paneId },
    );
  }
  const runner = laneRunner(deps.runner, record.lane);
  const commandArgs = [
    "pane",
    "wait-output",
    record.paneId,
    ...(match === undefined ? ["--regex", regex ?? ""] : ["--match", match]),
    "--source",
    source,
    "--lines",
    String(lines),
    "--timeout",
    String(timeoutMs),
  ];
  // CLI 侧留 5s 余量等进程收尾（服务端到点先返回错误信封，退出码 1）
  const result = await runner.run(commandArgs, timeoutMs + 5000);
  const envelope = parseEnvelope(result.stdout, result.stderr, result.exitCode);
  if (envelope.kind === "ok") {
    const read = resultObject(envelope, "read");
    const matchedLine =
      typeof envelope.result.matched_line === "string"
        ? envelope.result.matched_line
        : undefined;
    return success(
      "wait",
      {
        terminal_id: record.paneId,
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
      { terminalId: record.paneId },
    );
  }
  if (result.timedOut) {
    return cliFailure(
      "wait",
      record.paneId,
      envelope,
      result,
      timeoutMs + 5000,
    );
  }
  if (envelope.kind === "error" && envelope.error.code === "timeout") {
    return failure(
      "wait",
      "timeout",
      `等待超时（${timeoutMs}ms）：未在终端输出里等到${
        match === undefined ? `正则 ${regex ?? ""}` : `字面量 ${match}`
      }`,
      {
        terminalId: record.paneId,
        hint: "可放宽 timeout_ms；或用 herdr_read 看当前屏内容确认程序是否已起。",
      },
    );
  }
  return cliFailure("wait", record.paneId, envelope, result, timeoutMs + 5000);
}

/** `herdr_create`：在目标 lane 的会话 workspace 建终端（新 tab + 自带 root pane）。 */
async function createAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
  context: unknown,
): Promise<ActionResult> {
  const session = sessionOf(deps, context);
  if (session === undefined) return sessionFailure("create");
  const foreground = args.foreground !== false;
  const lane: Lane = foreground ? "foreground" : "background";
  const ready = await ensureWorkspace({
    runner: deps.runner,
    registry: deps.registry,
    config: deps.config,
    session,
    lane,
  });
  if (!ready.ok) {
    return failure("create", ready.code, ready.message, {
      ...(ready.hint === undefined ? {} : { hint: ready.hint }),
    });
  }
  const cwd = str(args, "cwd") ?? session.cwd;
  const label = str(args, "label") ?? deps.config.label;
  const runner = laneRunner(deps.runner, lane);
  const result = await runner.run(
    [
      "tab",
      "create",
      "--workspace",
      ready.binding.workspaceId,
      "--cwd",
      cwd,
      "--label",
      label,
      "--no-focus",
    ],
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr, result.exitCode);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "create",
      undefined,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  const tab = resultObject(envelope, "tab");
  const tabId = typeof tab?.tab_id === "string" ? tab.tab_id : undefined;
  if (tabId === undefined || tabId === "") {
    return failure(
      "create",
      "herdr-bad-response",
      `tab create 成功但取不到 .result.tab.tab_id（原始响应：${result.stdout.slice(0, 200)}）`,
    );
  }
  const root = resultObject(envelope, "root_pane");
  const rootPaneId =
    typeof root?.pane_id === "string" && root.pane_id !== ""
      ? root.pane_id
      : undefined;
  if (rootPaneId === undefined) {
    return failure(
      "create",
      "herdr-bad-response",
      `tab create 成功但取不到 .result.root_pane.pane_id（tab ${tabId} 已建，未登记）`,
      {
        hint: "herdr 响应形状可能已漂移；先人工在 herdr 里确认该 tab，必要时手动关闭。",
      },
    );
  }
  const record = deps.registry.register({
    paneId: rootPaneId,
    tabId,
    lane,
    sessionId: session.id,
    workspaceId: ready.binding.workspaceId,
    label,
    ...(cwd === undefined ? {} : { cwd }),
  });
  return success(
    "create",
    {
      terminal_id: record.paneId,
      label: record.label,
      cwd,
      foreground,
    },
    { terminalId: record.paneId },
  );
}

/** `herdr_close`：关整个 tab 并注销登记。 */
async function closeAction(
  deps: DispatchDeps,
  _args: Record<string, unknown>,
  _context: unknown,
  record: TerminalRecord,
): Promise<ActionResult> {
  if (
    record.lane === "foreground" &&
    deps.callerTabId !== undefined &&
    record.tabId === deps.callerTabId
  ) {
    return failure(
      "close",
      "invalid-params",
      `terminal ${record.paneId} 是调用者自己所在的 tab（HERDR_TAB_ID）：关闭它会连 dsh 自己的界面一起关掉`,
      { terminalId: record.paneId, hint: "用 herdr_list 选自己创建的终端。" },
    );
  }
  const runner = laneRunner(deps.runner, record.lane);
  const result = await runner.run(
    tabCloseArgs(record.tabId),
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr, result.exitCode);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "close",
      record.paneId,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  deps.registry.unregister(record);
  return success(
    "close",
    { terminal_id: record.paneId, closed: true },
    { terminalId: record.paneId },
  );
}

/** `herdr_label`：同时改 tab 标题与 root pane label（非空）。 */
async function labelAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
  _context: unknown,
  record: TerminalRecord,
): Promise<ActionResult> {
  const label = str(args, "label");
  if (label === undefined) {
    return failure("label", "invalid-params", "label 需要非空的 label 参数", {
      terminalId: record.paneId,
    });
  }
  const runner = laneRunner(deps.runner, record.lane);
  const tabResult = await runner.run(
    tabRenameArgs(record.tabId, label),
    deps.config.timeoutMs,
  );
  const tabEnvelope = parseEnvelope(
    tabResult.stdout,
    tabResult.stderr,
    tabResult.exitCode,
  );
  if (tabResult.timedOut || tabEnvelope.kind !== "ok") {
    return cliFailure(
      "label",
      record.paneId,
      tabEnvelope,
      tabResult,
      deps.config.timeoutMs,
    );
  }
  const paneResult = await runner.run(
    paneRenameArgs(record.paneId, label),
    deps.config.timeoutMs,
  );
  const paneEnvelope = parseEnvelope(
    paneResult.stdout,
    paneResult.stderr,
    paneResult.exitCode,
  );
  if (paneResult.timedOut || paneEnvelope.kind !== "ok") {
    const failureResult = cliFailure(
      "label",
      record.paneId,
      paneEnvelope,
      paneResult,
      deps.config.timeoutMs,
    );
    if (!failureResult.ok) {
      failureResult.notes = [
        "tab 标题已改，pane 归属标记未改；重试 label 可补上",
      ];
    }
    return failureResult;
  }
  deps.registry.relabel(record, label);
  return success(
    "label",
    { terminal_id: record.paneId, label },
    { terminalId: record.paneId },
  );
}

/** `herdr_text`：注入字面量文本（不追加回车）。 */
async function textAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
  _context: unknown,
  record: TerminalRecord,
): Promise<ActionResult> {
  const text = str(args, "text");
  if (text === undefined) {
    return failure("text", "invalid-params", "text 需要非空的 text 参数", {
      terminalId: record.paneId,
    });
  }
  const runner = laneRunner(deps.runner, record.lane);
  const result = await runner.run(
    ["pane", "send-text", record.paneId, text],
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr, result.exitCode);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "text",
      record.paneId,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  return success(
    "text",
    { terminal_id: record.paneId, chars: text.length },
    { terminalId: record.paneId },
  );
}

/** `herdr_key`：按键序列（如 `["ctrl+c"]` / `["esc"]` / `["up"]`）。 */
async function keyAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
  _context: unknown,
  record: TerminalRecord,
): Promise<ActionResult> {
  const keys = strList(args, "keys");
  if (keys === undefined || keys.length === 0) {
    return failure(
      "key",
      "invalid-params",
      'key 需要非空的 keys 字符串数组（如 ["ctrl+c"] / ["esc"] / ["up"]）',
      { terminalId: record.paneId },
    );
  }
  const runner = laneRunner(deps.runner, record.lane);
  const result = await runner.run(
    ["pane", "send-keys", record.paneId, ...keys],
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr, result.exitCode);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "key",
      record.paneId,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  return success(
    "key",
    { terminal_id: record.paneId, keys },
    { terminalId: record.paneId },
  );
}

/** `herdr_run`：文本 + 回车一次提交。 */
async function runAction(
  deps: DispatchDeps,
  args: Record<string, unknown>,
  _context: unknown,
  record: TerminalRecord,
): Promise<ActionResult> {
  const command = str(args, "command");
  if (command === undefined) {
    return failure("run", "invalid-params", "run 需要非空的 command 参数", {
      terminalId: record.paneId,
    });
  }
  const runner = laneRunner(deps.runner, record.lane);
  const result = await runner.run(
    ["pane", "run", record.paneId, command],
    deps.config.timeoutMs,
  );
  const envelope = parseEnvelope(result.stdout, result.stderr, result.exitCode);
  if (result.timedOut || envelope.kind !== "ok") {
    return cliFailure(
      "run",
      record.paneId,
      envelope,
      result,
      deps.config.timeoutMs,
    );
  }
  return success(
    "run",
    { terminal_id: record.paneId, command },
    { terminalId: record.paneId },
  );
}

/** 带终端目标的动作（dispatch 先解析登记记录再进 handler）。 */
type TargetAction =
  "read" | "info" | "wait" | "close" | "label" | "text" | "key" | "run";

/** 目标动作处理函数（record 已由 dispatch 保证非空）。 */
type TargetHandler = (
  deps: DispatchDeps,
  args: Record<string, unknown>,
  context: unknown,
  record: TerminalRecord,
) => Promise<ActionResult>;

/** workspace 类动作处理函数（自己解析会话）。 */
type WorkspaceHandler = (
  deps: DispatchDeps,
  args: Record<string, unknown>,
  context: unknown,
) => Promise<ActionResult>;

/** 目标动作分派表。 */
const TARGET_HANDLERS: Record<TargetAction, TargetHandler> = {
  read: readAction,
  info: infoAction,
  wait: waitAction,
  close: closeAction,
  label: labelAction,
  text: textAction,
  key: keyAction,
  run: runAction,
};

/** workspace 类动作分派表。 */
const WORKSPACE_HANDLERS: Record<"list" | "create", WorkspaceHandler> = {
  list: listAction,
  create: createAction,
};

/** workspace 类动作的共享串行队列键（与 terminal id 命名空间隔离）。 */
const WORKSPACE_QUEUE_KEY = "\u0000workspace";

/**
 * 派发一个动作（**唯一的执行入口**：十个工具、服务面、真机验证脚本都走它）。
 *
 * 顺序固定：动作名 → guard 复查 → 终端归属 → 串行化 → 执行。
 * 服务面调用不经宿主 `tools/pre-execute`，但动作层仍复核归属（库面不该绕开限制）。
 *
 * `context` 是会话上下文（工具 exec / `{ session }` / `{ id, cwd }`）；只有 list / create 用。
 */
export async function dispatchAction(
  action: string,
  args: Record<string, unknown>,
  deps: DispatchDeps,
  context?: unknown,
): Promise<ActionResult> {
  if (!(ALL_ACTIONS as readonly string[]).includes(action)) {
    return failure(
      "list",
      "unknown-action",
      `未知动作：${String(action)}（可选 ${ALL_ACTIONS.join(" / ")}）`,
    );
  }
  const typedAction = action as HerdrUseAction;
  // 闸① guard 复查（只看命令文本参数；fail-open 口径见 policy.ts）
  const text = inspectedText(typedAction, args);
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
          hint: "命令未送达终端。放行方式见回执里的 security-guard 说明。",
        },
      );
    }
  }
  // workspace 类动作共用一把锁：并发的 create 不会各建一个 workspace
  if (typedAction === "list" || typedAction === "create") {
    return deps.registry.serialize(WORKSPACE_QUEUE_KEY, () =>
      WORKSPACE_HANDLERS[typedAction](deps, args, context),
    );
  }
  const target = targetOf(deps, typedAction, args);
  if (!target.ok) return target.result;
  const record = target.record;
  // 同终端串行化：同一终端上的驱动 / 关闭按提交顺序执行
  return deps.registry.serialize(`${record.lane}:${record.paneId}`, () =>
    TARGET_HANDLERS[typedAction](deps, args, context, record),
  );
}

/** 生产路径的 runner 构造（`main.ts` 用；库面消费者可自备）。 */
export function defaultRunner(binPath: string): HerdrRunner {
  return createDefaultRunner(binPath);
}
