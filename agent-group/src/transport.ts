/**
 * 传输接入：把 session-channel 的服务面（`ctx.get("sessionChannel")`）适配成本包的
 * `GroupTransport` 端口 —— 「投递指令」= `delegate`，「收取回报」= `taskStatus`。
 *
 * 三条硬约束照 session-channel 的 README：从方也要挂 session-channel（注入由目标进程的
 * reader 完成）· 目标必须在线 · 离线不排队（直接 `target_offline`）。
 */

import { failure } from "./model.ts";
import type { GroupFailure, GroupTransport, TaskSnapshot } from "./types.ts";

/** session-channel 服务面里本包用到的方法（结构面，避免跨包 import 依赖）。 */
export interface SessionChannelFace {
  peers(): Promise<{
    ok: boolean;
    peers?: Array<{ sessionId: string; cwd?: string }>;
    error?: string;
  }>;
  aliasList(): Promise<{
    ok: boolean;
    aliases?: Array<{ alias: string; sessionId: string; online: boolean }>;
    error?: string;
  }>;
  delegate(request: {
    from?: string;
    to: string;
    text: string;
    timeoutSec?: number;
  }): Promise<{
    ok: boolean;
    task?: { id: string };
    error?: string;
    message?: string;
    candidates?: unknown;
  }>;
  send(request: { to: string; text: string; waitMs?: number }): Promise<{
    ok: boolean;
    delivered?: boolean;
    error?: string;
    message?: string;
    candidates?: unknown;
  }>;
  taskStatus(taskId: string): Promise<{
    ok: boolean;
    task?: {
      status: string;
      result?: string;
      error?: string;
      resultTruncated?: boolean;
    };
    error?: string;
  }>;
}

/** 判据：服务面「够用」——缺 `delegate` / `taskStatus` 就不算可用（apply 期门禁）。 */
export function isSessionChannelFace(
  value: unknown,
): value is SessionChannelFace {
  if (typeof value !== "object" || value === null) return false;
  const face = value as Record<string, unknown>;
  return (
    typeof face["delegate"] === "function" &&
    typeof face["taskStatus"] === "function"
  );
}

const TASK_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "canceled",
  "timeout",
] as const;

function statusOf(value: string): TaskSnapshot["status"] | undefined {
  return (TASK_STATUSES as readonly string[]).includes(value)
    ? (value as TaskSnapshot["status"])
    : undefined;
}

/** 把 session-channel 服务面包成 `GroupTransport`。 */
export function createSessionChannelTransport(
  face: SessionChannelFace,
): GroupTransport {
  return {
    async resolve(target: string) {
      const peers = await face.peers();
      if (!peers.ok) {
        return failure(
          "transport_error",
          `读取在线会话失败：${peers.error ?? "未知原因"}`,
          "确认 session-channel 已连接（session_channel action=status）后重试",
        );
      }
      const online = peers.peers ?? [];
      const exact = online.filter((peer) => peer.sessionId === target);
      if (exact.length > 0) {
        return { ok: true as const, sessionId: exact[0]!.sessionId };
      }
      const aliases = await face.aliasList();
      if (!aliases.ok) {
        return failure(
          "transport_error",
          `读取别名失败：${aliases.error ?? "未知原因"}`,
          "确认 session-channel 已连接（session_channel action=status）后重试",
        );
      }
      const hits = (aliases.aliases ?? []).filter(
        (entry) => entry.alias === target,
      );
      if (hits.length === 0) {
        return failure(
          "target_offline",
          `目标不在线或不存在：${target}`,
          "用 session_channel peers 确认在线目标，或改用会话 id / 显式别名",
        );
      }
      if (hits.length > 1) {
        return failure(
          "target_ambiguous",
          `别名「${target}」命中多个会话：${hits
            .map((hit) => hit.sessionId)
            .join(", ")}`,
          "改用会话 id 精确指定（别名表异常时用 alias clear 清理重复项）",
        );
      }
      const sessionId = hits[0]!.sessionId;
      if (!online.some((peer) => peer.sessionId === sessionId)) {
        return failure(
          "target_offline",
          `别名「${target}」指向的会话不在线：${sessionId}`,
          "先用 session_channel peers 确认它在线（离线不排队）",
        );
      }
      return { ok: true as const, sessionId };
    },

    async delegate(input) {
      const result = await face.delegate({
        from: input.from,
        to: input.to,
        text: input.text,
        timeoutSec: input.timeoutSec,
      });
      if (!result.ok) {
        return failure(
          result.error ?? "transport_error",
          result.message ?? `投递失败：${result.error ?? "未知原因"}`,
          "用 session_channel peers 确认目标在线后重试（离线不排队）",
          result.candidates === undefined
            ? {}
            : { candidates: result.candidates },
        );
      }
      const taskId = result.task?.id ?? "";
      if (taskId === "") {
        return failure(
          "transport_error",
          "投递成功但返回体没有任务 id",
          "检查 session-channel 版本：delegate 的返回体须含 task.id",
        );
      }
      return { ok: true as const, taskId };
    },

    async sendMessage(input) {
      const result = await face.send({
        to: input.to,
        text: input.text,
        waitMs: 1200,
      });
      if (!result.ok) {
        return failure(
          result.error ?? "transport_error",
          result.message ?? `发送失败：${result.error ?? "未知原因"}`,
          "用 session_channel peers 确认目标在线后重试（离线不排队）",
          result.candidates === undefined
            ? {}
            : { candidates: result.candidates },
        );
      }
      return { ok: true as const, delivered: result.delivered === true };
    },

    async taskStatus(taskId) {
      const result = await face.taskStatus(taskId);
      if (!result.ok || result.task === undefined) {
        if (result.error === "task_not_found") {
          return failure(
            "task_not_found",
            `任务记录不存在：${taskId}`,
            "任务表 TTL 7 天，可能已过期；用 status 查看组内最近回报",
          );
        }
        return failure(
          result.error ?? "transport_error",
          `读取任务失败：${result.error ?? "未知原因"}`,
          "确认 session-channel 已连接（session_channel action=status）后重试",
        );
      }
      const status = statusOf(result.task.status);
      if (status === undefined) {
        return failure(
          "transport_error",
          `未知任务状态：${result.task.status}`,
          "检查 session-channel 版本与本包的 TaskSnapshot 口径",
        );
      }
      return {
        ok: true as const,
        task: {
          status,
          ...(result.task.result === undefined
            ? {}
            : { result: result.task.result }),
          ...(result.task.error === undefined
            ? {}
            : { error: result.task.error }),
          ...(result.task.resultTruncated === true
            ? { resultTruncated: true }
            : {}),
        },
      };
    },
  };
}

export type { GroupFailure };
