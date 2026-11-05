/**
 * flow-track/src/tools.ts — 模型侧工具 `flow_record` / `flow_status`。
 *
 * memory-base 不注册模型侧写工具，流程记录写通道由本包补（同 `pin-note` 口径）；
 * 参数是纯文本，不进 `security-guard` 的登记表。
 */

import { STAGES } from "./stages.ts";
import type { SnapshotLike } from "./status.ts";
import { currentStage, renderStatus } from "./status.ts";
import type { FlowStore, FlowStatus } from "./store.ts";
import type { WriteObserver } from "./observe.ts";

/** 工具定义（宿主 `tools.register` 的最小形态）。 */
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
      "用法: 给 slug（任务标识）、stage（阶段名或 - 表示整体）、status（start / done / blocked / note）与可选 body（正文 / 结论 / 证据）。\n" +
      "效果: 落 memory-base 项目层（kind flow）；flow_status 与回合注入的「最近记录」据此显示。\n" +
      "边界: 只记流程, 不改任务树与追踪文档；任务树推进仍用 task_* 工具。\n" +
      "相关: flow_status、task_decompose、task_status。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "stage", "status"],
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
      return { ok: true, id: result.id, slug, stage, status };
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
      "相关: flow_record、task_status。",
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

/** 本插件的两个工具。 */
export function flowTools(deps: ToolDeps): ToolDef[] {
  return [flowRecordTool(deps), flowStatusTool(deps)];
}
