/**
 * agent-group 插件入口（DSH bundle 接入面）：**跨会话协调层** —— 组、成员、主从连接（含等级）、
 * 指令与回报；不采样、不聚合，也不建也不销毁会话（决策项 16 / 19）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（`export { name, Config, apply }`）：
 * - 依赖走**可选读取**（不写进 `inject`）：`sessionChannel`（传输）与 `sessionPaths`
 *   （组状态落管理者会话目录）；任一不可用 → **不注册工具 + 一次警告**（2026-10-17 裁定）。
 *   理由：硬 `inject` 会让「依赖没挂」直接拦住本包加载，而本包的降级语义正是「没传输就不提供工具」。
 * - `memory-base`（`memory` 服务）可选：每次组状态变更后把只读视图镜像进去（`kind: "agent_group"`），
 *   失败只计数 + 一次日志、不重试。
 * - `apply(ctx, config)`：注册单个工具 `agent_group`（`action` 分派 7 个动作）。
 *
 * 状态落点：`<管理者会话目录>/agent-group.json`（原子写、0600），经
 * `sessionPaths.sessionDirFor(managerSessionId)` 推导。
 */

import { GroupService, describe, resolveConfig } from "./core.ts";
import { pruneUndefined } from "./json.ts";
import { failure, isFailure } from "./model.ts";
import { MemoryBaseMirror, isMemoryFace } from "./mirror.ts";
import { FileBookStore } from "./store.ts";
import {
  createSessionChannelTransport,
  isSessionChannelFace,
} from "./transport.ts";
import type {
  AgentGroupConfig,
  GroupFailure,
  ResolvedConfig,
} from "./types.ts";

export { MANAGER_NAME } from "./model.ts";
export { GroupService, resolveConfig, verdictOf } from "./core.ts";
export {
  MemoryBookStore,
  FileBookStore,
  StateUnavailableError,
} from "./store.ts";
export { createSessionChannelTransport } from "./transport.ts";
export { groupView, invariantViolations } from "./model.ts";
export type * from "./types.ts";

/** bundle 条目 id（与 cordis.patch.yml / profile 层一致）。 */
export const name = "agent-group";

/** 插件配置（`Config` 为宿主透传形态，字段见 `AgentGroupConfig`）。 */
export type Config = AgentGroupConfig;

/** 工具定义（测试用最小形态）。 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  output: {
    schema: Record<string, unknown>;
    render: (
      args: unknown,
      value: unknown,
    ) => Array<{
      type: string;
      text: string;
    }>;
  };
}

/** 结构化宿主 ctx（最小 DSH cordis 形态）。 */
export interface BundleHost {
  logger?(ns: string): { info(message: string): void };
  get?(key: string): unknown;
  tools?: { register(def: unknown): unknown };
  [key: string]: unknown;
}

/**
 * 读服务面（`ctx.get` 优先，退化到直接属性；任何读取失败都按「服务缺失」处理）。
 *
 * 两条读取路径都要防护：cordis 对**未 inject** 的服务做**属性读取**会直接抛
 * `cannot get property "<name>" without inject`（实测：重启后加载即栈顶落在这里）。
 * 本包故意不写 `inject`（可选读取口径），所以回退路径必须自吞异常，否则「没挂
 * session-channel」的进程会整包加载失败，而不是按设计「不注册工具 + 一次警告」。
 */
function readService(ctx: BundleHost, key: string): unknown {
  try {
    if (typeof ctx.get === "function") {
      const value = ctx.get(key);
      if (value !== undefined && value !== null) return value;
    }
  } catch {
    /* ctx.get 不可用：继续走属性读取 */
  }
  try {
    return ctx[key];
  } catch {
    /* 未声明的服务（cordis 抛错）→ 按缺失处理 */
    return undefined;
  }
}

/** 调用方会话 id（宿主在 `exec.agent.session` 传入）。 */
export function callerSessionIdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { id?: unknown } } })?.agent;
  return typeof agent?.session?.id === "string" ? agent.session.id : undefined;
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text === "string") return text;
  } catch {
    /* 循环引用 / BigInt：落到 String 兜底 */
  }
  try {
    return String(value);
  } catch {
    return "（无法序列化的值）";
  }
}

/**
 * `agent_group` 工具定义（`action` 分派；返回体过一遍 lossless JSON 归一）。
 *
 * 入参是**服务解析器**而不是服务实例：注册在 apply 期同步完成（工具表在 agent 创建时
 * 定稿），`sessionChannel` / `sessionPaths` 在 execute 时才解析；服务缺失返回
 * `session_channel_unavailable` / `session_paths_unavailable`（带原因 + 下一步）。
 */
export function toToolDef(
  resolveService: () => Promise<GroupService | GroupFailure>,
): ToolDef {
  return {
    name: "agent_group",
    description:
      "同事模型群组的编排（跨会话协调层）：create_group 建组（管理者 = 调用方会话）；" +
      "add_member 加成员（group / name / target，target = 会话 id 或别名，须在线）；" +
      "link 建立主从连接（group / from / to；从方须是自由代理，等级 = 主方 + 1）；" +
      "send 发指令（group / to / text / timeoutMs；每条主从连接同时只允许一条未结）；" +
      "check 懒判定结算（group / to?；成功 / 失败 / 受阻 / 超时）；" +
      "remove 移除成员（group / name；非叶子被拒并列出剩余从代理）；" +
      "status 只读查看（group）。所有拒绝都带原因与下一步；" +
      "依赖（session-channel / session-paths）在调用时解析，服务缺失会返回带原因的错误。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "create_group",
            "add_member",
            "link",
            "send",
            "check",
            "remove",
            "status",
          ],
        },
        group: { type: "string", description: "组名（create_group 缺省自取）" },
        name: {
          type: "string",
          description: "add_member / remove 用：组内名字",
        },
        target: {
          type: "string",
          description: "add_member 用：会话 id 或别名（须唯一命中且在线）",
        },
        from: { type: "string", description: "link 用：主方组内名字" },
        to: {
          type: "string",
          description: "link / send / check 用：从方（成员）组内名字",
        },
        text: { type: "string", description: "send 用：指令正文" },
        timeoutMs: {
          type: "number",
          description:
            "send 用：等待上限毫秒（缺省 30 分钟；超时按 check 时懒判定）",
        },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>, exec?: unknown) {
      const caller = callerSessionIdOf(exec);
      if (caller === undefined || caller === "") {
        return failure(
          "no_caller",
          "无法确定调用方会话（exec.agent.session.id 缺失）",
          "由 agent 会话调用本工具；服务面 / 无 exec 的调用方没有「管理者」身份",
        );
      }
      const action = typeof args.action === "string" ? args.action : "";
      const service = await resolveService();
      if (isFailure(service)) {
        return pruneUndefined({ ...service, action }) as Record<
          string,
          unknown
        >;
      }
      const result = await service.run(action, args, caller);
      return pruneUndefined(result) as Record<string, unknown>;
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/**
 * 惰性服务解析：**注册期不碰** `sessionChannel` / `sessionPaths`。
 *
 * 真机实测（2026-10-17）：这两个服务都晚于本包激活，注册期读不到；而工具表在 agent
 * 创建时就已定稿 —— 注册若被推到「服务就绪之后」，工具**永远进不了工具表**（新进程里
 * `/tools agent_group` 为 0）。故注册在 apply 期同步做，服务改在每次 execute 时解析；
 * 失败不缓存（服务晚到也能自愈），成功才缓存。
 */
export function createLazyGroupService(
  ctx: BundleHost,
  config: ResolvedConfig,
  log: (message: string) => void,
): () => Promise<GroupService | GroupFailure> {
  let cached: GroupService | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    const channel = readService(ctx, "sessionChannel");
    if (!isSessionChannelFace(channel)) {
      return failure(
        "session_channel_unavailable",
        "session-channel 服务不可用（缺 delegate / taskStatus）",
        "在 profile 里挂上 session-channel 后重启 dsh（群组编排靠它投递指令与收取回报）",
      );
    }
    const paths = readService(ctx, "sessionPaths");
    const pathsFace =
      typeof paths === "object" && paths !== null
        ? (paths as { sessionDirFor?: unknown })
        : undefined;
    if (typeof pathsFace?.sessionDirFor !== "function") {
      return failure(
        "session_paths_unavailable",
        "session-paths 服务不可用（缺 sessionDirFor）",
        "在 profile 里挂上 session-paths 后重启 dsh（组状态落管理者会话目录）",
      );
    }
    const sessionDirFor = pathsFace.sessionDirFor.bind(paths);
    const sessions = readService(ctx, "sessions") as
      | { get?(id: string): { header?: { cwd?: string } } | undefined }
      | undefined;
    const memory = readService(ctx, "memory");
    const mirror =
      config.mirror && isMemoryFace(memory)
        ? new MemoryBaseMirror(memory, (sessionId) => {
            try {
              const session = sessions?.get?.(sessionId);
              const cwd = session?.header?.cwd;
              return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
            } catch {
              return undefined;
            }
          })
        : undefined;
    cached = new GroupService({
      store: new FileBookStore(
        (managerSessionId) => sessionDirFor(managerSessionId),
        config.stateFileName,
      ),
      transport: createSessionChannelTransport(channel),
      ...(mirror === undefined ? {} : { mirror }),
      config,
      log,
    });
    return cached;
  };
}

/**
 * 挂载（宿主按 bundle 契约调用；不抛）：**apply 期同步注册工具**，依赖在 execute 时解析。
 *
 * 为什么不在注册期做依赖门禁：`sessionChannel` / `sessionPaths` 晚于本包激活，注册期
 * 读不到；把它们当注册前置会把注册推到 agent 创建之后，工具表不收录（真机实测）。
 * 依赖缺失改为调用期错误（带原因 + 下一步），仍守「缺依赖不静默」的口径。
 */
export function apply(
  ctx: BundleHost = {},
  config: AgentGroupConfig = {},
): void {
  const warn = (message: string): void => {
    // `logger` 同样是宿主属性：未声明时读取会抛，故一并兜住，失败退回 stderr。
    try {
      const logger = ctx.logger?.(name);
      if (logger !== undefined && typeof logger.info === "function") {
        logger.info(message);
        return;
      }
    } catch {
      /* 退回 stderr */
    }
    process.stderr.write(`[${name}] ${message}\n`);
  };
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return;

  // 走 `readService` 而不是 `ctx.tools`：未 inject 的属性读取在 cordis 下会抛错。
  const tools = readService(ctx, "tools") as
    { register?(def: unknown): unknown } | undefined;
  if (tools === undefined || typeof tools.register !== "function") {
    warn("tools 未挂载：agent_group 工具不可用");
    return;
  }
  const resolveService = createLazyGroupService(ctx, resolved, warn);
  try {
    tools.register(toToolDef(resolveService));
  } catch (error) {
    warn(`agent_group 工具注册失败：${describe(error)}`);
  }
}
