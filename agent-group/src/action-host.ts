/**
 * 动作层共享面: 组 / 成员 / 连接 / 指令与结算四层只依赖这里的协作接口与参数小工具。
 *
 * 内核 `GroupService`（`agent-group/src/service.ts`）实现 `GroupActionHost`, 状态缓存、串行锁与
 * 镜像计数留在内核; 动作模块只表达「这一步怎么编排」, 便于分别阅读与测试。
 */

import type {
  AgentGroupBook,
  AgentGroupState,
  GroupFailure,
  GroupTransport,
  MemberStateView,
  ResolvedConfig,
} from "./types.ts";

/** 镜像计数（`status` 动作里暴露，便于排障）。 */
export interface MirrorStats {
  enabled: boolean;
  ok: number;
  failed: number;
  lastError?: string;
}

/** 内核提供给动作层的协作面（实现见 `GroupService`）。 */
export interface GroupActionHost {
  readonly transport: GroupTransport;
  readonly config: ResolvedConfig;
  now(): number;
  newId(): string;
  /** 取状态（缓存优先；存储失效时返回 undefined 并记下原因）。 */
  load(managerSessionId: string): Promise<AgentGroupBook | undefined>;
  /** 落盘并更新缓存；失败 → `state_unavailable`。 */
  persist(book: AgentGroupBook): Promise<GroupFailure | undefined>;
  /** 同管理者的动作串行。 */
  locked<T>(manager: string, run: () => Promise<T>): Promise<T>;
  /** 传输调用兜异常：端口抛错也转成 `transport_error`。 */
  guard<T>(
    what: string,
    run: () => Promise<T | GroupFailure>,
  ): Promise<T | GroupFailure>;
  /** 镜像一次（失败只计数 + 首次一条日志，不重试）。 */
  mirrorGroup(group: AgentGroupState): Promise<void>;
  stateFailure(): GroupFailure;
  mirrorReport(): MirrorStats;
  /** 成员状态视图（状态巡查缓存优先，缺失则现算并入缓存）。 */
  statesOf(
    manager: string,
    group: AgentGroupState,
  ): Promise<MemberStateView[] | undefined>;
  /** 记录出现过的组长会话（状态巡查扫其名下的组）。 */
  noteManager(manager: string): void;
  /** 已关闭组守卫：写动作 load 后调用；组不存在 / 已关闭 → 失败信封。 */
  closedGuard(
    book: AgentGroupBook,
    groupName: string,
  ): GroupFailure | undefined;
}

/** 取字符串参数（去空白；非字符串 → 空串）。 */
export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}
