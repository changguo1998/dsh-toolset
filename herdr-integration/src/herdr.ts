// src/herdr.ts — herdr 面板协议客户端
//
// 协议仿 pi 原生扩展 `~/.pi/agent/extensions/herdr-agent-state.ts`（该文件由 herdr
// 安装管理，本实现仅对齐协议与行为，代码重写）。协议要点：
//   - 环境变量握手：HERDR_ENV=1 + HERDR_SOCKET_PATH + HERDR_PANE_ID 缺一即禁用。
//   - 传输：unix socket（Windows 下为命名管道 `\\.\pipe\<path>`），换行分隔 JSON 行。
//   - pane.report_agent_session：上报当前会话引用（agent_session_id / agent_session_path）。
//   - pane.report_agent：上报 agent 状态（working | blocked | idle），附单调 seq 与 message。
//   - 发送：每次请求独立连接，写一行后等响应；首档超时失败后按固定 1500ms 重试一次。
//   - 状态队列：sendInFlight 串行 drain，发送期间到达的新状态覆盖待发项（合并去抖）。

import net from "node:net";

/** herdr 面板认识的 agent 状态。 */
export type AgentState = "working" | "blocked" | "idle";

/** 会话引用：id 与 path 至少其一；上报时 id 优先。 */
export interface SessionRef {
  /** 会话 id（DSH Session.id，如 tui-<uuid>） */
  id?: string;
  /** 会话文件绝对路径 */
  path?: string;
}

/** herdr 客户端选项（握手后的固定配置）。 */
export interface HerdrClientOptions {
  /** 当前 pane id（HERDR_PANE_ID） */
  paneId: string;
  /** socket 路径（HERDR_SOCKET_PATH；Windows 下为管道名） */
  socketPath: string;
  /** 面板来源标识（默认 "herdr:dsh"） */
  source: string;
  /** agent 标识（默认 "dsh"） */
  agent: string;
  /** 首档发送尝试的等待响应超时 ms（默认 500） */
  attemptTimeoutMs?: number;
}

/** 可注入的发送面（插件只依赖此接口，便于单测注入记录器）。 */
export interface HerdrSender {
  /** 记录当前会话引用（后续状态消息随附） */
  setSessionRef(ref: SessionRef | undefined): void;
  /** 上报当前会话 */
  reportSession(ref: SessionRef, sessionStartSource?: string): Promise<void>;
  /** 上报 agent 状态（并入串行队列，同刻多条只发最新） */
  reportState(state: AgentState, message?: string): Promise<void>;
}

interface QueuedState {
  state: AgentState;
  message?: string;
  seq: number;
}

/**
 * 从环境变量读取 herdr 握手配置；未启用（约定不全）返回 undefined。
 * pi 原生判定：HERDR_ENV === "1" 且 socketPath 与 paneId 非空。
 */
export function readHerdrEnv(
  env: NodeJS.ProcessEnv,
): HerdrClientOptions | undefined {
  if (env.HERDR_ENV !== "1") return undefined;
  const socketPath = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (!socketPath || !paneId) return undefined;
  return {
    paneId,
    socketPath,
    source: "herdr:dsh",
    agent: "dsh",
  };
}

/** 消息 id 的随机尾部（不依赖非标准库）。 */
function randomToken(): string {
  return Math.random().toString(36).slice(2);
}

/** 当前时间戳毫秒下的消息 id。 */
function messageId(prefix: string): string {
  return `${prefix}:${Date.now()}:${randomToken()}`;
}

/** herdr 面板协议的 unix socket 客户端（仿 pi 原生扩展，代码重写）。 */
export class HerdrClient implements HerdrSender {
  private reportSeq = Date.now() * 1000;
  private sendInFlight = false;
  private queuedState: QueuedState | undefined;
  private currentSessionRef: SessionRef | undefined;
  private readonly paneId: string;
  private readonly socketEndpoint: string;
  private readonly source: string;
  private readonly agent: string;
  private readonly attemptTimeoutMs: number;

  constructor(options: HerdrClientOptions) {
    this.paneId = options.paneId;
    this.source = options.source;
    this.agent = options.agent;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 500;
    this.socketEndpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${options.socketPath}`
        : options.socketPath;
  }

  /** 单调递增的协议序号（初始 Date.now()*1000，与 pi 原生一致）。 */
  private nextSeq(): number {
    this.reportSeq += 1;
    return this.reportSeq;
  }

  setSessionRef(ref: SessionRef | undefined): void {
    this.currentSessionRef = ref;
  }

  /** 上报当前会话引用（agent_session_id / agent_session_path）。 */
  reportSession(ref: SessionRef, sessionStartSource?: string): Promise<void> {
    return this.sendRequest({
      id: messageId(`${this.source}:session`),
      method: "pane.report_agent_session",
      params: {
        pane_id: this.paneId,
        source: this.source,
        agent: this.agent,
        seq: this.nextSeq(),
        ...(sessionStartSource !== undefined
          ? { session_start_source: sessionStartSource }
          : {}),
        ...this.sessionRefParams(ref),
      },
    });
  }

  /** 上报 agent 状态（并入串行队列；同刻多条只发最新一条）。 */
  reportState(state: AgentState, message?: string): Promise<void> {
    this.queuedState = { state, message, seq: this.nextSeq() };
    if (!this.sendInFlight) {
      void this.drainStateQueue();
    }
    return Promise.resolve();
  }

  /** 当前会话引用参数（id 优先、path 兜底，与 pi withSessionRef 语义一致）。 */
  private sessionRefParams(ref: SessionRef): Record<string, unknown> {
    if (ref.id) return { agent_session_id: ref.id };
    if (ref.path) return { agent_session_path: ref.path };
    return {};
  }

  /** 串行 drain 状态队列：发完再取下一条；发送期间新状态覆盖待发项。 */
  private async drainStateQueue(): Promise<void> {
    if (this.sendInFlight) return;
    this.sendInFlight = true;
    try {
      while (this.queuedState) {
        const next = this.queuedState;
        this.queuedState = undefined;
        await this.sendState(next.state, next.message, next.seq);
      }
    } finally {
      this.sendInFlight = false;
      if (this.queuedState) {
        void this.drainStateQueue();
      }
    }
  }

  private sendState(
    state: AgentState,
    message: string | undefined,
    seq: number,
  ): Promise<void> {
    return this.sendRequest({
      id: messageId(this.source),
      method: "pane.report_agent",
      params: {
        pane_id: this.paneId,
        source: this.source,
        agent: this.agent,
        state,
        ...(message !== undefined ? { message } : {}),
        seq,
        ...(this.currentSessionRef
          ? this.sessionRefParams(this.currentSessionRef)
          : {}),
      },
    });
  }

  /** 先按 attemptTimeoutMs 发一次，失败再按固定 1500ms 补一次（pi 原生活语）。 */
  private async sendRequest(request: unknown): Promise<void> {
    if (await this.sendRequestAttempt(request, this.attemptTimeoutMs)) {
      return;
    }
    await this.sendRequestAttempt(request, 1500);
  }

  /** 单次发送尝试：连接 → 写一行 JSON → 等响应；错误/超时/对端关闭视为失败。 */
  private sendRequestAttempt(
    request: unknown,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (delivered: boolean): void => {
        if (done) return;
        done = true;
        if (timer) {
          clearTimeout(timer);
        }
        socket.destroy();
        resolve(delivered);
      };

      const socket = net.createConnection(this.socketEndpoint);
      socket.on("error", () => finish(false));
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", () => finish(true));
      socket.on("end", () => finish(false));
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
    });
  }
}
