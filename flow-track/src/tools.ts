/**
 * flow-track/src/tools.ts — 模型侧工具 `flow_record` / `flow_status` / `flow_remove` / `flow_rollback`。
 *
 * 顺序策略在 `policy.ts`（纯函数）：写入只允许「更新当前阶段」与「新增下一阶段」,
 * 回退走 `flow_rollback`。
 *
 * memory-base 不注册模型侧写工具，流程记录写通道由本包补（同 `pin-note` 口径）；
 * 参数是纯文本，不进 `security-guard` 的登记表。
 */

import { STAGES } from "./stages.ts";
import { decideRecord, decideRollback } from "./policy.ts";
import type { SnapshotLike } from "./status.ts";
import { currentStage, renderStatus } from "./status.ts";
import { REMOVE_SCAN_LIMIT } from "./store.ts";
import type { FlowStore, FlowStatus } from "./store.ts";
import type { WriteObserver } from "./observe.ts";
import type { FlowSwitch } from "./switch.ts";

/** 工具定义（宿主 `tools.register` 的最小形态）。 */
export interface ToolDef {
  name: string;
  description: string;
  /** 注册用短说明（用途一句 + 指向 tool_consult）；完整说明在 `description`。 */
  summary?: string;
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
    ) => Array<{ type: string; text: string }>;
  };
}

/** 工具依赖。 */
export interface ToolDeps {
  store: FlowStore;
  observer: WriteObserver;
  /** 只读快照（`taskEngine` 缺席时返回 undefined）。 */
  snapshot(): SnapshotLike | undefined;
  /** 当前会话 slug（缺省按项目 / 会话推导；由 index 注入）。 */
  slugFor(sessionId: string): string;
  /** 注入开关（进程内状态, 默认关闭）。 */
  switcher: FlowSwitch;
  /** 是否有未完成阶段的流程记录（注入门槛之一）。 */
  active(): boolean;
  /** 写入成功后刷新注入用的记录缓存（`decide` 是同步的，只能提前喂）。 */
  onRecorded?(): void;
}

/** 从宿主 `exec` 取调用方会话 id。 */
export function callerSessionId(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: unknown } } | undefined)?.agent;
  const direct = (exec as { session?: unknown } | undefined)?.session;
  const session = (agent?.session ?? direct) as { id?: unknown } | undefined;
  const id = session?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const OUTPUT: ToolDef["output"] = {
  schema: { type: "object", additionalProperties: true, properties: {} },
  render: (_args: unknown, value: unknown) => [
    { type: "text", text: jsonText(value) },
  ],
};

/** 阶段名枚举（含 `-` 表示整体推进）。 */
const STAGE_ENUM: string[] = [...STAGES.map((stage) => stage.name), "-"];

/** 状态枚举。 */
const STATUS_ENUM = ["start", "done", "blocked", "note"] as const;

/** 记录一次推进。 */
function flowRecordTool(deps: ToolDeps): ToolDef {
  return {
    name: "flow_record",
    description:
      "用途: 把标准流程的一次推进（进入 / 完成 / 卡住 / 备注某个阶段）写进项目层流程记录。\n" +
      "用法: 给 slug（任务标识）、stage（阶段名或 - 表示整体备注）、status（start / done / blocked / note）与可选 body。\n" +
      "顺序: 首次只能写「目标」; 之后只允许写当前阶段（替换该阶段记录）或下一阶段（新增）; 跳过与倒回会被拒绝。\n" +
      "效果: 落 memory-base 项目层（kind flow）；flow_status 与回合注入的「最近记录」据此显示。\n" +
      "边界: 只记流程, 不改任务树与追踪文档；要回退整段进度用 flow_rollback, 要清记录用 flow_remove。\n" +
      "相关: flow_status、flow_rollback、flow_remove、task_decompose、task_status。",
    summary:
      "用途: 把标准流程的一次推进写进项目层流程记录; 完整说明与参数 schema 经 tool_consult 查询。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["stage", "status"],
      properties: {
        slug: { type: "string", description: "任务标识（如条目 slug）" },
        stage: {
          type: "string",
          enum: STAGE_ENUM,
          description: "阶段名；- 表示整体推进",
        },
        status: {
          type: "string",
          enum: [...STATUS_ENUM],
          description: "start 进入 / done 完成 / blocked 卡住 / note 备注",
        },
        body: {
          type: "string",
          description: "可选正文（结论、证据、卡点、下一步）",
        },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = callerSessionId(exec);
      const slug =
        typeof args["slug"] === "string" && args["slug"].trim().length > 0
          ? args["slug"].trim()
          : sessionId === undefined
            ? ""
            : deps.slugFor(sessionId);
      const stage = typeof args["stage"] === "string" ? args["stage"] : "";
      const status = args["status"];
      if (slug.length === 0) {
        return { ok: false, error: "invalid_slug", message: "slug 不能为空" };
      }
      if (!STATUS_ENUM.includes(status as FlowStatus)) {
        return {
          ok: false,
          error: "invalid_status",
          message: `status 取值：${STATUS_ENUM.join(" / ")}`,
        };
      }
      // 顺序策略：同阶段替换、下一阶段新增, 跳过与倒回一律拒绝
      const records = await deps.store.list({
        slug,
        limit: REMOVE_SCAN_LIMIT,
      });
      const policy = decideRecord(records, stage);
      if (policy.kind === "reject") {
        return { ok: false, error: policy.error, message: policy.message };
      }
      if (policy.replace) {
        const stale = records
          .filter((record) => record.stage === stage)
          .map((record) => record.id);
        const cleared = await deps.store.removeMany(stale);
        if (!cleared.ok) {
          return { ok: false, error: cleared.reason, message: cleared.message };
        }
      }
      const result = await deps.store.record({
        slug,
        stage,
        status: status as FlowStatus,
        ...(typeof args["body"] === "string" ? { body: args["body"] } : {}),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      if (!result.ok) {
        return { ok: false, error: result.reason, message: result.message };
      }
      // 记过流程后就清掉本会话的「未记录」观测，避免下一轮还提示
      if (sessionId !== undefined) deps.observer.reset(sessionId);
      deps.onRecorded?.();
      return {
        ok: true,
        id: result.id,
        slug,
        stage,
        status,
        replaced: policy.replace,
      };
    },
  };
}

/** 读当前推进状态。 */
function flowStatusTool(deps: ToolDeps): ToolDef {
  return {
    name: "flow_status",
    description:
      "用途: 读当前流程推进状态——任务树里当前处于哪个阶段、门禁是什么、最近有哪些流程记录。\n" +
      "用法: 可选 slug 只看某个任务的记录；不给则看全部最近记录。\n" +
      "效果: 只读, 不动任务树、不写库。\n" +
      "边界: 阶段名靠任务帧标题匹配（标题需以阶段名开头）；没有阶段树时只报记录。\n" +
      "相关: flow_record、flow_remove、task_status。",
    summary:
      "用途: 读当前流程推进状态（当前阶段 / 门禁 / 最近记录）; 完整说明与参数 schema 经 tool_consult 查询。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        slug: { type: "string", description: "只看该任务的记录" },
      },
    },
    output: OUTPUT,
    async execute(args) {
      const slug =
        typeof args["slug"] === "string" && args["slug"].trim().length > 0
          ? args["slug"].trim()
          : undefined;
      const snapshot = deps.snapshot();
      const records = await deps.store.list(slug === undefined ? {} : { slug });
      const current =
        snapshot === undefined ? undefined : currentStage(snapshot);
      return {
        ok: true,
        enabled: deps.switcher.enabled,
        active: deps.active(),
        ...(current === undefined
          ? {
              stage: null,
              message: "当前没有可识别的阶段树（用 task_decompose 按模板建树）",
            }
          : {
              stage: {
                index: current.stage.index,
                name: current.stage.name,
                gate: current.stage.gate,
                title: current.title,
              },
            }),
        ...(renderStatus(snapshot) === undefined
          ? {}
          : { text: renderStatus(snapshot) }),
        records: records.map((record) => ({
          id: record.id,
          slug: record.slug,
          stage: record.stage,
          status: record.status,
          body: record.body,
        })),
      };
    },
  };
}

/** 切换注入开关（进程内, 不落盘）。 */
function flowEnableTool(deps: ToolDeps): ToolDef {
  return {
    name: "flow_enable",
    description:
      "用途: 打开 / 关闭本插件的上下文注入开关。\n" +
      "用法: enabled 必填, true 打开 / false 关闭。\n" +
      "效果: 关闭时阶段模板、合规提示、最近记录都不注入；打开后还要 memory-base 里有未完成阶段的流程记录（最新阶段不是「收尾」）才会注入。\n" +
      "边界: 只切开关, 不写流程记录；状态只在内存, 进程结束即回到关闭（用户面同款入口是 /flow-track on|off|status）。\n" +
      "相关: flow_status、flow_record、/flow-track 命令。",
    summary:
      "用途: 打开或关闭本插件的上下文注入开关（只在内存）; 完整说明与参数 schema 经 tool_consult 查询。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: {
        enabled: {
          type: "boolean",
          description: "true 打开注入 / false 关闭注入",
        },
      },
    },
    output: OUTPUT,
    async execute(args) {
      const enabled = args["enabled"];
      if (typeof enabled !== "boolean") {
        return {
          ok: false,
          error: "invalid_enabled",
          message: "enabled 必须是布尔值",
        };
      }
      deps.switcher.enabled = enabled;
      return { ok: true, enabled, active: deps.active() };
    },
  };
}

/** 删流程记录（一条或一个任务的全部）。 */
function flowRemoveTool(deps: ToolDeps): ToolDef {
  return {
    name: "flow_remove",
    description:
      "用途: 删掉项目层的流程记录（验证留下的、写错的、过期的）。\n" +
      "用法: id 与 slug 二选一——id 删一条（flow_status 列出的编号）；slug 删该任务的全部记录并回报条数。\n" +
      "效果: 真删（memory-base 项目层 kind flow）；下一轮注入的「最近记录」不再包含它。\n" +
      "边界: 只删流程记录, 不动任务树与追踪文档；id 不存在时 removed 为 0。\n" +
      "相关: flow_status、flow_record、task_status。",
    summary:
      "用途: 删掉项目层的流程记录（按 id 删一条, 或按 slug 删该任务全部）; 完整说明与参数 schema 经 tool_consult 查询。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "integer",
          minimum: 1,
          description: "flow_status 返回的记录 id（删一条）",
        },
        slug: {
          type: "string",
          description: "任务标识（删该任务的全部记录）",
        },
      },
    },
    output: OUTPUT,
    async execute(args) {
      const rawId = args["id"];
      const hasId = rawId !== undefined;
      const slug = typeof args["slug"] === "string" ? args["slug"].trim() : "";
      if (hasId && slug.length > 0) {
        return {
          ok: false,
          error: "invalid_args",
          message: "id 与 slug 只能给一个",
        };
      }
      if (!hasId && slug.length === 0) {
        return {
          ok: false,
          error: "invalid_args",
          message: "需要 id（删一条）或 slug（删该任务全部记录）",
        };
      }
      if (
        hasId &&
        (typeof rawId !== "number" || !Number.isInteger(rawId) || rawId <= 0)
      ) {
        return {
          ok: false,
          error: "invalid_id",
          message: "id 必须是正整数（用 flow_status 查记录编号）",
        };
      }
      const result = await deps.store.remove(
        hasId ? { id: rawId as number } : { slug },
      );
      if (!result.ok) {
        return { ok: false, error: result.reason, message: result.message };
      }
      // 删后刷新注入用的记录缓存，否则本轮仍会拿旧记录去组装「最近记录」
      deps.onRecorded?.();
      return { ok: true, removed: result.removed, ids: result.ids };
    },
  };
}

/** 回退到某个更早的阶段（清掉目标之后的记录）。 */
function flowRollbackTool(deps: ToolDeps): ToolDef {
  return {
    name: "flow_rollback",
    description:
      "用途: 把某个任务回退到更早的阶段——清掉目标阶段之后的记录（含 - 备注）, 目标阶段的记录保留。\n" +
      "用法: 给 slug（缺省用会话 id）与 stage（回退目标, 必须早于当前阶段）。\n" +
      "效果: 真删（memory-base 项目层 kind flow）；之后 flow_record 就按目标阶段重新往前走。\n" +
      "边界: 只删不写——要更新目标阶段内容, 回退后再调 flow_record；目标不早于当前阶段会被拒绝。\n" +
      "相关: flow_record、flow_status、flow_remove。",
    summary:
      "用途: 把某个任务回退到更早的阶段（清掉目标之后的记录）; 完整说明与参数 schema 经 tool_consult 查询。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["stage"],
      properties: {
        slug: { type: "string", description: "任务标识（缺省用会话 id）" },
        stage: {
          type: "string",
          enum: [...STAGES.map((item) => item.name)],
          description: "回退目标阶段（必须早于当前阶段）",
        },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = callerSessionId(exec);
      const slug =
        typeof args["slug"] === "string" && args["slug"].trim().length > 0
          ? args["slug"].trim()
          : sessionId === undefined
            ? ""
            : deps.slugFor(sessionId);
      const stage = typeof args["stage"] === "string" ? args["stage"] : "";
      if (slug.length === 0) {
        return { ok: false, error: "invalid_slug", message: "slug 不能为空" };
      }
      const records = await deps.store.list({
        slug,
        limit: REMOVE_SCAN_LIMIT,
      });
      const policy = decideRollback(records, stage);
      if (policy.kind === "reject") {
        return { ok: false, error: policy.error, message: policy.message };
      }
      const cleared = await deps.store.removeMany(policy.ids);
      if (!cleared.ok) {
        return { ok: false, error: cleared.reason, message: cleared.message };
      }
      deps.onRecorded?.();
      return {
        ok: true,
        slug,
        stage,
        removed: cleared.removed,
        ids: cleared.ids,
      };
    },
  };
}

/** 本插件的五个工具（顺序即工具面展示顺序）。 */
export function flowTools(deps: ToolDeps): ToolDef[] {
  return [
    flowRecordTool(deps),
    flowStatusTool(deps),
    flowEnableTool(deps),
    flowRemoveTool(deps),
    flowRollbackTool(deps),
  ];
}
