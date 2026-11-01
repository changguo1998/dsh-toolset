/**
 * 动作内核: `GroupService` 持每管理者会话的状态缓存、串行锁与镜像计数, 按 action 分派;
 * 具体编排按职责分在 `src/group.ts`（组）/ `src/member.ts`（成员）/ `src/link.ts`（连接）/
 * `src/instruction.ts`（指令与结算）, 各层只经 `GroupActionHost` 协作面读写内核状态。
 *
 * 并发：同一管理者的动作串在一条 promise 链上（同会话内不会两次读到同一份旧状态）。
 */

import { randomUUID } from "node:crypto";

import { systemTimers } from "@dsh-toolset/clock-base";

import type { GroupActionHost, MirrorStats } from "./action-host.ts";
import { describe } from "./errors.ts";
import {
  closeGroup as groupCloseGroup,
  createGroup as groupCreateGroup,
  status as groupStatus,
} from "./group.ts";
import {
  addMember as memberAddMember,
  memberStatesOf,
  removeMember as memberRemoveMember,
} from "./member.ts";
import {
  broadcast as connectBroadcast,
  link as connectLink,
  linkPeer as connectLinkPeer,
  sendPeer as connectSendPeer,
} from "./link.ts";
import {
  check as instructionCheck,
  send as instructionSend,
} from "./instruction.ts";
import { failure, groupView, isFailure, pickGroup } from "./model.ts";
import type {
  ActionResult,
  AgentGroupBook,
  AgentGroupState,
  BookStore,
  GroupFailure,
  GroupMirror,
  GroupTransport,
  MemberStateView,
  ResolvedConfig,
} from "./types.ts";

/** 动作层依赖（全部可注入：单测不碰 Redis、不碰真文件系统）。 */
export interface GroupServiceOptions {
  store: BookStore;
  transport: GroupTransport;
  mirror?: GroupMirror;
  config: ResolvedConfig;
  now?: () => number;
  newId?: () => string;
  log?: (message: string) => void;
  /** 定时器面（2b 状态轮询用；缺省进程内 `setInterval` + unref）。 */
  timers?: { interval(delayMs: number, callback: () => void): () => void };
}

/** 状态缓存键（`<manager>\0<group>`；`\0` 分隔避免组名里出现前缀碰撞）。 */
function stateCacheKey(manager: string, group: string): string {
  return `${manager}\0${group}`;
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
  readonly #timers: NonNullable<GroupServiceOptions["timers"]>;
  /** 动作层协作面（各层经它读写内核状态, 不直接碰缓存与串行锁）。 */
  readonly #host: GroupActionHost;
  /** 状态轮询（2b，组长侧）：每组长一个 tick 遍历其全部组；`interval` 未引用。 */
  #pollTimer: (() => void) | undefined;
  /** 状态巡查见过的组长集合（`run` 时记录调用方）。 */
  #knownManagers = new Set<string>();
  /** 组长名下各组的成员状态缓存（`<manager>\0<group>` → 判定视图；写动作后失效）。 */
  #stateCache = new Map<string, MemberStateView[]>();
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
    this.#timers = options.timers ?? systemTimers();
    this.#host = {
      transport: this.#transport,
      config: this.#config,
      now: () => this.#now(),
      newId: () => this.#newId(),
      load: (managerSessionId) => this.#load(managerSessionId),
      persist: (book) => this.#persist(book),
      locked: (manager, run) => this.#locked(manager, run),
      guard: (what, run) => this.#guard(what, run),
      mirrorGroup: (group) => this.#mirrorGroup(group),
      stateFailure: () => this.#stateFailure(),
      mirrorReport: () => this.#mirrorReport(),
      statesOf: (manager, group) => this.statesOf(manager, group),
      noteManager: (manager) => {
        this.#knownManagers.add(manager);
      },
      closedGuard: (book, groupName) => this.#closedGuard(book, groupName),
    };
    if (this.#config.statusPollMs > 0) {
      // 2b：内建组长侧轮询（状态巡查），间隔可配（缺省 20 s；0 = 不轮询）
      this.#pollTimer = this.#timers.interval(this.#config.statusPollMs, () => {
        void this.refreshMemberStates().catch((err: unknown) =>
          this.#log(`状态巡查失败：${describe(err)}`),
        );
      });
    }
  }

  /** 按 action 分派（工具出口；`caller` = 调用方会话 id）。 */
  async run(
    action: string,
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    // 组长归属：记录出现过的调用方会话，供状态巡查扫其名下的组（2b）
    if (caller !== "") this.#host.noteManager(caller);
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
      case "close_group":
        return this.closeGroup(args, caller);
      case "status":
        return this.status(args, caller);
      default:
        return failure(
          "unknown_action",
          `未知 action：${action === "" ? "（空）" : action}`,
          "action 用 create_group / add_member / link / link_peer / send / send_peer / broadcast / check / remove / close_group / status",
        );
    }
  }

  /** 建组（管理者 = 调用方会话；只带组级参数，决策项 11）。 */
  async createGroup(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return groupCreateGroup(this.#host, args, caller);
  }

  /** 加成员（一次一个；目标须在线且唯一命中，决策项 3 / 11）。 */
  async addMember(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return memberAddMember(this.#host, args, caller);
  }

  /** 建立主从连接（主 → 从；从方须自由代理，等级 = 主 + 1，决策项 9）。 */
  async link(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return connectLink(this.#host, args, caller);
  }

  /** 发指令（主 → 从；每连接同时只允许一条未结，决策项 14）。 */
  async send(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return instructionSend(this.#host, args, caller);
  }

  /** 检查（懒判定结算：成功 / 超时 / 失败；缺 `to` 则全组）。 */
  async check(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return instructionCheck(this.#host, args, caller);
  }

  /** 移除成员（逐层下推；非叶子被拒并列出剩余从代理，决策项 10 / 18）。 */
  async remove(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return memberRemoveMember(this.#host, args, caller);
  }

  /** 关闭组（#4 裁定 3）：仅组长（创建组的 agent）可关；关闭 = 组内派发任务结束、
   *  未结指令终止（timeout + cause）、连接关系关闭（此后写动作拒绝）、不连带关成员。 */
  async closeGroup(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return groupCloseGroup(this.#host, args, caller);
  }

  /** 建立平等连接（双向、无等级；每对 agent 每种连接至多一条，决策项 4 / 6）。 */
  async linkPeer(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return connectLinkPeer(this.#host, args, caller);
  }

  /** 经平等连接发一条「发完即走」的消息（决策项 6：不等回复、不重试、不留状态）。 */
  async sendPeer(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return connectSendPeer(this.#host, args, caller);
  }

  /** 广播：按当前成员集合逐条发送并汇总送达 / 失败（决策项 13 / 20）。 */
  async broadcast(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return connectBroadcast(this.#host, args, caller);
  }

  /** 只读查看（成员、等级与主从关系、未结指令、最近一次回报，决策项 17）。 */
  async status(
    args: Record<string, unknown>,
    caller: string,
  ): Promise<ActionResult> {
    return groupStatus(this.#host, args, caller);
  }

  /** 组长名下某组的成员状态视图（2b）：缓存优先，缺失则现算并入缓存。 */
  async statesOf(
    manager: string,
    group: AgentGroupState,
  ): Promise<MemberStateView[] | undefined> {
    const cached = this.#stateCache.get(stateCacheKey(manager, group.name));
    if (cached !== undefined) return cached;
    const states = await memberStatesOf(
      group,
      this.#transport,
      this.#now(),
      this.#config.stuckAfterMs,
    );
    if (states !== undefined) {
      this.#stateCache.set(stateCacheKey(manager, group.name), states);
    }
    return states;
  }

  /** 状态巡查主体（2b）：遍历已知组长，**按组长归属去重**刷新其全部组的状态缓存。 */
  async refreshMemberStates(): Promise<void> {
    for (const manager of this.#knownManagers) {
      const book = await this.#load(manager);
      if (book === undefined) continue;
      for (const group of Object.values(book.groups)) {
        const states = await memberStatesOf(
          group,
          this.#transport,
          this.#now(),
          this.#config.stuckAfterMs,
        );
        if (states !== undefined) {
          this.#stateCache.set(stateCacheKey(manager, group.name), states);
        }
      }
    }
  }

  /** 状态缓存条目数（诊断 / 测试）。 */
  get cachedStateEntries(): number {
    return this.#stateCache.size;
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
    // 写动作改变了组 → 该组长名下组的状态缓存失效（2b：下次 status / 巡查重算）
    const prefix = `${book.managerSessionId}\0`;
    for (const key of [...this.#stateCache.keys()]) {
      if (key.startsWith(prefix)) this.#stateCache.delete(key);
    }
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

  /** 已关闭组守卫：写动作 load 后调用；组不存在 / 已关闭 → 失败信封（`group_closed`）。 */
  #closedGuard(
    book: AgentGroupBook,
    groupName: string,
  ): GroupFailure | undefined {
    const group = pickGroup(book, groupName);
    if (isFailure(group)) return group;
    if (group.closedAt !== undefined) {
      return failure(
        "group_closed",
        `组「${group.name}」已关闭`,
        "已关闭组不接受任何写动作；如需新组请 create_group 重建",
      );
    }
    return undefined;
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
