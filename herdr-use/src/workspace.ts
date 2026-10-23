/**
 * src/workspace.ts — 会话 × lane ↔ herdr workspace 的内部绑定（**不出工具面**）
 *
 * 口径（2026-10-23 终端面重构）：
 *   - 严格按 dsh 会话绑定：`(session id, lane)` 各一个 workspace，会话之间不共享。
 *   - lane = `foreground`（继承父会话所在 herdr session，不传 `--session`）或
 *     `background`（所有命令前置 `--session dshbg`）。
 *   - label = `<会话 cwd 目录名>/<会话 id 末 8 位>`：`workspace list` 按 label 精确匹配复用，
 *     找不到才 `workspace create --cwd <会话 cwd> --label <label> --no-focus`。
 *   - workspace id / 名字**不出现**在任何工具参数与回执里；`herdr_create` 的落点由本模块解析。
 *
 * 会话对象来自宿主 `exec`（`readSessionContext` 收三种形态）：`exec.agent.session` 为主，
 * 另收 `{ session: { id, cwd } }` 与 `{ id, cwd }`——服务面消费方无需伪造工具上下文。
 */

import { basename } from "node:path";

import type { CliRunResult, HerdrRunner, ParsedEnvelope } from "./cli.ts";
import { parseEnvelope } from "./cli.ts";
import type { TerminalRegistry } from "./registry.ts";
import {
  BACKGROUND_SESSION,
  resolveConfig,
  type Lane,
  type ResolvedConfig,
  type WorkspaceBinding,
} from "./types.ts";

/** 会话上下文（本包只需要身份与工作目录）。 */
export interface SessionContext {
  id: string;
  cwd: string;
}

/** 会话解析器（生产读宿主 `exec`；单测 / 真机脚本可注入固定会话）。 */
export type SessionResolver = (context?: unknown) => SessionContext | undefined;

/** 对象收窄（非对象给 undefined）。 */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `unknown` 取「对象数组」（非数组给空数组）。 */
function objectList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const list: unknown[] = value;
  return list.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object",
  );
}

/** 非空字符串（其余一律 undefined）。 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 从宿主执行上下文里读会话：`exec.agent.session` 为主，另收 `exec.session`
 * 与「直接传会话对象」两种形态（服务面 / 库面 / 真机脚本好用）。
 * 会话 id 缺失即返回 undefined；cwd 缺失回退 `process.cwd()`（宿主会话 header 允许无 cwd）。
 */
export function readSessionContext(
  context: unknown,
): SessionContext | undefined {
  const root = obj(context);
  if (root === undefined) return undefined;
  const agent = obj(root.agent);
  const session =
    obj(agent?.session) ??
    obj(root.session) ??
    (nonEmpty(root.id) === undefined ? undefined : root);
  if (session === undefined) return undefined;
  const id = nonEmpty(session.id);
  if (id === undefined) return undefined;
  const header = obj(session.header);
  const meta = obj(session.meta);
  const cwd =
    nonEmpty(header?.cwd) ??
    nonEmpty(meta?.cwd) ??
    nonEmpty(session.cwd) ??
    process.cwd();
  return { id, cwd };
}

/** 会话 id 的短标记（末 8 位，先滤掉非 `[A-Za-z0-9_-]` 字符）。 */
export function shortSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]+/g, "");
  const tail = cleaned.slice(-8);
  return tail === "" ? "session" : tail;
}

/**
 * 约定 label：`<cwd 目录名>/<会话 id 短标记>`。
 * 目录名里的空白与斜杠归一为 `-`，整体截到 80 字符（herdr label 无长度契约，取保守值）。
 */
export function workspaceLabel(session: SessionContext): string {
  const raw = basename(session.cwd)
    .replace(/[\s/]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const head = raw === "" || raw === "." ? "dsh" : raw;
  return `${head}/${shortSessionId(session.id)}`.slice(0, 80);
}

/** lane 的 CLI 前缀（background 固定指向 `dshbg`；foreground 继承父会话）。 */
export function laneArgs(lane: Lane): string[] {
  return lane === "background" ? ["--session", BACKGROUND_SESSION] : [];
}

/** 带 lane 前缀的 argv。 */
export function withLane(lane: Lane, args: string[]): string[] {
  return [...laneArgs(lane), ...args];
}

/** 绑定到某 lane 的 runner（foreground 原样复用，background 自动加 `--session dshbg`）。 */
export function laneRunner(runner: HerdrRunner, lane: Lane): HerdrRunner {
  if (lane === "foreground") return runner;
  return {
    run(args: string[], timeoutMs: number): Promise<CliRunResult> {
      return runner.run(withLane(lane, args), timeoutMs);
    },
  };
}

/** 确保绑定的入参。 */
export interface EnsureWorkspaceOptions {
  runner: HerdrRunner;
  registry: TerminalRegistry;
  config: ResolvedConfig;
  session: SessionContext;
  lane: Lane;
}

/** 确保绑定的结果（失败走结构化错误，不抛）。 */
export type EnsureWorkspaceResult =
  | { ok: true; binding: WorkspaceBinding; created: boolean }
  | {
      ok: false;
      code: "workspace-unavailable";
      message: string;
      hint?: string;
    };

/** herdr 调用失败的可读文案（信封错误码原样带上，退出码兜底）。 */
function cliFailureText(
  envelope: ParsedEnvelope,
  result: CliRunResult,
): string {
  if (result.timedOut) return "herdr CLI 超时被终止";
  if (envelope.kind === "error") {
    return `${envelope.error.code}: ${envelope.error.message}`;
  }
  return `herdr CLI 失败（exit ${result.exitCode}）：${
    (result.stderr || result.stdout).trim() || "（无输出）"
  }`;
}

/** workspace 类失败的统一提示。 */
const WORKSPACE_HINT =
  "确认 herdr 服务端在跑（herdr status）后重试：本插件需要能在服务端建 / 查 workspace。";

/**
 * 确保 (会话, lane) 的 workspace 绑定：`workspace list` 复核后，缓存仍存活则直接复用
 * （只花一次只读列举）；缓存指向的 workspace 已被关闭时**清空绑定并按 label 重新匹配 /
 * 新建**。workspace 的 root pane 不登记为终端（终端只由 `herdr_create` 建 tab 产生）。
 */
export async function ensureWorkspace(
  options: EnsureWorkspaceOptions,
): Promise<EnsureWorkspaceResult> {
  const { registry, config, session, lane } = options;
  const runner = laneRunner(options.runner, lane);
  const label = workspaceLabel(session);
  const listed = await runner.run(["workspace", "list"], config.timeoutMs);
  const listEnvelope = parseEnvelope(
    listed.stdout,
    listed.stderr,
    listed.exitCode,
  );
  if (listed.timedOut || listEnvelope.kind !== "ok") {
    return {
      ok: false,
      code: "workspace-unavailable",
      message: `workspace list 失败：${cliFailureText(listEnvelope, listed)}`,
      hint: WORKSPACE_HINT,
    };
  }
  const workspaces = objectList(listEnvelope.result.workspaces);
  const cached = registry.getBinding(session.id, lane);
  if (cached !== undefined) {
    const alive = workspaces.some(
      (item) => nonEmpty(item.workspace_id) === cached.workspaceId,
    );
    if (alive) return { ok: true, binding: cached, created: false };
    // 缓存的 workspace 已不在服务端（被关闭）：失效后按 label 重新匹配，没有就新建
    registry.setBinding(session.id, lane, undefined);
  }
  const matched = workspaces.find((item) => item.label === label);
  let workspaceId = nonEmpty(matched?.workspace_id);
  let created = false;
  if (workspaceId === undefined) {
    const createdResult = await runner.run(
      [
        "workspace",
        "create",
        "--cwd",
        session.cwd,
        "--label",
        label,
        "--no-focus",
      ],
      config.timeoutMs,
    );
    const createEnvelope = parseEnvelope(
      createdResult.stdout,
      createdResult.stderr,
      createdResult.exitCode,
    );
    if (createdResult.timedOut || createEnvelope.kind !== "ok") {
      return {
        ok: false,
        code: "workspace-unavailable",
        message: `workspace create 失败：${cliFailureText(createEnvelope, createdResult)}`,
        hint: WORKSPACE_HINT,
      };
    }
    const workspace = obj(createEnvelope.result.workspace);
    workspaceId = nonEmpty(workspace?.workspace_id);
    if (workspaceId === undefined) {
      return {
        ok: false,
        code: "workspace-unavailable",
        message:
          "workspace create 成功但取不到 .result.workspace.workspace_id" +
          `（原始响应：${createdResult.stdout.slice(0, 200)}）`,
        hint: "herdr 响应形状可能已漂移；用 herdr workspace list 人工核对后再重试。",
      };
    }
    created = true;
  }
  const binding: WorkspaceBinding = {
    sessionId: session.id,
    lane,
    workspaceId,
    label,
    cwd: session.cwd,
    createdAt: Date.now(),
  };
  registry.setBinding(session.id, lane, binding);
  return { ok: true, binding, created };
}

/** 生产路径的缺省配置（供库面单测少写参数）。 */
export function defaultConfig(): ResolvedConfig {
  return resolveConfig();
}
