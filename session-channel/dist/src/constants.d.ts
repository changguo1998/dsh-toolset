/** 心跳间隔（ms）。 */
export declare const DEFAULT_HEARTBEAT_MS = 5000;
/** 在线键 TTL（秒）。 */
export declare const DEFAULT_PRESENCE_TTL_SEC = 15;
/** 单条正文上限（UTF-8 字节）。 */
export declare const DEFAULT_MAX_TEXT_BYTES = 8192;
/** 邮箱流长度上限（XADD MAXLEN ~）。 */
export declare const MAX_STREAM_LEN = 1000;
/** 回执键 TTL（秒）。 */
export declare const ACK_TTL_SEC = 60;
/** 单次阻塞读等待上限（ms）。 */
export declare const DEFAULT_READ_BLOCK_MS = 15000;
/** 回执轮询间隔（ms）。 */
export declare const POLL_INTERVAL_MS = 100;
/** 已知会话上限（超出按最后活跃时间淘汰）。 */
export declare const MAX_TRACKED_SESSIONS = 32;
/** 无已知会话时的轮询间隔（ms）。 */
export declare const IDLE_POLL_MS = 1000;
/** 连接/读取失败后的重试间隔（ms）。 */
export declare const RETRY_DELAY_MS = 2000;
