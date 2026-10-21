/**
 * `/daemon` 命令面（`ctx.commands.register`，零 TUI 改动）。
 *
 * 子命令（设计 §C③ + 2026-10-21 开关）：`start` / `stop` / `list` / `show <id>` /
 * `pause|resume <id>` / `run <id>` / `cancel <id>` / `log [<id>] [n]`；空表输出「暂无守护任务」。
 *
 * 守护**默认关闭**（进程内开关，见 `switch.ts`）：未开启时读类子命令照常、写类子命令
 * 一律拒绝并提示先 `start`；`start` / `stop` 负责切开关并启停调度器。
 *
 * 渲染与分派是纯函数（`renderList` / `runDaemonCommand`）, 注册只做薄适配——这样
 * 不用宿主命令面就能测全部子命令。
 */

import type { ControlLog } from "./control.ts";
import type { Journal } from "./journal.ts";
import { describeSelector, isPeriodic, nextAfter } from "./selectors.ts";
import type { Scheduler, SchedulerStatus } from "./scheduler.ts";
import type { TaskStore } from "./store.ts";
import type { DaemonSwitch } from "./switch.ts";
import type { DaemonTask, RunRecord, RunOutcome, TaskStatus } from "./types.ts";

/** 命令名（不带斜杠）。 */
export const COMMAND_NAME = "daemon";

/** 全部子命令（帮助文案与测试共用）。 */
export const SUBCOMMANDS = [
  "start",
  "stop",
  "list",
  "show",
  "pause",
  "resume",
  "run",
  "cancel",
  "log",
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

/** 命令面依赖（store / journal / scheduler / switcher；control 可选 = 跨实例传播）。 */
export interface DaemonCommandDeps {
  store: TaskStore;
  journal: Journal;
  scheduler: Scheduler;
  /** 进程内总开关（缺省关闭；`/daemon start` / `stop` 切它，写类子命令据此拒绝）。 */
  switcher: DaemonSwitch;
  now?: () => number;
  /** 共享控制帐（取消 / 暂停 / 恢复写入后其它实例到点前收敛；缺省不接）。 */
  control?: ControlLog;
}

/** 命令结果（宿主 `CommandResult` 的结构子集）。 */
export interface DaemonCommandResult {
  kind: "success" | "error";
  text: string;
}

/** 宿主命令面最小结构子集。 */
export interface CommandRegistrarLike {
  register?(definition: unknown): () => void;
}

/** 命令调用（宿主 `CommandInvocation` 的结构子集）。 */
export interface InvocationLike {
  rawInput?: string;
}

/** 状态符号（只用仓内推荐符号）。 */
const STATUS_SYMBOL: Record<TaskStatus, string> = {
  active: "●",
  paused: "○",
  done: "✓",
  missed: "✗",
};

/** 结局符号。 */
const OUTCOME_SYMBOL: Record<RunOutcome, string> = {
  delivered: "✓",
  failed: "✗",
  skipped: "△",
  missed: "✗",
};

function iso(instant: number | null): string {
  return instant === null ? "-" : new Date(instant).toISOString();
}

/** 任务列表渲染（`/daemon list`）。 */
export function renderList(tasks: readonly DaemonTask[]): string {
  if (tasks.length === 0) return "暂无守护任务";
  const lines = tasks.map((task) => {
    const outcome =
      task.lastOutcome === null
        ? "-"
        : `${OUTCOME_SYMBOL[task.lastOutcome]} ${task.lastOutcome}`;
    return (
      `${STATUS_SYMBOL[task.status]} ${task.id}  [${task.tier}] ${task.mode}  ` +
      `${describeSelector(task.selector)}  ${task.status}  ` +
      `next ${iso(task.next)}  ${outcome}`
    );
  });
  return [`守护任务 ${tasks.length} 个：`, ...lines].join("\n");
}

/** 任务详情渲染（`/daemon show <id>`）。 */
export function renderDetail(task: DaemonTask): string {
  return [
    `${STATUS_SYMBOL[task.status]} ${task.id}`,
    `  分档：${task.tier}`,
    `  类型：${task.mode}`,
    `  选择器：${describeSelector(task.selector)}`,
    `  目标会话：${task.sessionId}`,
    `  状态：${task.status}`,
    `  下次触发：${iso(task.next)}`,
    `  创建时刻：${iso(task.createdAt)}`,
    `  上次触发：${iso(task.lastFireAt)}`,
    `  上次结果：${task.lastOutcome === null ? "-" : `${OUTCOME_SYMBOL[task.lastOutcome]} ${task.lastOutcome}`}`,
    `  上次错误：${task.lastError ?? "-"}`,
    `  正文：${task.payload}`,
  ].join("\n");
}

/** 流水渲染（`/daemon log [<id>] [n]`）。 */
export function renderJournal(
  records: readonly RunRecord[],
  label: string,
): string {
  if (records.length === 0) return `${label}：暂无流水`;
  const lines = records.map(
    (record) =>
      `${iso(record.at)}  ${OUTCOME_SYMBOL[record.outcome]} ${record.taskId}  ` +
      `${record.outcome}  ${record.durationMs}ms` +
      `${record.error === null ? "" : `  ${record.error}`}` +
      `${record.detail === null ? "" : `  ${record.detail}`}`,
  );
  return [`${label}：最近 ${records.length} 条`, ...lines].join("\n");
}

/** 未开启时的统一拒绝（D3 / D4：读类放行, 写类拒绝）。 */
function notEnabled(): DaemonCommandResult {
  return {
    kind: "error",
    text: `守护未开启（默认关闭）：先 /${COMMAND_NAME} start 开启`,
  };
}

function usage(): string {
  return (
    `用法：/${COMMAND_NAME} ${SUBCOMMANDS.join(" | ")}\n` +
    "  start               开启守护（默认关闭；进程内状态, 重启复位）\n" +
    "  stop                关闭守护（撤销定时器, 任务表保留）\n" +
    "  list                列出任务（下次触发 / 状态 / 上次结果）\n" +
    "  show <id>           查看单条详情\n" +
    "  pause|resume <id>   暂停 / 恢复（需先开启）\n" +
    "  run <id>            立即投递一次（不改排期；需先开启）\n" +
    "  cancel <id>         删除任务（需先开启）\n" +
    "  log [<id>] [n]      查看运行流水（缺省最近 20 条）"
  );
}

/** 分派一条 `/daemon …` 输入（`rawInput` 不含命令名本身）。 */
export async function runDaemonCommand(
  rawInput: string,
  deps: DaemonCommandDeps,
): Promise<DaemonCommandResult> {
  const now = deps.now ?? Date.now;
  const trimmed = rawInput.trim();
  if (trimmed === "" || trimmed === "help") {
    return { kind: "success", text: usage() };
  }
  const [sub = "", first, second] = trimmed.split(/\s+/);
  switch (sub) {
    case "start": {
      if (deps.switcher.enabled) {
        return { kind: "success", text: "守护已开启" };
      }
      deps.switcher.enable();
      const status: SchedulerStatus = deps.scheduler.start();
      if (!status.running) {
        deps.switcher.disable();
        return {
          kind: "error",
          text: `开启失败（调度器未启动）：${status.error ?? "未知原因"}`,
        };
      }
      return {
        kind: "success",
        text:
          `已开启（任务 ${deps.store.list().length} 个；进程内状态, 重启复位）\n` +
          "启动补算已执行：周期任务只补最近一次, 一次性任务超窗记 missed",
      };
    }
    case "stop": {
      if (!deps.switcher.enabled) {
        return { kind: "success", text: "守护未开启" };
      }
      deps.switcher.disable();
      await deps.scheduler.stop();
      return {
        kind: "success",
        text: `已关闭（定时器已撤销；任务 ${deps.store.list().length} 个保留）`,
      };
    }
    case "list":
      return { kind: "success", text: renderList(deps.store.list()) };
    case "show": {
      if (first === undefined) {
        return { kind: "error", text: `缺少任务 id。\n${usage()}` };
      }
      const task = deps.store.get(first);
      if (task === undefined) {
        return { kind: "error", text: `任务不存在：${first}` };
      }
      return { kind: "success", text: renderDetail(task) };
    }
    case "pause": {
      if (!deps.switcher.enabled) return notEnabled();
      if (first === undefined) {
        return { kind: "error", text: `缺少任务 id。\n${usage()}` };
      }
      const task = deps.store.get(first);
      if (task === undefined) {
        return { kind: "error", text: `任务不存在：${first}` };
      }
      if (task.status === "paused") {
        return { kind: "success", text: `任务已是暂停：${first}` };
      }
      deps.store.update(first, { status: "paused" });
      deps.control?.append(first, "pause", now());
      deps.scheduler.arm();
      return {
        kind: "success",
        text: `已暂停 ${first}（原定下次触发 ${iso(task.next)}）`,
      };
    }
    case "resume": {
      if (!deps.switcher.enabled) return notEnabled();
      if (first === undefined) {
        return { kind: "error", text: `缺少任务 id。\n${usage()}` };
      }
      const task = deps.store.get(first);
      if (task === undefined) {
        return { kind: "error", text: `任务不存在：${first}` };
      }
      if (task.status !== "paused") {
        return { kind: "error", text: `任务未处于暂停状态：${first}` };
      }
      // 解除暂停：周期任务按当前时钟重算下次（暂停期间到点的已记 missed, 不补做）
      const next = isPeriodic(task.selector)
        ? nextAfter(task.selector, now(), task.createdAt)
        : task.next;
      deps.store.update(first, { status: "active", next });
      deps.control?.append(first, "resume", now());
      deps.scheduler.arm();
      return {
        kind: "success",
        text: `已恢复 ${first}（下次触发 ${iso(next)}）`,
      };
    }
    case "run": {
      if (!deps.switcher.enabled) return notEnabled();
      if (first === undefined) {
        return { kind: "error", text: `缺少任务 id。\n${usage()}` };
      }
      const result = await deps.scheduler.runNow(first);
      const outcome = result.ok ? "✓ 已投递" : `✗ ${result.code}`;
      const detail = result.ok ? (result.detail ?? "") : (result.message ?? "");
      return {
        kind: result.ok ? "success" : "error",
        text: `${first}：${outcome}${detail === "" ? "" : ` — ${detail}`}`,
      };
    }
    case "cancel": {
      if (!deps.switcher.enabled) return notEnabled();
      if (first === undefined) {
        return { kind: "error", text: `缺少任务 id。\n${usage()}` };
      }
      const removed = deps.store.remove(first);
      if (!removed) return { kind: "error", text: `任务不存在：${first}` };
      deps.control?.append(first, "cancel", now());
      deps.scheduler.arm();
      return { kind: "success", text: `已删除 ${first}` };
    }
    case "log": {
      const taskId = first;
      const parsedLimit = second === undefined ? undefined : Number(second);
      const limit =
        parsedLimit !== undefined &&
        Number.isFinite(parsedLimit) &&
        parsedLimit > 0
          ? Math.floor(parsedLimit)
          : 20;
      const records = deps.journal.tail(limit, taskId);
      return {
        kind: "success",
        text: renderJournal(
          records,
          taskId === undefined ? "运行流水" : `任务 ${taskId} 的流水`,
        ),
      };
    }
    default:
      return { kind: "error", text: `未知子命令：${sub}\n${usage()}` };
  }
}

/** 注册 `/daemon`（commands 服务缺失时返回 null, 由调用方告警）。 */
export function registerDaemonCommand(
  commands: CommandRegistrarLike | undefined,
  deps: DaemonCommandDeps,
): (() => void) | null {
  if (commands === undefined || typeof commands.register !== "function") {
    return null;
  }
  return commands.register({
    definitionId: "background-daemon:daemon",
    name: COMMAND_NAME,
    description:
      "后台守护任务（默认关闭, 先 start 开启）：start | stop | list | show <id> | pause <id> | resume <id> | run <id> | cancel <id> | log [<id>] [n]",
    input: {
      hint: "start | stop | list | show <id> | pause|resume <id> | run <id> | cancel <id> | log [<id>] [n]",
    },
    handler: (invocation: InvocationLike) =>
      runDaemonCommand(invocation.rawInput ?? "", deps),
  });
}
