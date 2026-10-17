/**
 * 模型侧工具 `daemon_task`（宿主 `schedule_create` 的等价物，2026-10-17 裁定进首期）。
 *
 * 两种创建入口都进首期：`/daemon` 命令与模型侧工具（设计「已裁定」节第 5 条）。
 * 工具只做参数校验 + 委派, 业务语义与命令面共用同一套 store / scheduler。
 */

import { normalizeSelector } from "./selectors.ts";
import type { Scheduler } from "./scheduler.ts";
import type { TaskStore } from "./store.ts";
import type { DaemonTask, RunRecord, TaskMode, TaskTier } from "./types.ts";
import { renderDetail, renderJournal, renderList } from "./commands.ts";
import type { Journal } from "./journal.ts";

export const TOOL_NAME = "daemon_task";

/** 允许的 `tier` 取值。 */
const TIERS: readonly TaskTier[] = ["S", "P", "U"];

export interface DaemonToolDeps {
  store: TaskStore;
  journal: Journal;
  scheduler: Scheduler;
  /** 缺省目标会话（模型侧调用时通常是当前会话）。 */
  defaultSessionId?: () => string | undefined;
  now?: () => number;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 结构面工具定义（与 dsh `tools.register` 接受形态对齐）。 */
export function createDaemonTaskTool(deps: DaemonToolDeps): object {
  const now = deps.now ?? Date.now;
  return {
    name: TOOL_NAME,
    description:
      "后台守护任务（定时执行）：create 新建（选择器 + 投递文本或 slash 命令）, list 列表, " +
      "show 详情, pause / resume 暂停恢复, run 立即投递一次, cancel 删除, log 运行流水。" +
      "选择器支持 after_seconds / at / every_seconds（≥60 s）/ daily / weekly（cron 不在首期）。" +
      "投递只面向本进程已注册的活跃 agent：目标会话无活跃 agent 时记 skipped, 不重试。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "show", "pause", "resume", "run", "cancel", "log"],
        },
        id: { type: "string", description: "任务 id（show / pause / resume / run / cancel / log 用）" },
        selector: {
          type: "object",
          description:
            "选择器：{kind:'after_seconds',seconds} | {kind:'at',at:ISO} | " +
            "{kind:'every_seconds',seconds} | {kind:'daily',time:'HH:MM',timeZone} | " +
            "{kind:'weekly',weekdays:[1-7],time,timeZone}",
          additionalProperties: true,
          properties: {},
        },
        payload: { type: "string", description: "投递正文；command 类型时为完整 slash 命令行" },
        mode: {
          type: "string",
          enum: ["deliver", "command"],
          description: "deliver = 投递提示文本（缺省）；command = 执行 slash 命令",
        },
        sessionId: { type: "string", description: "目标会话 id（缺省取当前会话）" },
        tier: { type: "string", enum: ["S", "P", "U"], description: "分档（缺省 S）" },
        limit: { type: "number", description: "log 用，条数上限（缺省 20）" },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>): Promise<unknown> {
      return await executeDaemonTool(args, deps, now);
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** 工具执行体（导出以便单测直接驱动, 不经宿主工具面）。 */
export async function executeDaemonTool(
  args: Record<string, unknown>,
  deps: DaemonToolDeps,
  now: () => number = Date.now,
): Promise<Record<string, unknown>> {
  const action = typeof args["action"] === "string" ? args["action"] : "";
  switch (action) {
    case "create":
      return createTask(args, deps, now);
    case "list":
      return { ok: true, text: renderList(deps.store.list()), tasks: deps.store.list() };
    case "show": {
      const task = findTask(args, deps);
      if (task === null) return missing(args);
      return { ok: true, text: renderDetail(task), task };
    }
    case "pause": {
      const task = findTask(args, deps);
      if (task === null) return missing(args);
      const updated = deps.store.update(task.id, { status: "paused" });
      deps.scheduler.arm();
      return { ok: true, task: updated, text: `已暂停 ${task.id}` };
    }
    case "resume": {
      const task = findTask(args, deps);
      if (task === null) return missing(args);
      if (task.status !== "paused") {
        return { ok: false, error: "not_paused", text: `任务未处于暂停状态：${task.id}` };
      }
      const updated = deps.store.update(task.id, { status: "active" });
      deps.scheduler.arm();
      return { ok: true, task: updated, text: `已恢复 ${task.id}` };
    }
    case "run": {
      const task = findTask(args, deps);
      if (task === null) return missing(args);
      const result = await deps.scheduler.runNow(task.id);
      return { ok: result.ok, result };
    }
    case "cancel": {
      const task = findTask(args, deps);
      if (task === null) return missing(args);
      deps.store.remove(task.id);
      deps.scheduler.arm();
      return { ok: true, text: `已删除 ${task.id}` };
    }
    case "log": {
      const taskId = typeof args["id"] === "string" ? args["id"] : undefined;
      const limit =
        typeof args["limit"] === "number" && args["limit"] > 0
          ? Math.floor(args["limit"])
          : 20;
      const records: RunRecord[] = deps.journal.tail(limit, taskId);
      return {
        ok: true,
        records,
        text: renderJournal(records, taskId === undefined ? "运行流水" : `任务 ${taskId} 的流水`),
      };
    }
    default:
      return {
        ok: false,
        error: "unknown_action",
        text: `未知 action：${action}（create / list / show / pause / resume / run / cancel / log）`,
      };
  }
}

function findTask(
  args: Record<string, unknown>,
  deps: DaemonToolDeps,
): DaemonTask | null {
  const id = args["id"];
  if (typeof id !== "string" || id.trim() === "") return null;
  return deps.store.get(id) ?? null;
}

function missing(args: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: false,
    error: "task_not_found",
    text: `任务不存在：${String(args["id"] ?? "(缺 id)")}`,
  };
}

async function createTask(
  args: Record<string, unknown>,
  deps: DaemonToolDeps,
  now: () => number,
): Promise<Record<string, unknown>> {
  const selector = normalizeSelector(args["selector"], now());
  if (!selector.ok) {
    return {
      ok: false,
      error: selector.code,
      text: `选择器非法（${selector.code}）：${selector.message}`,
    };
  }
  const payload = args["payload"];
  if (typeof payload !== "string" || payload.trim() === "") {
    return { ok: false, error: "invalid_payload", text: "payload 必填" };
  }
  const rawMode = args["mode"];
  const mode: TaskMode = rawMode === "command" ? "command" : "deliver";
  const sessionId =
    typeof args["sessionId"] === "string" && args["sessionId"].trim() !== ""
      ? args["sessionId"]
      : (deps.defaultSessionId?.() ?? "");
  if (sessionId === "") {
    return {
      ok: false,
      error: "missing_session",
      text: "缺少目标会话 sessionId（本进程内没有可用的当前会话）",
    };
  }
  const rawTier = args["tier"];
  const tier =
    typeof rawTier === "string" && TIERS.includes(rawTier as TaskTier)
      ? (rawTier as TaskTier)
      : "S";
  const task = deps.store.create({
    mode,
    selector: selector.selector,
    payload,
    sessionId,
    tier,
  });
  deps.scheduler.arm();
  return {
    ok: true,
    task,
    text: `已创建 ${task.id}（下次触发 ${task.next === null ? "-" : new Date(task.next).toISOString()}）`,
  };
}
