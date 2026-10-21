/**
 * src/workspace.ts — 会话 ↔ herdr workspace 的内部绑定（**不出工具面**）
 *
 * 口径（追踪文档决策项 6 / 7 / 8）：
 *   - 模型只看到 tab / pane 两级；workspace 的创建 / 查找 / 生命周期都由本模块完成，
 *     workspace id / 名字**不出现**在任何工具参数与回执里。
 *   - label = `<会话 cwd 目录名>/<会话 id 末 8 位>`：`workspace list` 按 label 精确匹配复用，
 *     找不到才 `workspace create --cwd <会话 cwd> --label <label> --no-focus`；进程内缓存 binding，
 *     子会话（各自有 session id）沿用同一 workspace（进程内只绑一个）。
 *   - `create` 的落点由本模块解析：本 workspace 活动 tab 的 pane 由
 *     `workspace list` 的 `active_tab_id` 与 `pane list --workspace <id>` 对齐取得。
 *
 * 会话对象来自宿主 `exec.agent.session`（`Session` 的 `id` 与 `header.cwd`）；为容忍版本漂移，
 * `cwd` 另收 `meta.cwd` / `cwd` 两种写法，都取不到时回退 `process.cwd()`。
 */

import { basename } from "node:path";

import type { CliRunResult, HerdrRunner, ParsedEnvelope } from "./cli.ts";
import { parseEnvelope } from "./cli.ts";
import type { PaneRegistry } from "./registry.ts";
import type { ResolvedConfig, WorkspaceBinding } from "./types.ts";

/** 会话上下文（本包只需要身份与工作目录）。 */
export interface SessionContext {
  id: string;
  cwd: string;
}

/** 会话解析器（生产读宿主 `exec.agent.session`；单测 / 真机脚本可注入固定会话）。 */
export type SessionResolver = (exec?: unknown) => SessionContext | undefined;

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
 * 与「直接传 session」两种形态（库面 / 真机脚本好用）。
 * 会话 id 缺失即返回 undefined；cwd 缺失回退 `process.cwd()`（宿主会话 header 允许无 cwd）。
 */
export function readSessionContext(exec: unknown): SessionContext | undefined {
  const root = obj(exec);
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

/** 确保绑定的入参。 */
export interface EnsureWorkspaceOptions {
  runner: HerdrRunner;
  registry: PaneRegistry;
  config: ResolvedConfig;
  session: SessionContext;
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
 * 确保当前会话的 workspace 绑定：命中进程内缓存直接返回；否则 `workspace list` 按 label
 * 精确匹配复用，没有才新建。新建时把 workspace 的 root pane 登记为本插件 pane
 * （退出清理据此判断「workspace 内是否只剩本插件的 pane」）。
 */
export async function ensureWorkspace(
  options: EnsureWorkspaceOptions,
): Promise<EnsureWorkspaceResult> {
  const { runner, registry, config, session } = options;
  const cached = registry.workspaceBinding;
  if (cached !== undefined) {
    return { ok: true, binding: cached, created: false };
  }
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
  const matched = objectList(listEnvelope.result.workspaces).find(
    (item) => item.label === label,
  );
  let workspaceId = nonEmpty(matched?.workspace_id);
  let rootPaneId: string | undefined;
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
    rootPaneId = nonEmpty(obj(createEnvelope.result.root_pane)?.pane_id);
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
    workspaceId,
    label,
    cwd: session.cwd,
    createdAt: Date.now(),
    ...(rootPaneId === undefined ? {} : { rootPaneId }),
  };
  registry.setWorkspaceBinding(binding);
  if (rootPaneId !== undefined) {
    registry.register({
      paneId: rootPaneId,
      label: config.label,
      cwd: session.cwd,
      workspaceId,
    });
  }
  return { ok: true, binding, created };
}

/** 本 workspace 活动 pane 的解析结果。 */
export type ActivePaneResult =
  | { ok: true; paneId: string; tabId: string }
  | {
      ok: false;
      code: "workspace-unavailable";
      message: string;
      hint?: string;
    };

/**
 * 解析本 workspace 活动 tab 里的 pane：`workspace list` 拿 `active_tab_id`，
 * `pane list --workspace <id>` 取该 tab 的 pane（优先焦点 pane，否则第一个）。
 * 活动 tab 里没有 pane 时返回结构化失败（不猜别的 tab）。
 */
export async function activePaneOf(
  runner: HerdrRunner,
  config: ResolvedConfig,
  workspaceId: string,
): Promise<ActivePaneResult> {
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
  const workspace = objectList(listEnvelope.result.workspaces).find(
    (item) => item.workspace_id === workspaceId,
  );
  if (workspace === undefined) {
    return {
      ok: false,
      code: "workspace-unavailable",
      message: `本会话的 workspace ${workspaceId} 不在 workspace list 里（可能已被关闭）`,
      hint: "让 dsh 重启一次会话可重新建立 workspace；或人工用 herdr 核对服务端状态。",
    };
  }
  const activeTabId = nonEmpty(workspace.active_tab_id);
  if (activeTabId === undefined) {
    return {
      ok: false,
      code: "workspace-unavailable",
      message: `本会话的 workspace ${workspaceId} 没有活动 tab（active_tab_id 缺失）`,
      hint: "在 herdr 里打开该 workspace 的 tab 后重试；或用 tab_list 看看当前有哪些 tab。",
    };
  }
  const panesResult = await runner.run(
    ["pane", "list", "--workspace", workspaceId],
    config.timeoutMs,
  );
  const panesEnvelope = parseEnvelope(
    panesResult.stdout,
    panesResult.stderr,
    panesResult.exitCode,
  );
  if (panesResult.timedOut || panesEnvelope.kind !== "ok") {
    return {
      ok: false,
      code: "workspace-unavailable",
      message: `pane list 失败：${cliFailureText(panesEnvelope, panesResult)}`,
      hint: WORKSPACE_HINT,
    };
  }
  const candidates = objectList(panesEnvelope.result.panes).filter(
    (pane) =>
      pane.tab_id === activeTabId && nonEmpty(pane.pane_id) !== undefined,
  );
  const focused = candidates.find((pane) => pane.focused === true);
  const chosen = focused ?? candidates[0];
  const paneId = nonEmpty(chosen?.pane_id);
  if (paneId === undefined) {
    return {
      ok: false,
      code: "workspace-unavailable",
      message: `本会话 workspace ${workspaceId} 的活动 tab ${activeTabId} 里没有 pane`,
      hint: "在 herdr 里给该 tab 分一个 pane，或用 tab_list 确认 tab 状态后重试。",
    };
  }
  return { ok: true, paneId, tabId: activeTabId };
}
