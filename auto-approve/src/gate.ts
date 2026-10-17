/**
 * `tools/pre-execute` 监听器（挂载点 ①，设计决策 1 的「gate」）：
 *
 * 1. **记录参数**：把 `exec` 的 `callId → {name, arguments, agent, cwd, 升级目标}` 记进本地表 ——
 *    审批请求本身不带参数（宿主口径），沙箱升级类判据稍后要靠它反查命令 / 路径原文；
 * 2. **拒绝名单**（不需要参数即可终结的那两层）：命中直接 `{kind:"deny"}`，工具不执行、守卫不会被调用；
 * 3. **不提前放行**：其余层留给审批层 —— 工具自己的 `ask` 决定只有工具知道，提前 `allow` 会把它吞掉。
 *
 * 本监听器**不调用** `next()` 之外的任何宿主面：不碰 `ctx.tools.guard`（R3 裁定）。
 */

import type { PreExecuteExecution, PreToolDecision } from "./types.ts";
import type { Runtime } from "./runtime.ts";
import { checkDenyEscalation, checkDenyTools, isBypassed, isGatedOut } from "./rules.ts";
import type { CallInfo } from "./types.ts";
import { parseArguments } from "./patterns.ts";

/** 从参数里取 `sandbox_permissions`（升级目标模式的早期信号）。 */
export function escalationTargetFromArguments(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)["sandbox_permissions"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 从 `exec.agent` 取会话 id / 代理 id / cwd（结构面，不 import 宿主类型）。 */
export function identityOf(agent: unknown): {
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  session?: unknown;
} {
  if (agent === null || typeof agent !== "object") return {};
  const record = agent as Record<string, unknown>;
  const session = record["session"];
  const sessionRecord =
    session !== null && typeof session === "object"
      ? (session as Record<string, unknown>)
      : undefined;
  const id = sessionRecord?.["id"];
  const header = sessionRecord?.["header"];
  const cwd = (header as Record<string, unknown> | undefined)?.["cwd"];
  const agentId = record["id"];
  return {
    ...(typeof id === "string" ? { sessionId: id } : {}),
    ...(typeof agentId === "string" ? { agentId } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(session === undefined ? {} : { session }),
  };
}

/** 记录一次调用（gate 与应答者共用的构造逻辑）。 */
export function callInfoOf(exec: PreExecuteExecution, fallbackId: string): CallInfo {
  const identity = identityOf(exec.agent);
  const args = parseArguments(exec.arguments);
  return {
    callId: typeof exec.callId === "string" ? exec.callId : fallbackId,
    name: exec.name,
    arguments: args,
    ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
    ...(identity.agentId === undefined ? {} : { agentId: identity.agentId }),
    ...(identity.cwd === undefined ? {} : { cwd: identity.cwd }),
    ...(escalationTargetFromArguments(args) === undefined
      ? {}
      : { escalationTarget: escalationTargetFromArguments(args) }),
  };
}

/** 创建 `tools/pre-execute` 监听器。 */
export function createGate(runtime: Runtime): (
  exec: PreExecuteExecution,
  next: () => PreToolDecision | Promise<PreToolDecision>,
) => Promise<PreToolDecision> {
  let seq = 0;
  return async (exec, next) => {
    seq += 1;
    const info = callInfoOf(exec, `auto-approve-${seq}`);
    runtime.calls.record(info);
    if (info.sessionId !== undefined) {
      runtime.sessions.setCwd(info.sessionId, info.cwd);
    }
    const { config } = runtime.context;
    if (!config.enabled || runtime.mode === "off") return next();
    if (isBypassed(config, info.name) || isGatedOut(config, info.name)) return next();
    const target = info.escalationTarget;
    const denied =
      checkDenyTools(config, info.name) ??
      checkDenyEscalation(config, info.name, target);
    if (denied === undefined) return next();
    // 拒绝名单命中：工具不执行（守卫不会被调用；审计行由判定层统一记一次）
    const result = await runtime.evaluate(
      {
        call: info,
        cwd: info.cwd ?? process.cwd(),
        history: [],
        projectInstructions: [],
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      },
      true,
    );
    if (result.decision.outcome === "rejected") {
      return {
        kind: "deny",
        reason: result.decision.reason ?? `auto-approve 拒绝了工具 "${info.name}"`,
      };
    }
    return next();
  };
}
