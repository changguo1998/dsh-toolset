// src/types.ts — session-channel 的类型面与错误分类。
//
// 与实现解耦：配置项、在线对端、发送/收件结果、共享 KV 条目、委托任务记录、错误码（调用方按 code 分支，不解析 message）。

/** 插件配置（`cordis.patch.yml` 的 `session-channel` 节点）。 */
export interface SessionChannelConfig {
  /** Redis 地址：`redis://…` URL 或 unix socket 路径；缺省 `$XDG_RUNTIME_DIR/dsh-session-channel.sock`。 */
  url?: string;
  /** 心跳间隔 ms（缺省 5000）。 */
  heartbeatMs?: number;
  /** 在线键 TTL 秒（缺省 15，须大于心跳间隔）。 */
  presenceTtlSec?: number;
  /** 单条正文上限（UTF-8 字节，缺省 8192）。 */
  maxTextBytes?: number;
  /** 注入正文前缀（缺省 `[CHANNEL]`；正文形如 `<prefix>(<来源>) <正文>`）。 */
  prefix?: string;
  /** 本实例标识（缺省随机生成；测试注入用）。 */
  instanceId?: string;
  /** profile 名（写入在线元数据，缺省取 `DSH_PROFILE`）。 */
  profile?: string;
  /** 阻塞读的单次等待上限 ms（缺省 15000）。 */
  readBlockMs?: number;
  /** true = 只加载不连接（离线环境静默降级）。 */
  disabled?: boolean;
}

/** 一个在线对端（在线键的值）。 */
export interface PeerInfo {
  /** 会话 id（寻址主键）。 */
  sessionId: string;
  /** 持有该会话的进程 pid（存活快检与排障用）。 */
  pid: number;
  /** 进程实例标识（同进程多会话共享）。 */
  instanceId: string;
  /** 会话工作目录（`cwd:<path>` 寻址用；未知为空串）。 */
  cwd: string;
  /** profile 名（缺省空串）。 */
  profile: string;
  /** 进程启动时刻（epoch ms）。 */
  startedAt: number;
}

/** 发送请求。 */
export interface SendRequest {
  /** 发送方会话 id（写入消息体，供接收方显示来源）。 */
  from?: string;
  /** 目标：会话 id 精确匹配 / 别名，或 `cwd:<绝对路径>`（`cwd:` 前缀按路径匹配，见 `resolveTarget`）。 */
  to: string;
  /** 正文（注入时加前缀）。 */
  text: string;
  /** > 0 时等待回执的毫秒数（缺省不等）。 */
  waitMs?: number;
}

/** 发送结果。 */
export interface SendResult {
  ok: boolean;
  /** 消息 id（= Redis 流条目 id），入队成功即返回。 */
  messageId?: string;
  /** 是否在等待窗口内收到「已注入」回执。 */
  delivered?: boolean;
  /** 命中的目标（唯一命中时）。 */
  target?: PeerInfo;
  /** 失败原因（ok=false）。 */
  error?: string;
  /** 多目标命中时的候选会话（供调用方改精确指定）。 */
  candidates?: PeerInfo[];
}

/** 收件箱条目（新→旧）。 */
export interface InboxMessage {
  /** 消息 id（流条目 id）。 */
  id: string;
  /** 来源会话 id（可能为空）。 */
  from: string;
  /** 来源会话工作目录。 */
  fromCwd: string;
  /** 正文。 */
  text: string;
  /** 发送时刻（epoch ms）。 */
  ts: number;
}

/** 错误码（稳定标识，调用方按码分支）。 */
export type SessionChannelErrorCode =
  | "bad_config"
  | "unavailable"
  | "schema_mismatch"
  | "text_too_large"
  | "target_offline"
  | "target_ambiguous"
  | "kv_key_invalid"
  | "kv_value_invalid"
  | "kv_value_too_large"
  | "kv_conflict"
  | "task_invalid"
  | "task_not_found"
  | "task_result_too_large";

/** 共享 KV 条目（last-value + 单调版本号，跨会话 / 跨进程共见）。 */
export interface KvEntry {
  /** KV 键名（`[A-Za-z0-9_.-]{1,64}`）。 */
  key: string;
  /** 任意 JSON 可序列化值。 */
  value: unknown;
  /** 单调递增版本号（每次成功写入 +1；键删除后从 1 重新计）。 */
  version: number;
  /** 最近写入时刻（epoch ms）。 */
  updatedAt: number;
}

/** 共享 KV 写入选项。 */
export interface KvPutOptions {
  /** 期望的当前版本（提供时做 CAS：不匹配 → `kv_conflict`）。 */
  expectedVersion?: number;
  /** > 0 时设置过期秒数（缺省不过期）。 */
  ttlSec?: number;
  /** 值字节上限（UTF-8，缺省 8192，取自插件配置 `maxTextBytes`）。 */
  maxBytes?: number;
}

/** 共享 KV 写入结果。 */
export interface KvSetResult {
  ok: boolean;
  /** 成功时的条目快照。 */
  entry?: KvEntry;
  /** 版本冲突时的当前值（供调用方合并后重试）。 */
  current?: KvEntry;
  /** 失败原因（ok=false；稳定码，见 `SessionChannelErrorCode` 的 `kv_*`）。 */
  error?: string;
  /** 人类可读说明（ok=false）。 */
  message?: string;
}

/** 共享 KV 删除结果。 */
export interface KvDeleteResult {
  ok: boolean;
  /** 是否确实删除了已有键（false = 键本就不存在）。 */
  deleted?: boolean;
  error?: string;
  message?: string;
}

/** 委托任务状态：pending（已建）→ running（已注入 worker）→ 终态 done/failed/canceled/timeout。 */
export type TaskStatus =
  "pending" | "running" | "done" | "failed" | "canceled" | "timeout";

/** 委托任务记录（Redis `task:<id>` 的值；跨会话 / 跨进程共见）。 */
export interface TaskRecord {
  /** 任务 id（`[A-Za-z0-9_-]{8,64}`，缺省 UUID）。 */
  id: string;
  /** 委托方会话 id（空串 = 未指明）。 */
  from: string;
  /** 目标（worker）会话 id（已解析为精确 id）。 */
  to: string;
  /** 任务正文。 */
  text: string;
  /** 建立时刻（epoch ms）。 */
  createdAt: number;
  /** 最近更新时刻（epoch ms）。 */
  updatedAt: number;
  /** 当前状态。 */
  status: TaskStatus;
  /** 注入到 worker 会话的 `user/message` 事件 seq（自动回收按它对位；未注入时缺省）。 */
  triggerSeq?: number;
  /** 任务注入消息的流条目 id（排障用；缺省）。 */
  messageId?: string;
  /** 结果全文（UTF-8 截断到上限后存储）。 */
  result?: string;
  /** 结果是否被截断（任务表与通知都标注）。 */
  resultTruncated?: boolean;
  /** 结果来源：`auto`（worker 轮末自动回收）| `tool`（显式回传工具，优先覆盖 auto）。 */
  resultSource?: "auto" | "tool";
  /** 失败原因（failed / timeout 时）。 */
  error?: string;
  /** 超时时刻（epoch ms；读取时懒判定，不依赖定时器）。 */
  deadline?: number;
}

/** 委托请求。 */
export interface DelegateRequest {
  /** 委托方会话 id（写入记录与注入正文的来源标签）。 */
  from?: string;
  /** 目标：会话 id / 别名 / `cwd:<绝对路径>`（同 `send` 的寻址）。 */
  to: string;
  /** 任务正文。 */
  text: string;
  /** 超时秒数（缺省 1800；读取时懒判定为 `timeout`）。 */
  timeoutSec?: number;
  /** 任务记录 TTL 秒（缺省 7 天）。 */
  ttlSec?: number;
  /** > 0 时等待「已注入」回执的毫秒数（同 `send`）。 */
  waitMs?: number;
}

/** 委托结果。 */
export interface DelegateResult {
  ok: boolean;
  /** 成功时的任务记录快照。 */
  task?: TaskRecord;
  /** 任务注入消息的流条目 id。 */
  messageId?: string;
  /** 是否在等待窗口内收到「已注入」回执。 */
  delivered?: boolean;
  /** 命中的目标（唯一命中时）。 */
  target?: PeerInfo;
  /** 失败原因（ok=false；稳定码见 `SessionChannelErrorCode` 的 `task_*` / 复用 `target_*`）。 */
  error?: string;
  /** 人类可读说明（ok=false）。 */
  message?: string;
  /** 多目标命中时的候选会话。 */
  candidates?: PeerInfo[];
}

/** 任务查询选项。 */
export interface TaskQueryOptions {
  /** 只列与该会话相关（委托方或目标）的任务；缺省列全部（扫任务表，容量有限）。 */
  sessionId?: string;
  /** 只要该状态。 */
  status?: TaskStatus;
  /** 条数上限（缺省 20，最大 100）。 */
  limit?: number;
}

/** 任务列表结果。 */
export interface TaskListResult {
  ok: boolean;
  tasks?: TaskRecord[];
  error?: string;
}

/** 显式回传结果（worker 侧工具 / 服务调用）。 */
export interface TaskResultInput {
  /** 任务 id。 */
  taskId: string;
  /** 结果正文。 */
  text: string;
  /** true = 标记失败而不是完成。 */
  failed?: boolean;
  /** 失败原因（failed 时）。 */
  error?: string;
}

/** 结构化错误。 */
export class SessionChannelError extends Error {
  readonly code: SessionChannelErrorCode;

  constructor(code: SessionChannelErrorCode, message: string) {
    super(message);
    this.name = "SessionChannelError";
    this.code = code;
  }
}
