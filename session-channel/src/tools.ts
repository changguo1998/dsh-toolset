// session-channel/src/tools.ts — session-channel 的工具面（四个模型可见工具的定义与出口归一）。
//
// 工具：`session_channel`（消息 / 别名 / 忙闲 / 状态）、`channel_delegate`（委托任务）、
// `channel_task`（任务管理）、`channel_task_result`（worker 显式回传）。
// 行为契约见包 README；服务实现在 `session-channel/src/service.ts`，任务层在 `session-channel/src/task-layer.ts`。

import type { SessionChannelService } from "./service.ts";
import type { TaskRecord } from "./types.ts";

/**
 * JSON 文本（render 必须全函数，`text` 恒为 string）：字符串原样返回（避免二次编码），
 * 其余 `JSON.stringify(value, null, 2)`；`undefined` / 函数 / symbol 结果为非字符串，
 * 循环引用 / BigInt 直接抛错——两种情况退化为 `String(value)`，`String` 仍抛则给占位。
 */
function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text === "string") return text;
  } catch {
    // 循环引用 / BigInt：序列化抛错，落到下方 String 兜底
  }
  try {
    return String(value);
  } catch {
    return "（无法序列化的值）";
  }
}

/**
 * 是否平凡对象（`Object.prototype` 或 null 原型）：宿主对工具返回体做 lossless JSON 校验，
 * 带自定义原型的对象同样被判非法，故归一只重建平凡对象，其余原样返回（不改语义）。
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * 工具返回体归一为 lossless JSON（决策项 7 选 a，缺陷「工具返回体含 `undefined` 字段」）：
 * 宿主在序列化**之前**用 `walkJsonValue` 校验工具返回体，嵌套 `undefined`（以及 `NaN` /
 * `Infinity` / `-0` / 非平凡原型）一律抛 `INVALID_TOOL_OUTPUT`——`JSON.stringify` 会丢掉
 * 值为 `undefined` 的键，救不了这条校验。
 *
 * 递归去掉值为 `undefined` 的键；数组里的 `undefined` 视同编程错误，按等价语义**剔除该元素**
 * （本包返回体不产这种元素，剔除只为保证出口恒合法）。`null` / `false` / `0` / `""` 保留；
 * 其余非法值不在归一范围（返回体全部来自 Redis 里的 JSON，不会出现）。
 */
export function toLosslessJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item: unknown) => item !== undefined)
      .map((item: unknown) => toLosslessJson(item)) as T;
  }
  if (value === null || typeof value !== "object" || !isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = toLosslessJson(item);
  }
  return out as T;
}

interface ToolDefShape {
  execute: (...args: never[]) => unknown;
  [key: string]: unknown;
}

/**
 * `toLosslessJson` 的别名（合并 `feat/peer-group` 与 `feat/session-channel` 时统一出口）：
 * 两个分支各自实现过一份归一，保留此名以兼容既有调用点与测试。
 */
export const pruneUndefined = toLosslessJson;

/**
 * 给工具定义的 `execute` 出口包一层 `toLosslessJson`（决策项 7 选 a）：可选字段散在
 * `broker.ts` / `service.ts` / `types.ts` 多处（`delivered` / `candidates` / `holder` /
 * `replaced` / `TaskRecord` 的六个可选字段），逐处拼装是「每次新增可选字段都要记得拼一次」
 * 的长期负担；出口收口一处，漏一处也不会再报 `INVALID_TOOL_OUTPUT`。
 */
export function withLosslessOutput<T extends ToolDefShape>(def: T): T {
  const run = def.execute;
  return {
    ...def,
    async execute(...args: never[]): Promise<unknown> {
      return toLosslessJson(await run.apply(def, args));
    },
  };
}

/** `session-channel` 工具定义（action 分派）。 */
export function toToolDef(service: SessionChannelService) {
  return {
    name: "session_channel",
    description:
      "用途: 跨会话消息通道(本机专用 Redis), 列会话、发消息、查收件箱、管别名。\n" +
      "用法: peers 列在线会话; send 发消息到目标会话; inbox 查某会话最近收到的消息(只读); state 查某会话的 agent 忙闲(idle/running + 转换时刻 at, 也可作为跨会话通知的派发通道); alias 管会话别名(op=set/list/clear, name=别名, to 缺省为调用方所在会话); status 查连接与已跟踪会话。\n" +
      "边界: 发消息用本工具(action=send); 让另一个会话执行任务并回收结果用 channel_delegate。\n" +
      "相关: channel_delegate、channel_task、coagent。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["peers", "send", "inbox", "state", "alias", "status"],
          description:
            "peers 列在线会话; send 发消息; inbox 查收件箱; state 查忙闲; alias 管别名; status 查连接与已跟踪会话",
        },
        to: {
          type: "string",
          description:
            "send 用：目标会话 id、别名（alias set 登记的名字），或 cwd:<绝对路径>（须唯一命中）",
        },
        text: { type: "string", description: "send 用：正文（≤ 8 KB）" },
        waitMs: {
          type: "number",
          description: "send 用：等待「已注入」回执的毫秒数（缺省不等）",
        },
        sessionId: {
          type: "string",
          description: "inbox / state 用：目标会话 id",
        },
        op: {
          type: "string",
          enum: ["set", "list", "clear"],
          description: "alias 用：set 设别名 / list 列别名 / clear 清别名",
        },
        name: {
          type: "string",
          description: "alias 用：别名（1-32 位 [A-Za-z0-9_-]，非保留字）",
        },
        force: {
          type: "boolean",
          description: "alias set 用：别名被别人占用时是否覆盖（缺省 false）",
        },
        count: { type: "number", description: "inbox 用：返回条数（缺省 20）" },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>, exec?: unknown) {
      const action = String(args.action ?? "");
      // 调用方所在会话（宿主在 exec.agent.session 传入；非 agent 调用方 → undefined）
      const callerAgent = (exec as { agent?: { session?: { id?: unknown } } })
        ?.agent;
      const callerSessionId =
        typeof callerAgent?.session?.id === "string"
          ? callerAgent.session.id
          : "";
      switch (action) {
        case "peers":
          return service.peers();
        case "send": {
          const to = String(args.to ?? "");
          const text = String(args.text ?? "");
          if (to === "" || text === "")
            return { ok: false, error: "send 需要 to 与 text" };
          const waitMs =
            typeof args.waitMs === "number" ? args.waitMs : undefined;
          return service.send({ to, text, waitMs, from: callerSessionId });
        }
        case "inbox": {
          const sessionId = String(args.sessionId ?? "");
          if (sessionId === "")
            return { ok: false, error: "inbox 需要 sessionId" };
          const count = typeof args.count === "number" ? args.count : 20;
          return service.inbox(sessionId, count);
        }
        case "state": {
          const sessionId = String(args.sessionId ?? "");
          if (sessionId === "")
            return { ok: false, error: "state 需要 sessionId" };
          return service.statusOf(sessionId);
        }
        case "alias": {
          const op = String(args.op ?? "list");
          const name = String(args.name ?? "");
          const to = String(args.to ?? "") || callerSessionId;
          if (op === "list") return service.aliasList();
          if (op === "set") {
            if (name === "" || to === "")
              return {
                ok: false,
                error:
                  "alias set 需要 name；to 缺省为调用方会话（非 agent 调用方须显式传 to）",
              };
            return service.aliasSet(name, to, { force: args.force === true });
          }
          if (op === "clear") {
            return service.aliasClear({
              alias: name === "" ? undefined : name,
              sessionId:
                String(args.to ?? "") === "" && callerSessionId === ""
                  ? undefined
                  : to === ""
                    ? undefined
                    : to,
            });
          }
          return {
            ok: false,
            error: `未知 alias op: ${op}（须为 set|list|clear）`,
          };
        }
        case "status":
          return service.status();
        default:
          return { error: `未知 action: ${action}` };
      }
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** 调用方会话 id（宿主在 `exec.agent.session` 传入；非 agent 调用方 → undefined）。 */
function callerSessionIdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { id?: unknown } } })?.agent;
  return typeof agent?.session?.id === "string" ? agent.session.id : undefined;
}

/** `channel_delegate` 工具：把任务委托给另一个会话（planner-worker）。 */
export function toDelegateTool(service: SessionChannelService) {
  return {
    name: "channel_delegate",
    description:
      "用途: 把一个任务委托给本机另一个会话执行并回收结果(planner-worker 语义)。\n" +
      "用法: 任务正文作为一条 [CHANNEL] 消息注入目标会话的下一回合; 返回 task_id, 用 channel_task 查状态 / 列任务 / 取消。\n" +
      "效果: worker 本轮结束时会自动回传最终回答; worker 也可调用 channel_task_result 显式回传, 显式优先。\n" +
      "边界: 只传话不委托执行用 session_channel(action=send); 在当前会话拉起常驻同事用 coagent。\n" +
      "相关: channel_task、channel_task_result、session_channel、coagent。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        to: {
          type: "string",
          description: "目标：会话 id、别名，或 cwd:<绝对路径>（须唯一命中）",
        },
        task: { type: "string", description: "任务正文（≤ 8 KB）" },
        timeoutSec: {
          type: "number",
          description: "超时秒数（缺省 1800；超时按读取时懒判定）",
        },
        waitMs: {
          type: "number",
          description: "等待「已注入」回执的毫秒数（缺省不等）",
        },
      },
      required: ["to", "task"],
    },
    async execute(args: Record<string, unknown>, exec?: unknown) {
      const result = await service.delegate({
        ...(callerSessionIdOf(exec) === undefined
          ? {}
          : { from: callerSessionIdOf(exec)! }),
        to: String(args.to ?? ""),
        text: String(args.task ?? ""),
        ...(typeof args.timeoutSec === "number"
          ? { timeoutSec: args.timeoutSec }
          : {}),
        ...(typeof args.waitMs === "number" ? { waitMs: args.waitMs } : {}),
      });
      return result;
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** `channel_task` 工具：查委托状态 / 列委托任务 / 取消委托。 */
export function toTaskTool(service: SessionChannelService) {
  return {
    name: "channel_task",
    description:
      "用途: 委托任务管理(channel_delegate 建的任务), 查委托状态、列委托任务、取消委托。\n" +
      "用法: status 查单个任务(taskId); list 列任务(sessionId 缺省=调用方会话; 可选 status / limit); cancel 取消任务(taskId)。\n" +
      "效果: 记录在 Redis 任务表(`task:<id>`, TTL 7 天), 跨会话 / 跨进程共见。\n" +
      "边界: 嵌套任务树查 task_status。\n" +
      "相关: channel_delegate、channel_task_result、task_status。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["status", "list", "cancel"],
          description:
            "status 查单个委托任务; list 列委托任务; cancel 取消委托任务",
        },
        taskId: { type: "string", description: "status / cancel 用：任务 id" },
        sessionId: {
          type: "string",
          description: "list 用：只列与该会话相关的任务（缺省=调用方会话）",
        },
        status: {
          type: "string",
          enum: ["pending", "running", "done", "failed", "canceled", "timeout"],
          description: "list 用：只看该状态",
        },
        limit: { type: "number", description: "list 用：条数上限（缺省 20）" },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>, exec?: unknown) {
      const action = String(args.action ?? "");
      if (action === "status" || action === "cancel") {
        const taskId = String(args.taskId ?? "");
        return action === "status"
          ? await service.taskStatus(taskId)
          : await service.taskCancel(taskId);
      }
      const sessionId =
        typeof args.sessionId === "string" && args.sessionId !== ""
          ? args.sessionId
          : callerSessionIdOf(exec);
      return await service.taskList({
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(typeof args.status === "string"
          ? { status: args.status as TaskRecord["status"] }
          : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** `channel_task_result` 工具：worker 侧显式回传结果（优先于轮末自动回收）。 */
export function toTaskResultTool(service: SessionChannelService) {
  return {
    name: "channel_task_result",
    description:
      "用途: 回传委托任务的结果(worker 侧, 任务由 channel_delegate 建立)。\n" +
      "用法: taskId 取自注入正文的 `TASK <id>:`; text 为结果正文(≤ 64 KB, 超出截断并标注); failed=true 时标记失败(可带 error)。\n" +
      "效果: 显式回传优先于轮末自动回收。\n" +
      "相关: channel_delegate、channel_task。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", description: "任务 id" },
        text: { type: "string", description: "结果正文" },
        failed: { type: "boolean", description: "true = 标记失败" },
        error: { type: "string", description: "失败原因（failed 时）" },
      },
      required: ["taskId", "text"],
    },
    async execute(args: Record<string, unknown>) {
      return await service.taskResult({
        taskId: String(args.taskId ?? ""),
        text: String(args.text ?? ""),
        ...(args.failed === true ? { failed: true } : {}),
        ...(typeof args.error === "string" ? { error: args.error } : {}),
      });
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
 * 服务面（`provide("sessionChannel", …)`）暴露的方法键清单：新增公开方法时须同步进服务面
 * （D5 根因：别名三件套曾只加在类上、漏进服务面，消费方调用即抛错），由 `session-channel/tests/apply.test.ts` 守卫。
 * `start` / `stop` / `noteSession` 属宿主生命周期 / 内部面，故意不暴露。
 */
export const SERVICE_FACE_METHODS = [
  "peers",
  "statusOf",
  "send",
  "inbox",
  "aliasSet",
  "aliasList",
  "aliasClear",
  "kvSet",
  "kvGet",
  "kvList",
  "kvDelete",
  // 委托任务（BACKLOG #54）
  "delegate",
  "taskStatus",
  "taskList",
  "taskCancel",
  "taskResult",
  "status",
] as const;
