/**
 * 集成层装配器：用假工具面 / 假事件面 / 假服务面拼出本包的 `apply` 与宿主接线。
 *
 * 三个假面的形状（与总规范 4.2 一致）：
 * - 假工具面：`tools/pre-execute` 的 waterfall（本包不注册工具，只消费这条执行前事件）+
 *   `ctx.commands.register` 的命令注册面；
 * - 假事件面：`ctx.on` 保存监听器，`waterfall` 按注册顺序链式调用（第一个不调 next 的胜出）；
 * - 假服务面：`ctx.get` / `ctx.provide` 的同一张表（sessionPaths / memory / llm / commands 等）。
 *
 * 只装配与派发，不放断言；断言在 `tests/integration/*.test.ts`。
 */

import type { Config } from "../src/config.ts";
import { COMMAND_NAME } from "../src/command.ts";
import { apply } from "../src/index.ts";
import type {
  ApprovalOutcome,
  ApprovalRequestLike,
  AutoApproveService,
  PluginHost,
  PreExecuteExecution,
  PreToolDecision,
} from "../src/types.ts";
import {
  createFakeHost,
  createFakeLlm,
  createFakeMemory,
  createFakeSessionPaths,
  reviewChunks,
  tempDir,
  type FakeHost,
  type FakeLlm,
} from "./fakes.ts";

/** 宿主命令定义（结构化子集）。 */
export interface CommandDefinitionLike {
  definitionId?: string;
  name?: string;
  description?: string;
  input?: { hint?: string };
  handler?(invocation?: { rawInput?: string }): unknown;
}

/** 命令返回（宿主 `CommandResult` 的结构化子集）。 */
export interface CommandResultLike {
  kind: "success" | "error";
  text?: string;
}

/** 命令注册面：记下定义，便于从测试侧调 handler。 */
export interface CommandSurface {
  definitions: CommandDefinitionLike[];
  /** 注册时拿到的 disposer 被调用了几次。 */
  disposed: number;
  /** 调已注册命令的 handler（缺省空输入 = `status`）。 */
  invoke(rawInput?: string): Promise<CommandResultLike>;
}

/** 模拟 TUI 人工面板（注册在插件之后，模拟宿主装载顺序）。 */
export interface Panel {
  calls: number;
  /** `reject` = 返回 rejected；`throw` = 抛错（模拟下一位不可用）。 */
  behavior: "reject" | "throw";
}

/** 装配结果。 */
export interface Assembled {
  host: FakeHost;
  service: AutoApproveService;
  llm: FakeLlm;
  memory: ReturnType<typeof createFakeMemory>;
  sessionPaths: ReturnType<typeof createFakeSessionPaths>;
  commands: CommandSurface;
  panel: Panel;
  /** 假 `tools/pre-execute` 的 next 被调次数（判断是否提前终结）。 */
  toolsNext: { calls: number };
  /** 会话审计根目录（`<root>/<sessionId>/auto-approve-audit.jsonl`）。 */
  root: string;
  /** 临时项目目录（会话 cwd；可放 `AGENTS.md`）。 */
  project: string;
  /** 假宿主里的 agent（带会话与 cwd）。 */
  agent: { id: string; session: { id: string; header: { cwd: string } } };
  /** 走 `approval/request` waterfall（未命中落到模拟面板）。 */
  approval(req: ApprovalRequestLike): Promise<ApprovalOutcome>;
  /** 走 `tools/pre-execute` waterfall（未命中落到 `{kind:"allow"}`）。 */
  preExecute(exec: PreExecuteExecution): Promise<PreToolDecision>;
  /** 发一条 `session/event`。 */
  sessionEvent(session: unknown, event: unknown): void;
  dispose(): void;
}

/** 装配选项。 */
export interface AssembleOptions {
  config?: Config;
  /** 去掉假 `commands` 服务（断言命令面缺席路径）。 */
  withCommands?: boolean;
  /** 去掉假 `sessionPaths` 服务（断言审计降级路径）。 */
  withSessionPaths?: boolean;
  /** 去掉假 `memory` 服务（断言项目那份跳过）。 */
  withMemory?: boolean;
  /** LLM 流文本（缺省一段 low + allow）。 */
  llmText?: string;
  /** 额外服务（`agents` / `sessions` / `sessionQuery` 等）。 */
  services?: Record<string, unknown>;
}

/** 装配本包 `apply` 与宿主接线。 */
export function assemble(options: AssembleOptions = {}): Assembled {
  const root = tempDir();
  const project = tempDir();
  const sessionPaths = createFakeSessionPaths(root);
  const memory = createFakeMemory();
  const llm = createFakeLlm(
    reviewChunks(options.llmText ?? '{"risk":"low","decision":"allow"}'),
  );
  const commands: CommandSurface = {
    definitions: [],
    disposed: 0,
    async invoke(rawInput): Promise<CommandResultLike> {
      const definition = commands.definitions[0];
      if (definition?.handler === undefined) {
        throw new Error("没有已注册的命令");
      }
      const result = await definition.handler(
        rawInput === undefined ? {} : { rawInput },
      );
      return result as CommandResultLike;
    },
  };
  const services: Record<string, unknown> = {
    llm,
    ...(options.services ?? {}),
  };
  if (options.withSessionPaths !== false)
    services["sessionPaths"] = sessionPaths;
  if (options.withMemory !== false) services["memory"] = memory;
  if (options.withCommands !== false) {
    services["commands"] = {
      register(definition: unknown): () => void {
        commands.definitions.push(definition as CommandDefinitionLike);
        return () => {
          commands.disposed += 1;
        };
      },
    };
  }
  const host = createFakeHost(services);
  const dispose = apply(host as unknown as PluginHost, options.config);
  const provided = host.provided.get("autoApprove");
  if (provided === undefined) {
    throw new Error("apply 没有提供 autoApprove 服务");
  }
  const panel: Panel = { calls: 0, behavior: "reject" };
  // 面板注册在插件之后：立案顺序即宿主装载顺序（本插件先裁，未命中调 next 到面板）
  host.on("approval/request", (async () => {
    panel.calls += 1;
    if (panel.behavior === "throw") throw new Error("下一位应答者不可用");
    return "rejected";
  }) as never);
  const agent = {
    id: "agent-1",
    session: { id: "s1", header: { cwd: project } },
  };
  const toolsNext = { calls: 0 };
  return {
    host,
    service: provided as AutoApproveService,
    llm,
    memory,
    sessionPaths,
    commands,
    panel,
    toolsNext,
    root,
    project,
    agent,
    approval(req) {
      return host.waterfall(
        "approval/request",
        req,
        () => "unavailable",
      ) as Promise<ApprovalOutcome>;
    },
    preExecute(exec) {
      return host.waterfall("tools/pre-execute", exec, () => {
        toolsNext.calls += 1;
        return { kind: "allow" };
      }) as Promise<PreToolDecision>;
    },
    sessionEvent(session, event) {
      host.emit("session/event", session, event);
    },
    dispose,
  };
}

/** 一次审批请求（缺省 bash + 假 agent）。 */
export function approvalRequest(
  assembled: Assembled,
  overrides: Partial<ApprovalRequestLike> = {},
): ApprovalRequestLike {
  return {
    toolName: "bash",
    callId: "c1",
    agent: assembled.agent,
    ...overrides,
  };
}

/** 一次工具执行（`tools/pre-execute` 的载荷）。 */
export function preExecuteExecution(
  assembled: Assembled,
  overrides: Partial<PreExecuteExecution> = {},
): PreExecuteExecution {
  return {
    name: "bash",
    arguments: '{"command":"ls"}',
    callId: "c1",
    agent: assembled.agent,
    ...overrides,
  };
}

/** `session/event`：观测到一次工具调用（补齐审批请求拿不到的参数）。 */
export function toolCallEvent(
  callId: string,
  name: string,
  args: string,
): { type: string; data: unknown } {
  return {
    type: "tool/call",
    data: { callId, name, arguments: args },
  };
}

/** `session/event`：观测到一次请求头（提供 LLM 审查的模型路由）。 */
export function requestHeaderEvent(
  provider: string,
  model: string,
): { type: string; data: unknown } {
  return {
    type: "request/header",
    data: { header: { config: { provider, model } } },
  };
}

/** 会话对象（`session/event` 的第一个参数）。 */
export function sessionOf(
  assembled: Assembled,
  id = "s1",
): { id: string; header: { cwd: string } } {
  return { id, header: { cwd: assembled.project } };
}

/** 等一轮微任务，让项目那份审计行（异步 `put`）落地。 */
export async function flushAudit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 命令名（供断言引用，避免测试里写死字符串）。 */
export { COMMAND_NAME };
