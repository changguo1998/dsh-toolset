// src/task-layer.ts — session-channel 服务层中的任务层（跨会话委托 / 回收，planner-worker 语义）。
//
// 职责：任务表读写（`broker.ts`）、注入对位（`user/message`）、轮末自动回收（`turn/end`）、
// 结果通知。服务实例把连接、时钟、日志与标签解析经 `TaskLayerHost` 传进来；公开方法的
// 连接判定外壳留在 `src/service.ts`（错误文案与判定顺序不变）。
//
// 契约见包 README「委托任务」一节；记录落在 Redis 任务表（`task:<id>`）。

import { randomUUID } from "node:crypto";
import { describe, type SessionChannelConnection } from "./client.ts";
import {
  getTask,
  listAllTasks,
  listTasksOfSession,
  patchTask,
  putTask,
  resolveTarget,
  sendMessage,
  taskIdError,
  truncateTaskResult,
} from "./broker.ts";
import {
  DEFAULT_TASK_NOTIFY_MAX_BYTES,
  DEFAULT_TASK_RESULT_MAX_BYTES,
  DEFAULT_TASK_TEXT_MAX_BYTES,
  DEFAULT_TASK_TIMEOUT_SEC,
  DEFAULT_TASK_TTL_SEC,
  failureNotificationText,
  isTerminalTaskStatus,
  resultNotificationText,
  taskInjectionText,
  withTimeoutCheck,
} from "./tasks.ts";
import { SessionChannelError } from "./types.ts";
import type {
  DelegateRequest,
  DelegateResult,
  TaskListResult,
  TaskQueryOptions,
  TaskRecord,
  TaskResultInput,
} from "./types.ts";

/** 从 `user/message` 事件取文本（形状容错；取不到 → 空串）。 */
function textOfUserMessage(data: unknown): string {
  const d = data as { content?: unknown; text?: unknown } | undefined;
  if (typeof d?.text === "string") return d.text;
  return textOfContent(d?.content);
}

/** 从内容块取纯文本（`{type:"text",text}`；非数组 → 尝试字符串）。 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | undefined;
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

/** 任务层依赖的服务面（由 `SessionChannelService` 提供，避免任务层反向持有整个服务）。 */
export interface TaskLayerHost {
  /** 当前连接（未连接 → undefined）。 */
  client(): SessionChannelConnection | undefined;
  /** 当前时刻（依赖注入，测试可控）。 */
  now(): number;
  /** 日志（宿主 logger 或 stderr）。 */
  log(message: string): void;
  /** 日志展示标签：别名优先，反查失败回退会话 id。 */
  labelOf(
    client: SessionChannelConnection["main"],
    sessionId: string,
  ): Promise<string>;
  /** 发送正文上限（配置项 `maxTextBytes`；缺省由任务层取任务默认值）。 */
  maxTextBytes(): number | undefined;
}

/**
 * 委托任务层：任务表读写 + 注入对位 + 轮末回收 + 结果通知。
 * 每个公开方法以连接为入参（连接判定在服务层完成）；事件钩子自取当前连接。
 */
export class TaskLayer {
  readonly #host: TaskLayerHost;
  /** 委托任务：worker 会话 id → 待回收任务 id 列表（FIFO；`turn/end` 自动回收用）。 */
  #workerTasks = new Map<string, string[]>();

  constructor(host: TaskLayerHost) {
    this.#host = host;
  }

  /**
   * 委托任务：解析目标（会话 id / 别名 / `cwd:`）→ 建任务记录（任务表）→ 经既有消息通道
   * 把任务注入 worker 会话的下一回合。结果回收两条路：显式工具（`taskResult`）优先，
   * 轮末（`turn/end`）自动回收兜底。
   */
  async delegate(
    client: SessionChannelConnection["main"],
    req: DelegateRequest,
  ): Promise<DelegateResult> {
    const text = typeof req?.text === "string" ? req.text : "";
    const to = typeof req?.to === "string" ? req.to : "";
    if (to === "" || text.trim() === "") {
      return {
        ok: false,
        error: "task_invalid",
        message: "delegate 需要非空 to 与 text",
      };
    }
    const maxText = this.#host.maxTextBytes() ?? DEFAULT_TASK_TEXT_MAX_BYTES;
    if (Buffer.byteLength(text, "utf8") > maxText) {
      return {
        ok: false,
        error: "text_too_large",
        message: `任务正文超过上限（${maxText} 字节）`,
      };
    }
    try {
      const targets = await resolveTarget(client, to);
      if (targets.length === 0) {
        return {
          ok: false,
          error: "target_offline",
          message: `目标不在线：${to}（在线对端见 peers）`,
        };
      }
      if (targets.length > 1) {
        return {
          ok: false,
          error: "target_ambiguous",
          message: `目标命中多个会话（${targets.length}）`,
          candidates: targets,
        };
      }
      const target = targets[0]!;
      const now = this.#host.now();
      const record: TaskRecord = {
        id: randomUUID(),
        from: req?.from ?? "",
        to: target.sessionId,
        text,
        createdAt: now,
        updatedAt: now,
        status: "pending",
        deadline:
          now + Math.max(1, req?.timeoutSec ?? DEFAULT_TASK_TIMEOUT_SEC) * 1000,
      };
      await putTask(client, record, req?.ttlSec ?? DEFAULT_TASK_TTL_SEC);
      // 注入走既有 send 路径：本进程 / 跨进程统一由目标实例的 reader 注入
      const sent = await sendMessage(
        client,
        {
          from: record.from,
          to: target.sessionId,
          text: taskInjectionText(record),
          ...(req?.waitMs === undefined ? {} : { waitMs: req.waitMs }),
        },
        { maxTextBytes: maxText + DEFAULT_TASK_NOTIFY_MAX_BYTES },
      );
      const updated =
        (await patchTask(
          client,
          record.id,
          { messageId: sent.messageId },
          now,
        )) ?? record;
      const queue = this.#workerTasks.get(target.sessionId) ?? [];
      queue.push(record.id);
      this.#workerTasks.set(target.sessionId, queue);
      const targetLabel = await this.#host.labelOf(client, target.sessionId);
      this.#host.log(`已委托任务 ${record.id} → ${targetLabel}`);
      return {
        ok: true,
        task: updated,
        ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }),
        ...(sent.delivered === undefined ? {} : { delivered: sent.delivered }),
        ...(sent.target === undefined ? {} : { target: sent.target }),
      };
    } catch (err) {
      return {
        ok: false,
        ...(err instanceof SessionChannelError ? { error: err.code } : {}),
        message: describe(err),
      };
    }
  }

  /** 查单个任务（懒判定超时；超时状态落回任务表并通知委托方）。 */
  async taskStatus(
    client: SessionChannelConnection["main"],
    taskId: string,
  ): Promise<{ ok: boolean; task?: TaskRecord; error?: string }> {
    if (taskIdError(taskId) !== undefined) {
      return { ok: false, error: "task_invalid" };
    }
    try {
      const found = await getTask(client, taskId);
      if (found === undefined) return { ok: false, error: "task_not_found" };
      const checked = withTimeoutCheck(found, this.#host.now());
      if (checked !== found) {
        await patchTask(
          client,
          taskId,
          {
            status: checked.status,
            ...(checked.error === undefined ? {} : { error: checked.error }),
          },
          checked.updatedAt,
        );
        await this.#notifyPlanner(client, checked);
      }
      return { ok: true, task: checked };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 列任务（会话索引；无 sessionId 时扫任务表；按建立时刻新→旧）。 */
  async taskList(
    client: SessionChannelConnection["main"],
    opts: TaskQueryOptions = {},
  ): Promise<TaskListResult> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    try {
      const raw =
        opts.sessionId === undefined || opts.sessionId === ""
          ? await listAllTasks(client, limit)
          : await listTasksOfSession(client, opts.sessionId, limit);
      const now = this.#host.now();
      const checked = raw.map((task) => withTimeoutCheck(task, now));
      for (let i = 0; i < checked.length; i += 1) {
        const task = checked[i]!;
        if (task === raw[i]) continue;
        await patchTask(
          client,
          task.id,
          {
            status: task.status,
            ...(task.error === undefined ? {} : { error: task.error }),
          },
          task.updatedAt,
        );
      }
      const filtered =
        opts.status === undefined
          ? checked
          : checked.filter((task) => task.status === opts.status);
      filtered.sort((a, b) => b.createdAt - a.createdAt);
      return { ok: true, tasks: filtered.slice(0, limit) };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 取消任务（终态不可取消；返回当前记录）。 */
  async taskCancel(
    client: SessionChannelConnection["main"],
    taskId: string,
  ): Promise<{ ok: boolean; task?: TaskRecord; error?: string }> {
    if (taskIdError(taskId) !== undefined) {
      return { ok: false, error: "task_invalid" };
    }
    try {
      const current = await getTask(client, taskId);
      if (current === undefined) return { ok: false, error: "task_not_found" };
      if (isTerminalTaskStatus(current.status))
        return { ok: true, task: current };
      const next = await patchTask(
        client,
        taskId,
        { status: "canceled", error: "已被委托方取消" },
        this.#host.now(),
      );
      if (next === undefined) return { ok: false, error: "task_not_found" };
      this.#dropWorkerTask(next.to, taskId);
      return { ok: true, task: next };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 显式回传结果（worker 侧工具 / 服务调用；`tool` 来源优先于自动回收）。 */
  async taskResult(
    client: SessionChannelConnection["main"],
    input: TaskResultInput,
  ): Promise<{
    ok: boolean;
    task?: TaskRecord;
    error?: string;
    message?: string;
  }> {
    const taskId = typeof input?.taskId === "string" ? input.taskId : "";
    if (taskIdError(taskId) !== undefined) {
      return { ok: false, error: "task_invalid", message: "任务 id 非法" };
    }
    const text = typeof input?.text === "string" ? input.text : "";
    if (text === "") {
      return { ok: false, error: "task_invalid", message: "结果正文为空" };
    }
    try {
      const current = await getTask(client, taskId);
      if (current === undefined) return { ok: false, error: "task_not_found" };
      const truncated = truncateTaskResult(text, DEFAULT_TASK_RESULT_MAX_BYTES);
      const failed = input?.failed === true;
      const next = await patchTask(
        client,
        taskId,
        {
          status: failed ? "failed" : "done",
          result: truncated.text,
          resultTruncated: truncated.truncated,
          resultSource: "tool",
          ...(failed ? { error: input?.error ?? "worker 报告失败" } : {}),
        },
        this.#host.now(),
      );
      if (next === undefined) return { ok: false, error: "task_not_found" };
      this.#dropWorkerTask(next.to, taskId);
      await this.#notifyPlanner(client, next);
      return { ok: true, task: next };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 会话事件：任务注入对位（user/message）与轮末自动回收（turn/end）。 */
  onEvent(session: unknown, event: unknown): void {
    const sessionId =
      typeof (session as { id?: unknown })?.id === "string"
        ? (session as { id: string }).id
        : "";
    if (sessionId === "") return;
    const e = event as { type?: unknown; seq?: unknown; data?: unknown };
    if (e.type === "user/message") {
      const text = textOfUserMessage(e.data);
      const match = /TASK ([A-Za-z0-9_-]{8,64}):/.exec(text);
      if (match === null) return;
      const seq = Number(e.seq);
      if (!Number.isFinite(seq)) return;
      void this.#markTaskRunning(sessionId, match[1]!, seq);
      return;
    }
    if (e.type === "turn/end") {
      void this.#captureTaskResult(sessionId, session);
    }
  }

  /** 注入对位：把触发 seq 落表并挂入待回收队列（仅当任务确实指向该会话）。 */
  async #markTaskRunning(
    workerSessionId: string,
    taskId: string,
    seq: number,
  ): Promise<void> {
    const conn = this.#host.client();
    if (conn === undefined) return;
    try {
      const task = await getTask(conn.main, taskId);
      if (task === undefined || task.to !== workerSessionId) return;
      if (isTerminalTaskStatus(task.status)) return;
      await patchTask(
        conn.main,
        taskId,
        { status: "running", triggerSeq: seq },
        this.#host.now(),
      );
      const queue = this.#workerTasks.get(workerSessionId) ?? [];
      if (!queue.includes(taskId)) queue.push(taskId);
      this.#workerTasks.set(workerSessionId, queue);
    } catch (err) {
      this.#host.log(`任务对位失败（${taskId}）：${describe(err)}`);
    }
  }

  /** 轮末自动回收：取该会话最旧的非终态任务，把本轮最终回答回写为结果并通知委托方。 */
  async #captureTaskResult(
    workerSessionId: string,
    session: unknown,
  ): Promise<void> {
    const conn = this.#host.client();
    if (conn === undefined) return;
    const queue = this.#workerTasks.get(workerSessionId) ?? [];
    while (queue.length > 0) {
      const taskId = queue[0]!;
      const task = await getTask(conn.main, taskId).catch(() => undefined);
      if (
        task === undefined ||
        isTerminalTaskStatus(task.status) ||
        task.status !== "running"
      ) {
        queue.shift();
        continue;
      }
      const text = this.#lastAssistantText(session);
      if (text === "") {
        this.#host.log(`任务 ${taskId} 轮末未取到回答，保留待下次回收`);
        return;
      }
      const truncated = truncateTaskResult(text, DEFAULT_TASK_RESULT_MAX_BYTES);
      const next = await patchTask(
        conn.main,
        taskId,
        {
          status: "done",
          result: truncated.text,
          resultTruncated: truncated.truncated,
          resultSource: "auto",
        },
        this.#host.now(),
      );
      queue.shift();
      if (next === undefined) continue;
      this.#host.log(`任务 ${next.id} 已自动回收`);
      await this.#notifyPlanner(conn.main, next);
      return;
    }
    if (queue.length === 0) this.#workerTasks.delete(workerSessionId);
  }

  /** 从会话读取最后一条 assistant 文本（结构面；不可读 → 空串）。 */
  #lastAssistantText(session: unknown): string {
    try {
      const derive = (session as { deriveMessages?: () => unknown })
        ?.deriveMessages;
      if (typeof derive !== "function") return "";
      const messages = derive.call(session);
      if (!Array.isArray(messages)) return "";
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i] as
          { role?: unknown; content?: unknown } | undefined;
        if (m?.role !== "assistant") continue;
        return textOfContent(m.content);
      }
      return "";
    } catch {
      return "";
    }
  }

  /** 结果/失败通知：经消息通道发给委托方（离线则留在流里，任务表仍可查）。 */
  async #notifyPlanner(
    client: SessionChannelConnection["main"],
    task: TaskRecord,
  ): Promise<void> {
    if (task.from === "") return;
    const text =
      task.status !== "done" && isTerminalTaskStatus(task.status)
        ? failureNotificationText(task)
        : resultNotificationText(task);
    try {
      await sendMessage(
        client,
        { from: task.to, to: task.from, text },
        { maxTextBytes: DEFAULT_TASK_NOTIFY_MAX_BYTES * 2 },
      );
      const fromLabel = await this.#host.labelOf(client, task.from);
      this.#host.log(`已回传任务 ${task.id} 结果 → ${fromLabel}`);
    } catch (err) {
      this.#host.log(`结果通知未送达（${task.id}）：${describe(err)}`);
    }
  }

  /** 把任务从待回收队列移除。 */
  #dropWorkerTask(workerSessionId: string, taskId: string): void {
    const queue = this.#workerTasks.get(workerSessionId);
    if (queue === undefined) return;
    const index = queue.indexOf(taskId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.#workerTasks.delete(workerSessionId);
  }
}
