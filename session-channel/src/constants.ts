// src/constants.ts — 默认参数（可被 `SessionChannelConfig` 覆盖的项集中在此）。
//
// 取值口径：AI 会话的交互尺度——心跳 5s / TTL 15s（3 倍容错）；
// 邮箱流上限 1000 条（约几十 KB，足够排障且不膨胀）；回执 60s（发送方等待窗口远小于它）。

/** 心跳间隔（ms）。 */
export const DEFAULT_HEARTBEAT_MS = 5000;

/** 在线键 TTL（秒）。 */
export const DEFAULT_PRESENCE_TTL_SEC = 15;

/** 单条正文上限（UTF-8 字节）。 */
export const DEFAULT_MAX_TEXT_BYTES = 8192;

/** 邮箱流长度上限（XADD MAXLEN ~）。 */
export const MAX_STREAM_LEN = 1000;

/** 游标键保留期（ms）：超过则懒清理（7 天）。 */
export const CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 回执键 TTL（秒）。 */
export const ACK_TTL_SEC = 60;

/** 单次阻塞读等待上限（ms）。 */
export const DEFAULT_READ_BLOCK_MS = 15000;

/** 回执轮询间隔（ms）。 */
export const POLL_INTERVAL_MS = 100;

/** 已知会话上限（超出按最后活跃时间淘汰）。 */
export const MAX_TRACKED_SESSIONS = 32;

/** 无已知会话时的轮询间隔（ms）。 */
export const IDLE_POLL_MS = 1000;

/** 连接/读取失败后的重试间隔（ms）。 */
export const RETRY_DELAY_MS = 2000;
