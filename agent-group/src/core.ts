/**
 * 动作层：7 个动作（`create_group` / `add_member` / `link` / `send` / `check` / `remove` /
 * `status`）的编排 —— 读状态 → 纯迁移（`src/model.ts`）→ 落盘 → 可选镜像 → 返回结果。
 *
 * 三条机制在这里落地：
 * - **每连接一条未结**（决策项 14）：`send` 前由模型层校验，发第二条即被拒；
 * - **懒判定结算**：`check` 时才向传输读任务，三种收场 = 回报已到 / 超出等待上限 / 成员已移除；
 * - **拒绝带原因 + 下一步**（决策项 18）：所有失败都经 `failure()` 构造。
 *
 * 并发：同一管理者的动作串在一条 promise 链上（同会话内不会两次读到同一份旧状态）。
 */

import { randomUUID } from "node:crypto";

import {
  addMember as modelAddMember,
  assignTaskId as modelAssignTaskId,
  createGroup as modelCreateGroup,
  failure,
  groupView,
  invariantViolations,
  isFailure,
  linkMembers as modelLinkMembers,
  linkPeer as modelLinkPeer,
  MANAGER_NAME,
  membersOf,
  nameError,
  openInstruction as modelOpenInstruction,
  openInstructionOf,
  peerPairKey,
  pickGroup,
  removeMember as modelRemoveMember,
  settleInstruction as modelSettleInstruction,
} from "./model.ts";
import type {
  ActionResult,
  AgentGroupBook,
  AgentGroupConfig,
  AgentGroupState,
  BookStore,
  GroupFailure,
  GroupInstruction,
  GroupMirror,
  GroupTransport,
  GroupView,
  InstructionOutcome,
  ResolvedConfig,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 50;
const STATE_FILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** 归一配置（缺省值见 `src/types.ts` 的 `AgentGroupConfig`）。 */
export function resolveConfig(config: AgentGroupConfig = {}): ResolvedConfig {
  const requested = config.stateFileName;
  const fileName =
    typeof requested === "string" &&
    STATE_FILE_RE.test(requested) &&
    !requested.includes("..") &&
    requested !== "."
      ? requested
      : "agent-group.json";
  return {
    enabled: config.enabled !== false,
    defaultTimeoutMs: positiveNumber(
      config.defaultTimeoutMs,
      DEFAULT_TIMEOUT_MS,
    ),
    maxInstructionRecords: positiveNumber(
      config.maxInstructionRecords,
      DEFAULT_MAX_RECORDS,
    ),
    mirror: config.mirror !== false,
    stateFileName: fileName,
  };
}

/** 错误对象 → 一句人话。 */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 镜像计数（`status` 动作里暴露，便于排障）。 */
export interface MirrorStats {
  enabled: boolean;
  ok: number;
  failed: number;
  lastError?: string;
}

/** 动作层依赖（全部可注入：单测不碰 Redis、不碰真文件系统）。 */
export interface GroupServiceOptions {
  store: BookStore;
  transport: GroupTransport;
  mirror?: GroupMirror;
  config: ResolvedConfig;
  now?: () => number;
  newId?: () => string;
  log?: (message: string) => void;
}

/**
 * 只读组清单（TUI `/group` 服务面）：按管理者会话 id 读落盘书，返回每组的只读视图。
 * 只读、不落盘、不镜像；文件缺失（ENOENT）由 `store.load` 按空组集处理。
 */
export async function readGroupStatus(
  store: BookStore,
  managerSessionId: string,
  groupName?: string,
): Promise<
  { ok: true; groups: Array<{ name: string; view: GroupView }> } | GroupFailure
> {
  let book: AgentGroupBook;
  try {
    book = await store.load(managerSessionId);
  } catch (error) {
    return failure(
      "state_unavailable",
      `读取组状态失败：${describe(error)}`,
      "确认该会话目录存在且 agent-group.json 可读",
    );
  }
  const requested = (groupName ?? "").trim();
  if (requested !== "") {
    const group = book.groups[requested];
    if (group === undefined) {
      return failure(
        "group_not_found",
        `组「${requested}」不存在`,
        `现有组：${Object.keys(book.groups).join(", ") || "（无）"}`,
      );
    }
    return {
      ok: true,
      groups: [{ name: group.name, view: groupView(group) }],
    };
  }
  return {
    ok: true,
    groups: Object.keys(book.groups)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, view: groupView(book.groups[name]!) })),
  };
}

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

/** 组编排服务：一串动作 + 每个管理者会话一份状态缓存。 */
export class GroupService {
  readonly #store: BookStore;
  readonly #transport: GroupTransport;
  readonly #mirror: GroupMirror | undefined;
  readonly #config: ResolvedConfig;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #log: (message: string) => void;
  readonly #books = new Map<string, AgentGroupBook>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #mirrorStats = { ok: 0, failed: 0, lastError: "" };
  #lastStateError = "";
  #mirrorLogged = false;

  constructor(options: GroupServiceOptions) {
    this.#store = options.store;
    this.#transport = options.transport;
    this.#mirror = options.mirror;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#log = options.log ?? (() => {});
  }

  /** 按 action 分派（工具出口；`caller` = 调用方会话 id）。 */
  async run(
    action: string,
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    switch (action) {
      case "create_group":
        return this.createGroup(args, caller);
      case "add_member":
        return this.addMember(args, caller);
      case "link":
        return this.link(args, caller);
      case "link_peer":
        return this.linkPeer(args, caller);
      case "send":
        return this.send(args, caller);
      case "send_peer":
        return this.sendPeer(args, caller);
      case "broadcast":
        return this.broadcast(args, caller);
      case "check":
        return this.check(args, caller);
      case "remove":
        return this.remove(args, caller);
      case "status":
        return this.status(args, caller);
      default:
        return failure(
          "unknown_action",
          `未知 action：${action === "" ? "（空）" : action}`,
          "action 用 create_group / add_member / link / link_peer / send / send_peer / broadcast / check / remove / status",
        );
    }
  }

  /** 建组（管理者 = 调用方会话；只带组级参数，决策项 11）。 */
  async createGroup(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return this.#locked(caller, async () => {
      const book = await this.#load(caller);
      if (book === undefined) return this.#stateFailure();
      const applied = modelCreateGroup(book, {
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        managerSessionId: caller,
        now: this.#now(),
        id: this.#newId(),
      });
      if (isFailure(applied)) return applied;
      const saved = await this.#persist(applied.book);
      if (saved !== undefined) return saved;
      await this.#mirrorGroup(applied.group);
      return {
        ok: true,
        action: "create_group",
        group: applied.group.name,
        view: groupView(applied.group),
        next: `加成员：add_member group=${applied.group.name} name=<组内名> target=<会话 id 或别名>`,
      };
    });
  }

  /** 加成员（一次一个；目标须在线且唯一命中，决策项 3 / 11）。 */
  async addMember(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return this.#locked(caller, async () => {
      const book = await this.#load(caller);
      if (book === undefined) return this.#stateFailure();
      const groupName = stringArg(args, "group");
      const name = stringArg(args, "name");
      const target = stringArg(args, "target");
      const found = pickGroup(book, groupName);
      if (isFailure(found)) return found;
      const bad = nameError("成员名", name);
      if (bad !== undefined) {
        return failure(
          "invalid_argument",
          bad,
          "成员名用 1-32 位 [A-Za-z0-9_-]",
        );
      }
      const resolved = await this.#guard("寻址目标", () =>
        this.#transport.resolve(target),
      );
      if (isFailure(resolved)) return { ...resolved, group: groupName };
      const applied = modelAddMember(book, {
        group: groupName,
        name,
        target,
        sessionId: resolved.sessionId,
        now: this.#now(),
      });
      if (isFailure(applied)) return applied;
      const saved = await this.#persist(applied.book);
      if (saved !== undefined) return saved;
      await this.#mirrorGroup(applied.group);
      return {
        ok: true,
        action: "add_member",
        group: groupName,
        member: name,
        sessionId: resolved.sessionId,
        view: groupView(applied.group),
        next: `建立主从连接：link group=${groupName} from=<主方> to=${name}（从方须是自由代理）`,
      };
    });
  }

  /** 建立主从连接（主 → 从；从方须自由代理，等级 = 主 + 1，决策项 9）。 */
  async link(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return this.#locked(caller, async () => {
      const book = await this.#load(caller);
      if (book === undefined) return this.#stateFailure();
      const groupName = stringArg(args, "group");
      const applied = modelLinkMembers(book, {
        group: groupName,
        from: stringArg(args, "from"),
        to: stringArg(args, "to"),
        now: this.#now(),
      });
      if (isFailure(applied)) return applied;
      const saved = await this.#persist(applied.book);
      if (saved !== undefined) return saved;
      await this.#mirrorGroup(applied.group);
      return {
        ok: true,
        action: "link",
        group: groupName,
        from: applied.link.from,
        to: applied.link.to,
        level: applied.link.level,
        view: groupView(applied.group),
        next: `发指令：send group=${groupName} to=${applied.link.to} text=<正文>（每连接同时只允许一条未结）`,
      };
    });
  }

  /** 发指令（主 → 从；每连接同时只允许一条未结，决策项 14）。 */
  async send(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return this.#locked(caller, async () => {
      const book = await this.#load(caller);
      if (book === undefined) return this.#stateFailure();
      const groupName = stringArg(args, "group");
      const to = stringArg(args, "to");
      const timeoutMs =
        typeof args.timeoutMs === "number"
          ? args.timeoutMs
          : this.#config.defaultTimeoutMs;
      const applied = modelOpenInstruction(book, {
        group: groupName,
        to,
        text: stringArg(args, "text"),
        timeoutMs,
        now: this.#now(),
        id: this.#newId(),
        maxRecords: this.#config.maxInstructionRecords,
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
      const sent = await this.#guard("投递指令", () =>
        this.#transport.delegate({
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
          now: this.#now(),
        });
        if (isFailure(settled)) return settled;
        const saved = await this.#persist(settled.book);
        if (saved !== undefined) return saved;
        await this.#mirrorGroup(settled.group);
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
      const saved = await this.#persist(attached.book);
      if (saved !== undefined) {
        // 已投递、但状态没落盘：把 taskId 带回去，至少能按任务表追这条指令。
        return {
          ...saved,
          instructionId: instruction.id,
          taskId: sent.taskId,
        };
      }
      await this.#mirrorGroup(attached.group);
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
  async check(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return this.#locked(caller, async () => {
      const book = await this.#load(caller);
      if (book === undefined) return this.#stateFailure();
      const groupName = stringArg(args, "group");
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
            : await this.#guard("读取任务", () =>
                this.#transport.taskStatus(taskId),
              );
        const verdict = verdictOf(open, snapshot, this.#now());
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
          now: this.#now(),
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
      const saved = await this.#persist(working);
      if (saved !== undefined) return saved;
      const group = pickGroup(working, groupName);
      if (isFailure(group)) return group;
      await this.#mirrorGroup(group);
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

  /** 移除成员（逐层下推；非叶子被拒并列出剩余从代理，决策项 10 / 18）。 */
  async remove(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return this.#locked(caller, async () => {
      const book = await this.#load(caller);
      if (book === undefined) return this.#stateFailure();
      const groupName = stringArg(args, "group");
      const applied = modelRemoveMember(book, {
        group: groupName,
        name: stringArg(args, "name"),
        now: this.#now(),
      });
      if (isFailure(applied)) return applied;
      const saved = await this.#persist(applied.book);
      if (saved !== undefined) return saved;
      await this.#mirrorGroup(applied.group);
      return {
        ok: true,
        action: "remove",
        group: groupName,
        removed: applied.removed.name,
        ...(applied.settled === undefined
          ? {}
          : { settledInstruction: applied.settled.id }),
        view: groupView(applied.group),
        next:
          applied.settled === undefined
            ? "成员已移除；用 status 查看剩余成员与连接"
            : "成员已移除，它连接上的未结指令已结算为失败（成因：成员已被移除）",
      };
    });
  }

  /** 建立平等连接（双向、无等级；每对 agent 每种连接至多一条，决策项 4 / 6）。 */
  async linkPeer(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return this.#locked(caller, async () => {
      const book = await this.#load(caller);
      if (book === undefined) return this.#stateFailure();
      const groupName = stringArg(args, "group");
      const applied = modelLinkPeer(book, {
        group: groupName,
        from: stringArg(args, "from"),
        to: stringArg(args, "to"),
        now: this.#now(),
      });
      if (isFailure(applied)) return applied;
      const saved = await this.#persist(applied.book);
      if (saved !== undefined) return saved;
      await this.#mirrorGroup(applied.group);
      return {
        ok: true,
        action: "link_peer",
        group: groupName,
        link: {
          from: applied.link.from,
          to: applied.link.to,
          createdAt: applied.link.createdAt,
        },
        view: groupView(applied.group),
        next: `经该平等连接发消息：send_peer group=${groupName} to=<另一端> text=<正文>（发完即走，无未结）`,
      };
    });
  }

  /** 经平等连接发一条「发完即走」的消息（决策项 6：不等回复、不重试、不留状态）。 */
  async sendPeer(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    const book = await this.#load(caller);
    if (book === undefined) return this.#stateFailure();
    const groupName = stringArg(args, "group");
    const to = stringArg(args, "to");
    const text = stringArg(args, "text").trim();
    const found = pickGroup(book, groupName);
    if (isFailure(found)) return found;
    const target = found.members[to];
    if (target === undefined) {
      return {
        ...failure(
          "member_not_found",
          `组里没有成员「${to}」`,
          `现有成员：${membersOf(found).join(", ")}`,
        ),
        action: "send_peer",
        group: groupName,
      };
    }
    if (text === "") {
      return {
        ...failure(
          "invalid_argument",
          "消息正文不能为空",
          "text 写清要对方看什么（平等连接为通知语义，不产生未结指令）",
        ),
        action: "send_peer",
        group: groupName,
      };
    }
    const key = peerPairKey(MANAGER_NAME, to);
    if (found.peerLinks[key] === undefined) {
      return {
        ...failure(
          "no_peer_link",
          `「${MANAGER_NAME}」与「${to}」之间没有平等连接`,
          `先 link_peer group=${groupName} from=${MANAGER_NAME} to=${to}`,
        ),
        action: "send_peer",
        group: groupName,
      };
    }
    const sent = await this.#guard("经平等连接发送", () =>
      this.#transport.sendMessage({ to: target.sessionId, text }),
    );
    if (isFailure(sent)) {
      return {
        ...sent,
        action: "send_peer",
        group: groupName,
        to,
      };
    }
    return {
      ok: true,
      action: "send_peer",
      group: groupName,
      from: MANAGER_NAME,
      to,
      delivered: sent.delivered,
      next: "发完即走，无未结指令；用 status 查看组成员与连接",
    };
  }

  /** 广播：按当前成员集合逐条发送并汇总送达 / 失败（决策项 13 / 20）。 */
  async broadcast(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    const book = await this.#load(caller);
    if (book === undefined) return this.#stateFailure();
    const groupName = stringArg(args, "group");
    const text = stringArg(args, "text").trim();
    const found = pickGroup(book, groupName);
    if (isFailure(found))
      return { ...found, action: "broadcast", group: groupName };
    if (text === "") {
      return {
        ...failure(
          "invalid_argument",
          "广播正文不能为空",
          "text 写清要成员们看什么（广播为通知语义，不产生未结指令）",
        ),
        action: "broadcast",
        group: groupName,
      };
    }
    const requested = stringArg(args, "to");
    const targets =
      requested === ""
        ? membersOf(found).filter((name) => name !== MANAGER_NAME)
        : [
            ...new Set(
              requested
                .split(/[,，\s]+/)
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ];
    for (const name of targets) {
      if (found.members[name] === undefined) {
        return {
          ...failure(
            "member_not_found",
            `组里没有成员「${name}」`,
            `现有成员：${membersOf(found).join(", ")}；广播目标用逗号或空格分隔`,
          ),
          action: "broadcast",
          group: groupName,
        };
      }
    }
    const results: Array<Record<string, unknown>> = [];
    let delivered = 0;
    for (const name of targets) {
      const member = found.members[name];
      if (member === undefined || member.role === "manager") {
        results.push({ to: name, delivered: false, error: "manager_skip" });
        continue;
      }
      const sent = await this.#guard("广播发送", () =>
        this.#transport.sendMessage({ to: member.sessionId, text }),
      );
      if (isFailure(sent)) {
        results.push({
          to: name,
          delivered: false,
          error: sent.error,
          ...(sent.reason === undefined ? {} : { reason: sent.reason }),
        });
      } else {
        if (sent.delivered) delivered += 1;
        results.push({ to: name, delivered: sent.delivered });
      }
    }
    return {
      ok: true,
      action: "broadcast",
      group: groupName,
      targets,
      results,
      delivery: {
        targets: results.length,
        delivered,
        failed: results.length - delivered,
      },
      next: "广播为发完即走通知，无未结指令；需要回报的任务请用主从 send / check",
    };
  }

  /** 只读查看（成员、等级与主从关系、未结指令、最近一次回报，决策项 17）。 */
  async status(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    // 只读：不落盘、不镜像；缓存命中时**不碰存储**（运行期 sessionDirFor 抛错也照常可读）。
    const book = await this.#load(caller);
    if (book === undefined) return this.#stateFailure();
    const group = pickGroup(book, stringArg(args, "group"));
    if (isFailure(group)) return group;
    const violations = invariantViolations(group);
    return {
      ok: true,
      action: "status",
      group: group.name,
      view: groupView(group),
      mirror: this.#mirrorReport(),
      ...(violations.length === 0 ? {} : { violations }),
      next:
        violations.length === 0
          ? "只读视图：成员 / 等级与主从关系 / 未结指令 / 最近回报"
          : "组状态存在不变量违规（见 violations）；建议重建组",
    };
  }

  // ---------- 内部：状态读写、串行化、镜像 ----------

  /** 传输调用兜异常：端口实现抛错（而非返回失败信封）也转成 `transport_error`。 */
  async #guard<T>(
    what: string,
    run: () => Promise<T | GroupFailure>,
  ): Promise<T | GroupFailure> {
    try {
      return await run();
    } catch (error) {
      return failure(
        "transport_error",
        `${what}失败：${describe(error)}`,
        "确认 session-channel 已连接（session_channel action=status）后重试",
      );
    }
  }

  /** 同管理者的动作串行（同会话内不并发读同一份旧状态）。 */
  #locked<T>(manager: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(manager) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.#locks.set(
      manager,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** 取状态：缓存优先（`status` 因此在存储失效时仍可读）。 */
  async #load(managerSessionId: string): Promise<AgentGroupBook | undefined> {
    const cached = this.#books.get(managerSessionId);
    if (cached !== undefined) return cached;
    try {
      const book = await this.#store.load(managerSessionId);
      this.#books.set(managerSessionId, book);
      return book;
    } catch (error) {
      this.#lastStateError = describe(error);
      return undefined;
    }
  }

  /** 落盘并更新缓存；失败 → `state_unavailable`（不改缓存，内存与最后一次成功写入保持一致）。 */
  async #persist(book: AgentGroupBook): Promise<GroupFailure | undefined> {
    try {
      await this.#store.save(book);
    } catch (error) {
      this.#lastStateError = describe(error);
      return this.#stateFailure();
    }
    this.#books.set(book.managerSessionId, book);
    return undefined;
  }

  #stateFailure(): GroupFailure {
    return failure(
      "state_unavailable",
      this.#lastStateError === ""
        ? "组状态不可用（存储未就绪）"
        : this.#lastStateError,
      "确认管理者会话目录存在且可写（sessionPaths.sessionDirFor），或删掉损坏的 agent-group.json 后重新 create_group",
    );
  }

  /** 镜像一次（失败只计数 + 首次一条日志，不重试、不影响动作结果）。 */
  async #mirrorGroup(group: AgentGroupState): Promise<void> {
    if (this.#mirror === undefined || !this.#config.mirror) return;
    try {
      await this.#mirror.put({
        managerSessionId: group.managerSessionId,
        group,
        view: groupView(group),
      });
      this.#mirrorStats.ok += 1;
    } catch (error) {
      this.#mirrorStats.failed += 1;
      this.#mirrorStats.lastError = describe(error);
      if (!this.#mirrorLogged) {
        this.#mirrorLogged = true;
        this.#log(
          `镜像写入 memory-base 失败（只计数不重试）：${describe(error)}`,
        );
      }
    }
  }

  #mirrorReport(): MirrorStats {
    return {
      enabled: this.#mirror !== undefined && this.#config.mirror,
      ok: this.#mirrorStats.ok,
      failed: this.#mirrorStats.failed,
      ...(this.#mirrorStats.lastError === ""
        ? {}
        : { lastError: this.#mirrorStats.lastError }),
    };
  }
}

/** 取字符串参数（去空白；非字符串 → 空串）。 */
function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

/** 管理者保留名的再导出（工具描述与读数用）。 */
export { MANAGER_NAME };
