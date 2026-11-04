// TUI/src/app/adapter/types/session.ts — 历史会话记录、查询与标题面

/** 单条历史会话记录（宿主 @deepseek-ai/dsh-session-query SessionRecord 的归一化面） */
export interface SessionInfo {
  id: string;
  /** 创建时间（Unix 毫秒） */
  createdAt: number;
  /** 编辑时间（Unix 毫秒；TUI#1）：会话日志末条事件 `time`（listEvents），
   *  缺失/读取失败回退 `createdAt`。列表与「最近退出」选择一律按它从晚到早。 */
  updatedAt?: number | undefined;
  /** 会话启动时工作目录（列表展示用） */
  cwd?: string | undefined;
  /** 是否 live 会话（内存 store 中）：当前活跃标 [当前]、其余 live 标 [不可续] 不可选中 */
  live: boolean;
  /** 是否当前活跃 live 会话（adapter 视角权威：初始 opts.sessionId、resume 后切换）；
   *  列表行标记 [当前] */
  current?: boolean | undefined;
  /** 是否已持久化到磁盘 */
  persisted: boolean;
  /** 空会话（persisted 且从未有用户消息）：供列表标注与“清理空会话”的计数与范围判定；
   *  读取面不可用或未判定时省略（不臆断为空） */
  isEmpty?: boolean | undefined;
  /** surface 探针确认「已有用户消息」（TUI#23）：`false` = 读取面可读且确无用户消息
   *  （刚起的新会话）；`true` / 省略 = 有内容或未判定（保守视为已使用）。
   *  `/continue` 用它区分「用过的当前会话」与「刚起的新会话」。 */
  hasPrompt?: boolean | undefined;
  /** 会话标题：官方 session/title 事件标题，缺失时本地兜底（首条用户消息前 30 字符）；
   *  两者皆无 → 省略（列表渲染占位（新会话）） */
  title?: string | undefined;
}

/** 删除会话结果：ok=false 时 reason 为可见失败原因（不可删 / 未找到 / 越界 / IO 失败） */
export type SessionDeleteResult = { ok: true } | { ok: false; reason: string };

/** 历史会话只读表面的归一化消息。
 *  - `user` / `assistant`：正文消息；
 *  - `step`（P9）：按 step 折叠的**工具概要行**，text 形如
 *    `22:31:05 #3`（旧版折叠成 `read ×2, bash ×1` 概要行的做法已下线）；
 *    无工具调用的 step 不产出行，参数摘要/结果详情/thinking 均不还原；
 *  - `notice`（TUI#17）：插件注入消息 `source.form:'notice'` 的**一行摘要**（summary，
 *    缺失时取正文首行）——渲染为单行提示，不展开、不占用户消息块。 */
export interface HistoryMessage {
  role: "user" | "assistant" | "step" | "notice" | "tool";
  text: string;
  /** 宿主回合号（转录事件自带）：恢复路径保留宿主索引用，缺省 = 该事件无回合标记 */
  turn?: number;
  /**
   * 用户块终态（BACKLOG「恢复的会话记录也保留用户块终态符号」）：按该回合 `turn/end` 的
   * reason 读回（`normalizeHistoryMessages` 建 (turn → status) 映射后落到**该回合最后一个**
   * 用户消息上），与实时路径 `sections.ts` 的 `userStatusOfReason` 同口径（completed →
   * `success` / aborted → `aborted` / error → `failure`，其余原因不落终态）。
   */
  status?: "success" | "failure" | "aborted";
  /**
   * 被 steer 续接过的用户块（BACKLOG #23②）：宿主在 step 边界认领 steer 时摘除排队项
   * （`agent/inbox/spliced` 的 `removedCount > 0 && target === "next-step"`）→ 恢复时给
   * **上一条用户消息**打此标；渲染为永久 `←`（不随终态覆盖，与实时路径同口径）。
   */
  steerContinued?: boolean;
}

/** 单个历史会话的只读表面视图（归一化后的消息列表） */
export interface SessionSurfaceView {
  sessionId: string;
  messages: HistoryMessage[];
}

/** 宿主会话标题服务结构面（ctx.get('sessionTitle')，@deepseek-ai/dsh-session-title）；
 *  rename 首参为 **live Session 对象**（非 id 字符串），返回快照；服务缺失时 /rename 提示不可用。 */
/** 宿主会话标题快照结构面（`sessionTitle.rename` 返回；TUI 不解释内部结构，只看调用是否抛错） */
export interface SessionTitleSnapshotLike {
  title?: string;
}

/** live Session 句柄：对 TUI 不透明（不读任何字段），仅原样透传给宿主服务。 */
export type LiveSessionHandle = Record<string, unknown>;

export interface SessionTitleLike {
  /** 首参为 live Session 对象（见 LiveSessionHandle） */
  rename?(session: LiveSessionHandle, title: string): SessionTitleSnapshotLike;
}

/** 宿主会话存储服务结构面（ctx.get('sessions')，dsh-session SessionStore；读 live 会话原始事件用） */
export interface SessionStoreLike {
  get(sessionId: string):
    | {
        id: string;
        events: readonly Record<string, unknown>[];
      }
    | undefined;
  /** 分叉源会话为新会话（dsh-session SessionStore.fork；后两参可省：省略 boundary =
   *  源会话当前最后事件、省略 childSessionId = store 的 id 策略）。返回 live Session；
   *  错误码 5 个（SESSION_NOT_FOUND/SESSION_NOT_LIVE/SESSION_ALREADY_EXISTS/
   *  INVALID_BOUNDARY/OPEN_TURN）以宿主错误（code 字段）抛出。 */
  fork?(
    source: string,
    boundary?: unknown,
    childSessionId?: string,
  ): { id: string; title?: string } | undefined;
}

/** 宿主会话查询服务结构面（ctx.get('sessionQuery')，@deepseek-ai/dsh-session-query；契约见 docs/host/DSH-CTX-API.md） */
export interface SessionQueryLike {
  listSessions(): Promise<
    readonly {
      header: { id: string; createdAt: number; cwd?: string };
      live: boolean;
      persisted: boolean;
    }[]
  >;
  /** 完整原始事件日志；内部经 Session.create 全量校验，混合日志（agent/inbox/spliced + 未 identified user/message）会抛校验错，仅作最后兜底 */
  readSession?(sessionId: string): Promise<{
    session: { id: string };
    events: readonly Record<string, unknown>[];
  }>;
  /** 当前模型表面事件（persisted 会话可用；live 会话内存事件缺 surfaceOp 标记 surface fold → 返回空） */
  readSurface?(sessionId: string): Promise<{
    session: { id: string };
    events: readonly Record<string, unknown>[];
  }>;
  /** 轻量原始事件记录（升序 seq；TUI#1 仅消费末条 `time` 作「编辑时间」） */
  listEvents?(sessionId: string): Promise<readonly { time?: number }[]>;
  /** 折叠最新 session/title 事件标题（官方 @deepseek-ai/dsh-session-title 落盘日志；
   *  live 优先→persisted；无标题事件返回 undefined） */
  readTitle?(sessionId: string): Promise<{ title: string } | undefined>;
  /**
   * 批量折叠标题（单次 corpus 观察，比逐条 readTitle 高效；缺失服务时省略）。
   * 官方契约为 settlement 形态：每条为 fulfilled（value: {session, title?}）或
   * rejected（reason）——仅消费 fulfilled 的 value.title。
   */
  readTitleSnapshots?(ids: string[]): Promise<
    readonly (
      | {
          sessionId: string;
          status: "fulfilled";
          value: { title?: { title: string } | undefined };
        }
      | { sessionId: string; status: "rejected"; reason?: unknown }
    )[]
  >;
}
