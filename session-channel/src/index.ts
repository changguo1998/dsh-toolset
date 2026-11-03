/**
 * session-channel 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, provide, apply }）：
 * - `inject: ["tools", "agents", "sessions"]`：硬依赖（cordis 语义：任一不可用则插件等待、不加载）；
 *   其中 `tools` 缺失时 `session_channel` / `channel_delegate` / `channel_task` / `channel_task_result`
 *   注册不了（仅告警，服务面仍提供）；
 * - `provide: ["sessionChannel"]`：只读/发送服务面，宿主命令与插件经 `ctx.get("sessionChannel")` 访问；
 * - `apply(ctx, config)`：连接专用 Redis（`$XDG_RUNTIME_DIR/dsh-session-channel.sock`），
 *   跟踪本进程活跃会话（`session/event`）并维护在线心跳，后台阻塞读邮箱流 → 注入目标会话。
 *
 * 分层（阶段 3 代码整理后）：本文件只做接线与对外 re-export；会话层 `src/service.ts`、
 * 任务层 `src/task-layer.ts`、工具面 `src/tools.ts`。拆出的模块不新增包入口，仍只从这里导出。
 *
 * 降级：连接失败/未启用一律 fail-safe——插件仍在、工具返回错误提示，不抛不影响 dsh 启动。
 */

import { describe } from "./client.ts";
import { PLUGIN_NAME } from "./constants.ts";
import { createSessionChannelService } from "./service.ts";
import type { BundleHost, SessionChannelService } from "./service.ts";
import {
  toDelegateTool,
  toTaskResultTool,
  toTaskTool,
  toToolDef,
  withLosslessOutput,
} from "./tools.ts";
import type {
  DelegateRequest,
  KvPutOptions,
  SendRequest,
  SessionChannelConfig,
  TaskQueryOptions,
  TaskResultInput,
} from "./types.ts";

export type {
  AgentState,
  InboxMessage,
  SessionChannelConfig,
  SessionChannelErrorCode,
  PeerInfo,
  SendRequest,
  SendResult,
} from "./types.ts";
export { SessionChannelError } from "./types.ts";

export {
  createSessionChannelService,
  resolveTimers,
  SessionChannelService,
  systemTimers,
} from "./service.ts";
export type {
  BundleHost,
  ClockLike,
  Config,
  SessionChannelDeps,
  SessionChannelStatus,
  TimersLike,
} from "./service.ts";
export {
  pruneUndefined,
  SERVICE_FACE_METHODS,
  toLosslessJson,
  toToolDef,
  withLosslessOutput,
} from "./tools.ts";

export { PLUGIN_NAME as name };

/**
 * 硬依赖（cordis 语义：任一不可用则插件等待、不加载）：
 * - `agents` / `sessions`：注入面（`agents.get(sessionId).followup` + `sessions.flush`）；
 * - `tools`：注册 `session-channel` 工具。
 * 读取仍走受保护访问器（`readService`），兼容测试宿主与「服务读到一半消失」的边缘情况。
 */
export const inject = ["tools", "agents", "sessions"];

/** 提供的服务名（宿主命令/插件经 `ctx.get("sessionChannel")` 使用）。 */
export const provide = ["sessionChannel"];

/** 最近一次构建的服务（provide 面与测试读取）。 */
let activeService: SessionChannelService | undefined;

export function getSessionChannelService(): SessionChannelService | undefined {
  return activeService;
}

/**
 * DSH 宿主按 bundle 契约调用：惰性、防御；连接失败只降级（工具返回错误提示），不抛。
 *
 * 上下文对象守卫收进入口，只判这一次：`null` / 非对象按空上下文处理（此前 `null` 会在读
 * `logger` 处抛）；服务读取的唯一判断留在 `readService`，下游不再重复判类型。
 */
export function apply(
  ctx: BundleHost & Record<string, unknown> = {},
  config: SessionChannelConfig = {},
): void {
  const host: BundleHost & Record<string, unknown> =
    ctx === null || typeof ctx !== "object" ? {} : ctx;
  const warn = (msg: string): void => {
    const logger = host.logger?.(PLUGIN_NAME);
    if (typeof logger?.info === "function") logger.info(msg);
    else process.stderr.write(`[session-channel] ${msg}\n`);
  };
  const service = createSessionChannelService(config, host);
  activeService = service;
  void service.start();
  const tools = host.tools;
  if (tools && typeof tools.register === "function") {
    for (const build of [
      toToolDef,
      toDelegateTool,
      toTaskTool,
      toTaskResultTool,
    ]) {
      try {
        // 出口统一归一（决策项 7）：四个工具的返回体都先过 toLosslessJson 再交给宿主
        tools.register(withLosslessOutput(build(service)));
      } catch (err) {
        warn(`${build.name} 工具注册失败：${describe(err)}`);
      }
    }
  } else {
    warn("tools 未挂载：session-channel 工具不可用（服务面仍提供）");
  }
  const provideSvc = host.provide;
  if (typeof provideSvc === "function") {
    provideSvc("sessionChannel", {
      peers: () => service.peers(),
      // agent 状态牌（BACKLOG #1）：只读单查；组管理器等按它做「待机/工作/疑似卡死」判定
      statusOf: (sessionId: string) => service.statusOf(sessionId),
      send: (req: SendRequest) => service.send(req),
      inbox: (sessionId: string, count?: number) =>
        service.inbox(sessionId, count),
      // 别名三件套：TUI 状态行（TUI#48）等消费方经此只读/管理别名
      aliasSet: (
        alias: string,
        sessionId: string,
        opts?: { force?: boolean },
      ) => service.aliasSet(alias, sessionId, opts),
      aliasList: () => service.aliasList(),
      aliasClear: (opts: { alias?: string; sessionId?: string }) =>
        service.aliasClear(opts),
      // 共享 KV（BACKLOG #55）：插件状态同步用；读写面与类方法一一对应（D5 守卫）
      kvSet: (key: string, value: unknown, opts?: KvPutOptions) =>
        service.kvSet(key, value, opts),
      kvGet: (key: string) => service.kvGet(key),
      kvList: () => service.kvList(),
      kvDelete: (key: string) => service.kvDelete(key),
      // 委托任务（BACKLOG #54）：planner-worker 语义，结果回收见 README 契约
      delegate: (req: DelegateRequest) => service.delegate(req),
      taskStatus: (taskId: string) => service.taskStatus(taskId),
      taskList: (opts?: TaskQueryOptions) => service.taskList(opts),
      taskCancel: (taskId: string) => service.taskCancel(taskId),
      taskResult: (input: TaskResultInput) => service.taskResult(input),
      status: () => service.status(),
    });
  }
}
