/**
 * 指令与结算层: 发指令（每连接一条未结）与懒判定结算（成功 / 超时 / 失败）。
 *
 * 结算三收场（决策项 14 / 16）: 回报已到 / 超出等待上限 / 成员已移除; 读取时才判定,
 * 不在发送时轮询。
 */

import { stringArg, type GroupActionHost } from "./action-host.ts";
import {
  assignTaskId as modelAssignTaskId,
  failure,
  groupView,
  invariantViolations,
  isFailure,
  openInstruction as modelOpenInstruction,
  openInstructionOf,
  pickGroup,
  settleInstruction as modelSettleInstruction,
} from "./model.ts";
import type {
  ActionResult,
  GroupFailure,
  GroupInstruction,
  InstructionOutcome,
} from "./types.ts";

/** `check` 的单条结算结论。 */
type Verdict =
  | { open: true }
  | {
      open: false;
      status: InstructionOutcome;
      result?: string;
      cause?: string;
    };

/** 「受阻」的约定（决策项 16 的三态信封）：成员用 `failed: true` + `error: "blocked: …"` 自描述。 */
const BLOCKED_PREFIX = /^blocked:\s*/i;

/**
 * 懒判定一条未结指令（纯函数，便于单测）：
 * - 回报已到 → `done` 为成功、`failed` 为失败（`blocked:` 前缀 → 受阻）；
 * - 超时 → 通道判定（`timeout`）或本地判定（`now >= deadline`）；
 * - 其它（`pending` / `running`）→ 仍算未结。
 */
export function verdictOf(
  instruction: GroupInstruction,
  snapshot:
    | { ok: true; task: { status: string; result?: string; error?: string } }
    | GroupFailure,
  now: number,
): Verdict {
  if (!snapshot.ok) {
    if (snapshot.error === "task_not_found") {
      return {
        open: false,
        status: "failure",
        cause: "任务记录不存在（可能已过期）",
      };
    }
    return { open: false, status: "failure", cause: snapshot.reason };
  }
  const task = snapshot.task;
  switch (task.status) {
    case "done":
      return {
        open: false,
        status: "success",
        ...(task.result === undefined ? {} : { result: task.result }),
      };
    case "failed": {
      const error = task.error ?? "";
      const base = {
        open: false as const,
        ...(task.result === undefined ? {} : { result: task.result }),
      };
      if (BLOCKED_PREFIX.test(error)) {
        return {
          ...base,
          status: "blocked",
          cause: error.replace(BLOCKED_PREFIX, "") || "成员报告受阻",
        };
      }
      return {
        ...base,
        status: "failure",
        cause: error === "" ? "成员报告失败" : error,
      };
    }
    case "canceled":
      return { open: false, status: "failure", cause: "指令被取消" };
    case "timeout":
      return {
        open: false,
        status: "timeout",
        cause: `超出等待上限（${instruction.timeoutMs} ms，通道判定）`,
      };
    default:
      if (now >= instruction.deadline) {
        return {
          open: false,
          status: "timeout",
          cause: `超出等待上限（${instruction.timeoutMs} ms，本地判定）`,
        };
      }
      return { open: true };
  }
}

/** 发指令（主 → 从；每连接同时只允许一条未结，决策项 14）。 */
export async function send(
  host: GroupActionHost,
  args: Record<string, unknown>,
  caller: string,
): Promise<ActionResult> {
  return host.locked(caller, async () => {
    const book = await host.load(caller);
    if (book === undefined) return host.stateFailure();
    const groupName = stringArg(args, "group");
    const closed = host.closedGuard(book, groupName);
    if (closed !== undefined) return closed;
    const to = stringArg(args, "to");
    const timeoutMs =
      typeof args.timeoutMs === "number"
        ? args.timeoutMs
        : host.config.defaultTimeoutMs;
    const applied = modelOpenInstruction(book, {
      group: groupName,
      to,
      text: stringArg(args, "text"),
      timeoutMs,
      now: host.now(),
      id: host.newId(),
      maxRecords: host.config.maxInstructionRecords,
    });
    if (isFailure(applied)) return applied;
    const instruction = applied.instruction;
    const target = applied.group.members[to];
    if (target === undefined || target.sessionId === "") {
      return failure(
        "target_offline",
        `「${to}」没有可寻址的会话 id`,
        `用 session_channel peers 确认它在线，remove 后重新 add_member`,
      );
    }
    const sent = await host.guard("投递指令", () =>
      host.transport.delegate({
        from: instruction.fromSessionId,
        to: target.sessionId,
        text: instruction.text,
        timeoutSec: Math.max(1, Math.ceil(instruction.timeoutMs / 1000)),
      }),
    );
    if (isFailure(sent)) {
      const settled = modelSettleInstruction(applied.book, {
        group: groupName,
        instructionId: instruction.id,
        status: "failure",
        cause: sent.reason,
        now: host.now(),
      });
      if (isFailure(settled)) return settled;
      const saved = await host.persist(settled.book);
      if (saved !== undefined) return saved;
      await host.mirrorGroup(settled.group);
      return {
        ...sent,
        action: "send",
        group: groupName,
        instructionId: instruction.id,
        instruction: settled.instruction,
        next: "投递失败已结算为失败；用 session_channel peers 确认目标在线后用 send 重试",
      };
    }
    const attached = modelAssignTaskId(applied.book, {
      group: groupName,
      instructionId: instruction.id,
      taskId: sent.taskId,
    });
    if (isFailure(attached)) return attached;
    const saved = await host.persist(attached.book);
    if (saved !== undefined) {
      // 已投递、但状态没落盘：把 taskId 带回去，至少能按任务表追这条指令。
      return {
        ...saved,
        instructionId: instruction.id,
        taskId: sent.taskId,
      };
    }
    await host.mirrorGroup(attached.group);
    return {
      ok: true,
      action: "send",
      group: groupName,
      from: instruction.from,
      to,
      instructionId: instruction.id,
      taskId: sent.taskId,
      sentAt: instruction.sentAt,
      deadline: instruction.deadline,
      view: groupView(attached.group),
      next: `用 check group=${groupName} to=${to} 收取回报（结算前该连接不能再发指令）`,
    };
  });
}

/** 检查（懒判定结算：成功 / 超时 / 失败；缺 `to` 则全组）。 */
export async function check(
  host: GroupActionHost,
  args: Record<string, unknown>,
  caller: string,
): Promise<ActionResult> {
  return host.locked(caller, async () => {
    const book = await host.load(caller);
    if (book === undefined) return host.stateFailure();
    const groupName = stringArg(args, "group");
    const closed = host.closedGuard(book, groupName);
    if (closed !== undefined) return closed;
    const only = stringArg(args, "to");
    const initial = pickGroup(book, groupName);
    if (isFailure(initial)) return initial;
    const targets = only === "" ? Object.keys(initial.links).sort() : [only];
    let working = book;
    const settled: Array<Record<string, unknown>> = [];
    const stillOpen: string[] = [];
    const idle: string[] = [];
    for (const name of targets) {
      const group = pickGroup(working, groupName);
      if (isFailure(group)) return group;
      if (group.members[name] === undefined) {
        return failure(
          "member_not_found",
          `组里没有成员「${name}」`,
          `现有成员：${Object.keys(group.members).join(", ")}`,
        );
      }
      const open = openInstructionOf(group, name);
      if (open === undefined) {
        idle.push(name);
        continue;
      }
      const taskId = open.taskId ?? "";
      const snapshot =
        taskId === ""
          ? failure(
              "task_not_found",
              `指令 ${open.id} 没有任务 id（投递未完成）`,
              "该指令会被结算为失败；用 status 查看，必要时重发",
            )
          : await host.guard("读取任务", () =>
              host.transport.taskStatus(taskId),
            );
      const verdict = verdictOf(open, snapshot, host.now());
      if (verdict.open) {
        stillOpen.push(name);
        continue;
      }
      const applied = modelSettleInstruction(working, {
        group: groupName,
        instructionId: open.id,
        status: verdict.status,
        ...(verdict.result === undefined ? {} : { result: verdict.result }),
        ...(verdict.cause === undefined ? {} : { cause: verdict.cause }),
        now: host.now(),
      });
      if (isFailure(applied)) return applied;
      working = applied.book;
      settled.push({
        to: name,
        instructionId: open.id,
        status: verdict.status,
        ...(verdict.result === undefined ? {} : { result: verdict.result }),
        ...(verdict.cause === undefined ? {} : { cause: verdict.cause }),
      });
    }
    const saved = await host.persist(working);
    if (saved !== undefined) return saved;
    const group = pickGroup(working, groupName);
    if (isFailure(group)) return group;
    await host.mirrorGroup(group);
    const violations = invariantViolations(group);
    return {
      ok: true,
      action: "check",
      group: groupName,
      checked: targets,
      settled,
      open: stillOpen,
      idle,
      ...(violations.length === 0 ? {} : { violations }),
      view: groupView(group),
      next:
        settled.length > 0
          ? "回报已结算；按需继续发指令，或 remove 收尾"
          : stillOpen.length > 0
            ? "仍有未结指令：稍后再 check（结算前该连接不能再发指令）"
            : "组内没有未结指令",
    };
  });
}
