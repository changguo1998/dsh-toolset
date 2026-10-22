/**
 * tests/helpers.ts — 单测共用的假件（不依赖真机 herdr）
 *
 * 口径：所有对外部世界的访问都经依赖注入（runner / reader / 连接器 / 时钟 / 环境变量），
 * 故单测不需要 herdr 二进制、socket 或真 pane；真机验证见 `scripts/verify-herdr-use.mjs`
 * （人工跑、不进 CI）。
 */

import type { CliRunResult, HerdrRunner } from "../src/cli.ts";
import type {
  Clock,
  PaneReadOutcome,
  PaneReader,
  SocketConnector,
  SocketResponse,
} from "../src/socket.ts";
import { PaneRegistry } from "../src/registry.ts";
import { resolveConfig } from "../src/types.ts";
import type { HerdrUseConfig, ResolvedConfig } from "../src/types.ts";
import type { SessionContext } from "../src/workspace.ts";

/** 记录型 fake runner：按调用顺序记录 argv，按注入的响应序列返回。 */
export interface FakeRunner extends HerdrRunner {
  /** 已执行的命令（每项为 argv 数组）。 */
  calls: string[][];
  /** 每项调用收到的超时。 */
  timeouts: number[];
}

/** 构造 fake runner：`respond` 按 argv 返回结果，缺省返回成功空信封。 */
export function fakeRunner(
  respond: (args: string[], timeoutMs: number) => CliRunResult = () =>
    okEnvelope(),
): FakeRunner {
  const calls: string[][] = [];
  const timeouts: number[] = [];
  return {
    calls,
    timeouts,
    async run(args: string[], timeoutMs: number): Promise<CliRunResult> {
      calls.push([...args]);
      timeouts.push(timeoutMs);
      return respond(args, timeoutMs);
    },
  };
}

/** 成功信封（`result` 原样给）。 */
export function okEnvelope(result: Record<string, unknown> = {}): CliRunResult {
  return {
    stdout: JSON.stringify({
      id: "cli:test",
      result: { type: "ok", ...result },
    }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

/** 错误信封（实测写在 stderr，exit 1）。 */
export function errorEnvelope(code: string, message: string): CliRunResult {
  return {
    stdout: "",
    stderr: JSON.stringify({ id: "cli:test", error: { code, message } }),
    exitCode: 1,
    timedOut: false,
  };
}

/** CLI 语法错误（实测为一行纯文本 + exit 2）。 */
export function usageError(message = "unknown option: --nope"): CliRunResult {
  return { stdout: "", stderr: message, exitCode: 2, timedOut: false };
}

/** 超时（runner 层：进程被杀）。 */
export function timedOut(): CliRunResult {
  return {
    stdout: "",
    stderr: "timeout: 10ms 超时被终止",
    exitCode: -1,
    timedOut: true,
  };
}

/** 记录型 fake reader：按队列返回读结果，队列耗尽后重复最后一项。 */
export interface FakeReader extends PaneReader {
  /** 每次读取的入参。 */
  calls: Array<{
    paneId: string;
    source: string;
    lines?: number;
    format?: string;
  }>;
}

/** 构造 fake reader。 */
export function fakeReader(
  outcomes: PaneReadOutcome[] | (() => PaneReadOutcome),
): FakeReader {
  const calls: FakeReader["calls"] = [];
  let index = 0;
  const queue = Array.isArray(outcomes) ? outcomes : undefined;
  const pick = (): PaneReadOutcome => {
    if (typeof outcomes === "function") return outcomes();
    const item = queue?.[Math.min(index, (queue?.length ?? 1) - 1)];
    index += 1;
    if (item === undefined) {
      return {
        ok: true,
        read: {
          paneId: "wT:new",
          source: "recent_unwrapped",
          format: "text",
          text: "",
        },
      };
    }
    return item;
  };
  return {
    calls,
    async readPane(params) {
      calls.push({
        paneId: params.paneId,
        source: params.source,
        ...(params.lines === undefined ? {} : { lines: params.lines }),
        ...(params.format === undefined ? {} : { format: params.format }),
      });
      return pick();
    },
  };
}

/** 读结果构造（成功）。 */
export function readOk(
  text: string,
  extra: { revision?: number; truncated?: boolean } = {},
): PaneReadOutcome {
  return {
    ok: true,
    read: {
      paneId: "wT:p2",
      source: "recent_unwrapped",
      format: "text",
      text,
      ...extra,
    },
  };
}

/** 读结果构造（失败）。 */
export function readError(
  message: string,
  code:
    "socket-error" | "socket-timeout" | "herdr-bad-response" = "socket-error",
): PaneReadOutcome {
  return { ok: false, code, message };
}

/** 假时钟：`sleep` 立即推进虚拟时间（不真实等待）。 */
export interface FakeClock extends Clock {
  /** 已推进的总毫秒。 */
  elapsed: number;
  /** 已 sleep 的次数。 */
  sleeps: number;
}

/** 构造假时钟；`start` 可固定起点。 */
export function fakeClock(start = 1_000_000): FakeClock {
  let now = start;
  const clock: FakeClock = {
    elapsed: 0,
    sleeps: 0,
    now: () => now,
    async sleep(ms: number): Promise<void> {
      now += ms;
      clock.elapsed += ms;
      clock.sleeps += 1;
    },
  };
  return clock;
}

/** 记录型 socket 连接器：按队列返回响应，并记录发出的报文。 */
export interface FakeConnector extends SocketConnector {
  /** 每次请求的 (socketPath, payload, timeoutMs)。 */
  requests: Array<{ socketPath: string; payload: string; timeoutMs: number }>;
}

/** 构造 fake 连接器。 */
export function fakeConnector(responses: SocketResponse[]): FakeConnector {
  const requests: FakeConnector["requests"] = [];
  let index = 0;
  return {
    requests,
    async request(socketPath, payload, timeoutMs) {
      requests.push({ socketPath, payload, timeoutMs });
      const item = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return item ?? { kind: "error", message: "fake connector 未提供响应" };
    },
  };
}

/** 注册表 + 配置的快捷构造。 */
export function setup(config: HerdrUseConfig = {}): {
  registry: PaneRegistry;
  config: ResolvedConfig;
} {
  const resolved = resolveConfig(config);
  return { registry: new PaneRegistry(resolved.label), config: resolved };
}

/** 不产出命令文本的 guard 检查器（缺省注入用；等价于「guard 缺失、fail-open」）。 */
export const passGuard = (): { outcome: "pass" } => ({ outcome: "pass" });

/** 单测会话（label 会算成 `proj/abcd1234`）。 */
export const fakeSession: SessionContext = {
  id: "session-abcd1234",
  cwd: "/tmp/proj",
};

/** 宿主执行上下文的最小形态（`exec.agent.session`，session 的 cwd 在 header 里）。 */
export function fakeExec(session: SessionContext = fakeSession): {
  agent: { session: { id: string; header: { cwd: string } } };
} {
  return {
    agent: { session: { id: session.id, header: { cwd: session.cwd } } },
  };
}

/** 假 herdr 服务端状态（workspace / tab / pane 三层，够本包的 argv 面用）。 */
export interface FakeHerdrState {
  workspaces: Array<Record<string, unknown>>;
  tabs: Array<Record<string, unknown>>;
  panes: Array<Record<string, unknown>>;
  /** 自增序号（生成新 id）。 */
  seq: number;
}

/** 假 herdr 服务端的构造入参。 */
export interface FakeHerdrOptions {
  workspaces?: Array<Record<string, unknown>>;
  tabs?: Array<Record<string, unknown>>;
  panes?: Array<Record<string, unknown>>;
  /** `pane layout` 返回的宽高（缺省 160x40，即向右切）。 */
  layout?: { width: number; height: number };
  /** 先于内建处理的自定义响应（返回 undefined 表示交给内建逻辑）。 */
  override?: (
    args: string[],
    state: FakeHerdrState,
  ) => CliRunResult | undefined;
}

/** 假 herdr 服务端（记录 argv；workspace / tab / pane 的增删查都按真机信封形状回）。 */
export function fakeHerdr(options: FakeHerdrOptions = {}): {
  runner: FakeRunner;
  state: FakeHerdrState;
} {
  const state: FakeHerdrState = {
    workspaces: [...(options.workspaces ?? [])],
    tabs: [...(options.tabs ?? [])],
    panes: [...(options.panes ?? [])],
    seq: 0,
  };
  const next = (): number => {
    state.seq += 1;
    return state.seq;
  };
  const flagValue = (args: string[], flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const runner = fakeRunner((args) => {
    const custom = options.override?.(args, state);
    if (custom !== undefined) return custom;
    const [kind, verb] = args;
    if (kind === "workspace" && verb === "list") {
      return okEnvelope({
        type: "workspace_list",
        workspaces: state.workspaces,
      });
    }
    if (kind === "workspace" && verb === "create") {
      const id = `wT${next()}`;
      const label = flagValue(args, "--label") ?? "ws";
      const cwd = flagValue(args, "--cwd");
      const tabId = `${id}:t1`;
      const paneId = `${id}:p1`;
      state.workspaces.push({
        workspace_id: id,
        label,
        active_tab_id: tabId,
        focused: false,
        pane_count: 1,
        tab_count: 1,
      });
      state.tabs.push({
        tab_id: tabId,
        workspace_id: id,
        label: "1",
        number: 1,
        pane_count: 1,
        focused: false,
      });
      state.panes.push({
        pane_id: paneId,
        workspace_id: id,
        tab_id: tabId,
        focused: false,
        ...(cwd === undefined ? {} : { cwd }),
      });
      return okEnvelope({
        type: "workspace_create",
        workspace: { workspace_id: id, label },
        tab: { tab_id: tabId, workspace_id: id },
        root_pane: { pane_id: paneId, tab_id: tabId, workspace_id: id },
      });
    }
    if (kind === "workspace" && verb === "close") {
      const id = args[2] ?? "";
      state.workspaces = state.workspaces.filter(
        (item) => item.workspace_id !== id,
      );
      state.tabs = state.tabs.filter((item) => item.workspace_id !== id);
      state.panes = state.panes.filter((item) => item.workspace_id !== id);
      return okEnvelope({ type: "workspace_close" });
    }
    if (kind === "pane" && verb === "list") {
      const workspace = flagValue(args, "--workspace");
      const panes =
        workspace === undefined
          ? state.panes
          : state.panes.filter((item) => item.workspace_id === workspace);
      return okEnvelope({ type: "pane_list", panes });
    }
    if (kind === "pane" && verb === "layout") {
      const layout = options.layout ?? { width: 160, height: 40 };
      return okEnvelope({
        layout: { type: "pane_layout", area: layout },
      });
    }
    if (kind === "pane" && verb === "split") {
      const targetId = args[2] ?? "";
      const target = state.panes.find((item) => item.pane_id === targetId);
      if (target === undefined) {
        return errorEnvelope("pane_not_found", `pane ${targetId} not found`);
      }
      const paneId = `${String(target.workspace_id)}:p${next()}`;
      state.panes.push({
        pane_id: paneId,
        workspace_id: target.workspace_id,
        tab_id: target.tab_id,
        focused: false,
        ...(flagValue(args, "--cwd") === undefined
          ? {}
          : { cwd: flagValue(args, "--cwd") }),
      });
      return okEnvelope({
        type: "pane_split",
        pane: {
          pane_id: paneId,
          workspace_id: target.workspace_id,
          tab_id: target.tab_id,
        },
      });
    }
    if (kind === "pane" && verb === "rename") {
      const paneId = args[2] === "--clear" ? (args[3] ?? "") : (args[2] ?? "");
      const pane = state.panes.find((item) => item.pane_id === paneId);
      if (pane !== undefined) {
        if (args[2] === "--clear") delete pane.label;
        else if (args[3] !== undefined) pane.label = args[3];
      }
      return okEnvelope({ type: "pane_rename" });
    }
    if (kind === "pane" && verb === "close") {
      const id = args[2] ?? "";
      state.panes = state.panes.filter((item) => item.pane_id !== id);
      return okEnvelope({ type: "pane_close" });
    }
    if (kind === "pane" && verb === "process-info") {
      const paneId = flagValue(args, "--pane") ?? "";
      return okEnvelope({
        type: "pane_process_info",
        process_info: {
          pane_id: paneId,
          shell_pid: 1,
          foreground_processes: [],
        },
      });
    }
    if (kind === "tab" && verb === "list") {
      const workspace = flagValue(args, "--workspace");
      const tabs =
        workspace === undefined
          ? state.tabs
          : state.tabs.filter((item) => item.workspace_id === workspace);
      return okEnvelope({ type: "tab_list", tabs });
    }
    if (kind === "tab" && verb === "create") {
      const workspaceId = flagValue(args, "--workspace") ?? "";
      const label = flagValue(args, "--label") ?? "tab";
      const cwd = flagValue(args, "--cwd");
      const tabId = `${workspaceId}:t${next()}`;
      const paneId = `${workspaceId}:p${next()}`;
      const number = state.tabs.length + 1;
      state.tabs.push({
        tab_id: tabId,
        workspace_id: workspaceId,
        label,
        number,
        pane_count: 1,
        focused: false,
      });
      state.panes.push({
        pane_id: paneId,
        workspace_id: workspaceId,
        tab_id: tabId,
        focused: false,
        ...(cwd === undefined ? {} : { cwd }),
      });
      const workspace = state.workspaces.find(
        (item) => item.workspace_id === workspaceId,
      );
      if (workspace !== undefined) workspace.active_tab_id = tabId;
      return okEnvelope({
        type: "tab_create",
        tab: { tab_id: tabId, workspace_id: workspaceId, label, number },
        root_pane: {
          pane_id: paneId,
          tab_id: tabId,
          workspace_id: workspaceId,
        },
      });
    }
    if (kind === "tab" && verb === "close") {
      const id = args[2] ?? "";
      const removed = state.tabs.find((item) => item.tab_id === id);
      state.tabs = state.tabs.filter((item) => item.tab_id !== id);
      state.panes = state.panes.filter((item) => item.tab_id !== id);
      const workspace = state.workspaces.find(
        (item) =>
          removed !== undefined && item.workspace_id === removed.workspace_id,
      );
      if (workspace !== undefined && workspace.active_tab_id === id) {
        workspace.active_tab_id = state.tabs.find(
          (item) => item.workspace_id === workspace.workspace_id,
        )?.tab_id;
      }
      return okEnvelope({ type: "tab_close" });
    }
    return okEnvelope({});
  });
  return { runner, state };
}
