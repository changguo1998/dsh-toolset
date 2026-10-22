/**
 * agent-group 插件入口（DSH bundle 接入面）：**跨会话协调层** —— 组、成员、主从连接（含等级）、
 * 指令与回报；不采样、不聚合，也不建也不销毁会话（决策项 16 / 19）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（`export { name, inject, Config, apply }`）：
 *
 * **依赖分两层**（2026-10-19 真机修正，推翻 2026-10-17「不写 inject」的裁定）：
 * - `inject = ["tools"]`：注册面是**必需**依赖 —— 宿主 base 在 agent 创建前就 provide `tools`，
 *   声明后 cordis 会把本插件的激活排到它就绪之后；不声明则 apply 期读不到工具表，工具**永远
 *   进不了表**（真机实测：新起会话里根本没有 `agent_group`）。
 * - `sessionChannel` / `sessionPaths` / `memory` / `sessions`：**可选**依赖，由兄弟 bundle 在
 *   各自 fiber `provide`，未 inject 时 `ctx.get` 读不到（cordis 4.0.5 实测）。故用
 *   `ctx.inject([...], cb)` 开**子分叉**按需绑定：工具仍在 apply 期同步注册，服务晚到也能自愈。
 * - 任一必需服务不可用 → 调用期错误（`session_channel_unavailable` /
 *   `session_paths_unavailable`，带原因 + 下一步），工具本身照常已注册。
 * - `memory-base`（`memory` 服务）可选：每次组状态变更后把只读视图镜像进去（`kind: "agent_group"`），
 *   失败只计数 + 一次日志、不重试。
 * - `apply(ctx, config)`：注册单个工具 `agent_group`（`action` 分派 11 个动作）与只读服务面 `agentGroup`。
 *
 * 状态落点：`<管理者会话目录>/agent-group.json`（原子写、0600），经
 * `sessionPaths.sessionDirFor(managerSessionId)` 推导。
 */

import {
  GroupService,
  describe,
  readGroupStatus,
  resolveConfig,
} from "./core.ts";
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
  GroupView,
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

/**
 * 静态依赖：只有注册面 `tools`。
 *
 * 宿主 base 在 agent 创建前就 provide 它 —— 声明后本插件的激活会排在它之后，`apply` 里才能
 * 读到工具表；不声明时 cordis 4.0.5 下 `ctx.get("tools")` 读到 `undefined`，工具**永远注册
 * 不上**（2026-10-19 真机实测：新起会话的工具表里没有 `agent_group`）。其余四个服务由兄弟
 * bundle 提供，走 `ctx.inject` 动态分叉（见 `bindOptionalServices`）。
 */
export const inject = ["tools"];

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
 * 本包的 `inject` 只声明 `["tools"]`（注册面必需），其余服务（`sessionChannel` /
 * `sessionPaths` / `memory` / `sessions`）都是可选读取，所以回退路径必须自吞异常，
 * 否则「没挂 session-channel」的进程会因读服务抛错而整包加载失败。
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
      "link_peer 建立平等连接（group / from / to；双向、无等级、每对这种连接各至多一条）；" +
      "send 发指令（group / to / text / timeoutMs；每条主从连接同时只允许一条未结）；" +
      "send_peer 经平等连接发消息（group / to / text；发完即走，无未结指令）；" +
      "broadcast 广播（group / text / to?；按当前成员集合逐条发送并汇总送达与失败）；" +
      "check 懒判定结算（group / to?；成功 / 失败 / 受阻 / 超时）；" +
      "remove 移除成员（group / name；非叶子被拒并列出剩余从代理）；" +
      "close_group 关闭组（group；仅组长可关，未结指令终止、连接关系关闭、不连带关成员）；" +
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
            "link_peer",
            "send",
            "send_peer",
            "broadcast",
            "check",
            "remove",
            "close_group",
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
        from: {
          type: "string",
          description: "link / link_peer 用：主方 / 平等连接一方组内名字",
        },
        to: {
          type: "string",
          description:
            "link / link_peer / send / send_peer / check 用：从方（成员）组内名字；broadcast 用：目标子集（逗号 / 空格分隔，缺省全部非管理者成员）",
        },
        text: {
          type: "string",
          description: "send / send_peer / broadcast 用：指令或消息正文",
        },
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

/** 可选依赖的绑定槽：由 `ctx.inject` 分叉写入，服务被卸载时清空。 */
export interface GroupServiceBindings {
  channel?: unknown;
  paths?: unknown;
  sessions?: unknown;
  memory?: unknown;
}

/** `ctx.inject` 的结构面（cordis 把 registry 方法混到 ctx 上；服务面 / 测试宿主没有）。 */
interface InjectFace {
  inject?(
    deps: string[],
    callback: (child: BundleHost) => (() => void) | void,
  ): unknown;
}

/** 读 `ctx.inject`：属性读取在 cordis 下对未声明的键会抛（同 `readService` 的理由）。 */
function readInject(ctx: BundleHost): InjectFace["inject"] {
  try {
    const value = (ctx as InjectFace).inject;
    return typeof value === "function" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 读 `ctx.provide`：未声明时属性读取会抛，静默按「无提供面」处理（宿主无 provide 属正常）。 */
function readProvide(
  ctx: BundleHost,
): ((name: string, value: unknown) => unknown) | undefined {
  try {
    const value = (ctx as { provide?: unknown }).provide;
    return typeof value === "function"
      ? (value as (name: string, value: unknown) => unknown)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 绑定**可选**依赖（`sessionChannel` / `sessionPaths` / `sessions` / `memory`）。
 *
 * 为什么不写进静态 `inject`：这四个服务都由兄弟 bundle 在各自 fiber 里 `provide`，声明进
 * 静态 `inject` 会把本插件的激活推到它们就绪之后 —— 而工具表在 agent 创建时定稿，工具就会
 * 进不了表（2026-10-17 真机结论的这一半仍然成立）。改用 `ctx.inject([...], cb)` 开**子分叉**：
 * 父插件照常激活并注册工具，子分叉在依赖到位时把服务写进 `bindings`，服务卸载时清空。
 *
 * 宿主没有 `ctx.inject`（纯服务面 / 单测假宿主）时直接返回，解析退回 `readService` 直读。
 */
export function bindOptionalServices(
  ctx: BundleHost,
  bindings: GroupServiceBindings,
  log: (message: string) => void,
): void {
  const inject = readInject(ctx);
  if (inject === undefined) return;

  const watch = (
    deps: string[],
    assign: (child: BundleHost) => void,
    clear: () => void,
  ): void => {
    try {
      inject.call(ctx, deps, (child) => {
        assign(child);
        return clear;
      });
    } catch (error) {
      log(`服务注入失败（${deps.join(" / ")}）：${describe(error)}`);
    }
  };

  watch(
    ["sessionChannel", "sessionPaths"],
    (child) => {
      bindings.channel = readService(child, "sessionChannel");
      bindings.paths = readService(child, "sessionPaths");
    },
    () => {
      bindings.channel = undefined;
      bindings.paths = undefined;
    },
  );
  watch(
    ["sessions"],
    (child) => {
      bindings.sessions = readService(child, "sessions");
    },
    () => {
      bindings.sessions = undefined;
    },
  );
  watch(
    ["memory"],
    (child) => {
      bindings.memory = readService(child, "memory");
    },
    () => {
      bindings.memory = undefined;
    },
  );
}

/** 读一个可选依赖：**注入分叉优先**，没有再退回直读（服务面宿主 / 假宿主可用）。 */
function boundOrDirect(
  bindings: GroupServiceBindings,
  key: keyof GroupServiceBindings,
  ctx: BundleHost,
  service: string,
): unknown {
  const bound = bindings[key];
  return bound === undefined ? readService(ctx, service) : bound;
}

/**
 * 惰性服务解析：**注册期不碰**任何可选服务，第一次 execute 才解析。
 *
 * 两条读取路径：`bindOptionalServices` 的注入分叉优先（真机主路径），其次 `readService` 直读
 * （宿主没有 `ctx.inject`，或分叉还没就绪）。解析成功才缓存 —— `GroupService` 里带着状态缓存
 * 与串行锁，必须是**单实例**；失败不缓存，服务晚到下一次调用自愈。
 */
export function createLazyGroupService(
  ctx: BundleHost,
  config: ResolvedConfig,
  log: (message: string) => void,
  bindings: GroupServiceBindings = {},
): () => Promise<GroupService | GroupFailure> {
  let cached: GroupService | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    const channel = boundOrDirect(bindings, "channel", ctx, "sessionChannel");
    if (!isSessionChannelFace(channel)) {
      return failure(
        "session_channel_unavailable",
        "session-channel 服务不可用（缺 delegate / taskStatus）",
        "在 profile 里挂上 session-channel 后重启 dsh（群组编排靠它投递指令与收取回报）",
      );
    }
    const paths = boundOrDirect(bindings, "paths", ctx, "sessionPaths");
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
    const sessions = boundOrDirect(bindings, "sessions", ctx, "sessions") as
      | { get?(id: string): { header?: { cwd?: string } } | undefined }
      | undefined;
    const memory = boundOrDirect(bindings, "memory", ctx, "memory");
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

/** `provide: ["agentGroup"]`：只读服务面（`status(sessionId, group?)`）供 TUI 等展示层
 *  读组状态（`ctx.get("agentGroup")`）；只读、不落盘、不镜像，缺 `sessionPaths` → 信封错误。 */
export const provide = ["agentGroup"];

/** 只读服务面（TUI `/group` 消费的结构面；方法风格对齐 `GroupFailure` 信封）。 */
export interface AgentGroupReadService {
  status(
    managerSessionId: string,
    groupName?: string,
  ): Promise<
    | {
        ok: true;
        groups: Array<{
          name: string;
          view: GroupView;
          memberStates?: import("./types.ts").MemberStateView[];
        }>;
      }
    | GroupFailure
  >;
}

/** 按绑定槽构造只读服务：`sessionPaths` 惰解析缺失 → `session_paths_unavailable` 信封。 */
function createReadService(
  ctx: BundleHost,
  bindings: GroupServiceBindings,
  config: ResolvedConfig,
): AgentGroupReadService {
  const channel = boundOrDirect(bindings, "channel", ctx, "sessionChannel");
  const transport =
    typeof channel === "object" &&
    channel !== null &&
    isSessionChannelFace(channel)
      ? createSessionChannelTransport(channel)
      : undefined;
  return {
    async status(managerSessionId, groupName) {
      const paths = boundOrDirect(bindings, "paths", ctx, "sessionPaths");
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
      const store = new FileBookStore(
        (managerSessionId_: string) => sessionDirFor(managerSessionId_),
        config.stateFileName,
      );
      return readGroupStatus(store, managerSessionId, groupName, {
        stuckAfterMs: config.stuckAfterMs,
        ...(transport === undefined ? {} : { memberLookup: transport }),
      });
    },
  };
}

/**
 * 挂载（宿主按 bundle 契约调用；不抛）：**apply 期同步注册工具**，可选依赖在 execute 时解析。
 *
 * 注册面 `tools` 写进静态 `inject`（必需依赖，宿主 base 在 agent 创建前提供）；其余四个服务
 * 走 `ctx.inject` 分叉绑定，避免把激活推到它们就绪之后（工具会进不了表）。
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

  // 走 `readService` 而不是 `ctx.tools`：属性读取在 cordis 下对未 inject 的服务会抛错。
  const tools = readService(ctx, "tools") as
    { register?(def: unknown): unknown } | undefined;
  if (tools === undefined || typeof tools.register !== "function") {
    warn("tools 未挂载：agent_group 工具不可用");
    return;
  }
  const bindings: GroupServiceBindings = {};
  bindOptionalServices(ctx, bindings, warn);
  const resolveService = createLazyGroupService(ctx, resolved, warn, bindings);
  try {
    tools.register(toToolDef(resolveService));
  } catch (error) {
    warn(`agent_group 工具注册失败：${describe(error)}`);
  }
  // 只读服务面：provide 是宿主属性，未声明时读取会抛 → 经 readProvide 静默跳过（无提供面属正常）。
  const provideFn = readProvide(ctx);
  if (provideFn !== undefined) {
    try {
      provideFn.call(
        ctx,
        "agentGroup",
        createReadService(ctx, bindings, resolved),
      );
    } catch (error) {
      warn(`agentGroup 只读服务注册失败：${describe(error)}`);
    }
  }
}
