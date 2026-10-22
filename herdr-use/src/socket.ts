/**
 * src/socket.ts — herdr unix socket 读通道（单请求连接）
 *
 * 为什么只有读走 socket（设计文档决策项 1）：socket 相对 CLI 的**硬优势只有一处**——
 * `pane.read` 返回 `revision` / `truncated`，而 CLI 的 `pane read` 只输出纯文本。
 * `pane_wait` 的 stable 判稳需要 `revision`（相邻两次相同即判稳），故二者共用本通道。
 *
 * 特点：
 *   - **单请求连接**：连上 → 写一行 JSON → 收一行 JSON → 关闭（与 herdr-integration 同形，
 *     不维护长连接、不订阅事件）。
 *   - 报文形态实测 0.9.5：请求 `{id, method:"pane.read", params:{pane_id, source, lines,
 *     format, strip_ansi}}`；成功 `{id, result:{type:"pane_read", read:{text, revision,
 *     truncated, …}}}`；失败 `{id, error:{code, message}}`。
 *   - `source` 的报文写法是**下划线**（`recent_unwrapped`），与 CLI 的连字符写法不同，
 *     本模块负责映射；`format=ansi` 时同时置 `strip_ansi: false`（与 CLI `--format ansi` 对齐）。
 *   - 连接面可注入（`SocketConnector`），单测用假连接器与假时钟，不依赖真 herdr。
 */

import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ParsedEnvelope } from "./cli.ts";
import { parseEnvelope } from "./cli.ts";
import type { ReadFormat, ReadSource } from "./types.ts";

/**
 * herdr 缺省 socket 路径（`HERDR_SOCKET_PATH` 不在时的兜底）：
 * `$XDG_CONFIG_HOME/herdr/herdr.sock`，未设 XDG_CONFIG_HOME 时 `~/.config/herdr/herdr.sock`
 * （与 herdr CLI 自己的缺省一致；真机 `herdr status --json` 报出的路径同此）。
 */
export function defaultHerdrSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configHome = env.XDG_CONFIG_HOME;
  const base =
    configHome !== undefined && configHome !== ""
      ? configHome
      : join(homedir(), ".config");
  return join(base, "herdr", "herdr.sock");
}

/** socket 报文里的取屏来源（下划线写法）。 */
export type SocketReadSource =
  "visible" | "recent" | "recent_unwrapped" | "detection";

/** CLI 连字符写法 → socket 下划线写法。 */
export function toSocketSource(source: ReadSource): SocketReadSource {
  return source === "recent-unwrapped" ? "recent_unwrapped" : source;
}

/** `pane.read` 的请求报文（不含 `id`，由发送层补）。 */
export interface PaneReadRequest {
  params: {
    pane_id: string;
    source: SocketReadSource;
    lines?: number;
    format: ReadFormat;
    strip_ansi: boolean;
  };
}

/** `pane.read` 的成功结果（字段按 0.9.5 schema 的 `PaneReadResult` 收窄）。 */
export interface PaneReadResult {
  paneId: string;
  source: string;
  format: string;
  text: string;
  /** 屏幕修订号（相邻两次相同即判「屏内容未变」）。 */
  revision?: number;
  /** 服务端是否截断（不是本包的渲染截断）。 */
  truncated?: boolean;
}

/** 读通道结果（成功 / 失败两态；超时也走失败态，不抛错）。 */
export type PaneReadOutcome =
  | { ok: true; read: PaneReadResult }
  | {
      ok: false;
      code: "socket-error" | "socket-timeout" | "herdr-bad-response";
      message: string;
    };

/** 单次 socket 请求的收发面（单测注入假实现）。 */
export interface SocketConnector {
  /**
   * 发一行 JSON 并收一行 JSON。
   * `timeoutMs` 到点仍无完整响应 → 返回 `{ kind: "timeout" }`；连接错误 → `{ kind: "error" }`。
   */
  request(
    socketPath: string,
    payload: string,
    timeoutMs: number,
  ): Promise<SocketResponse>;
}

/** 连接层原始响应。 */
export type SocketResponse =
  | { kind: "data"; text: string }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

/** 读通道配置。 */
export interface PaneReadOptions {
  socketPath: string;
  /** 单次请求超时 ms。 */
  timeoutMs: number;
}

/** `pane.read` 参数。 */
export interface ReadPaneParams {
  paneId: string;
  source: ReadSource;
  lines?: number;
  /** 取屏格式（缺省 text；ansi 时 socket 侧 strip_ansi=false）。 */
  format?: ReadFormat;
}

/** 读通道面（`read` / `wait stable` / `create` 的方向探测都不用 socket，除前者与中者）。 */
export interface PaneReader {
  readPane(params: ReadPaneParams): Promise<PaneReadOutcome>;
}

/** 请求 id 生成（单调 + 随机尾；不引入 uuid 依赖）。 */
let requestSeq = 0;
export function nextRequestId(now: number = Date.now()): string {
  requestSeq += 1;
  return `herdr-use:${now}:${requestSeq}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 缺省连接器：`net.createConnection` → 写一行 → 收到含换行的完整响应即关闭。
 * 超时 / 连接失败 / 对端提前关闭都归一为非 data 的响应，不抛错。
 */
export function createNetConnector(): SocketConnector {
  return {
    request(
      socketPath: string,
      payload: string,
      timeoutMs: number,
    ): Promise<SocketResponse> {
      return new Promise<SocketResponse>((resolve) => {
        let buffer = "";
        let settled = false;
        const socket = net.createConnection(socketPath);
        const finish = (response: SocketResponse): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(response);
        };
        const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
        timer.unref?.();
        socket.on("error", (error: Error) =>
          finish({ kind: "error", message: error.message }),
        );
        socket.on("connect", () => socket.write(payload));
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline !== -1) {
            finish({ kind: "data", text: buffer.slice(0, newline) });
          }
        });
        socket.on("end", () => {
          if (buffer.trim() !== "") {
            finish({ kind: "data", text: buffer.trim() });
            return;
          }
          finish({ kind: "error", message: "socket 对端在响应前关闭" });
        });
      });
    },
  };
}

/** socket 读通道（单请求连接；每次 `readPane` 独立建连）。 */
export function createPaneReader(
  options: PaneReadOptions,
  connector?: SocketConnector,
): PaneReader {
  const send = connector ?? createNetConnector();
  return {
    async readPane(params: ReadPaneParams): Promise<PaneReadOutcome> {
      const format: ReadFormat = params.format ?? "text";
      const request: PaneReadRequest = {
        params: {
          pane_id: params.paneId,
          source: toSocketSource(params.source),
          ...(params.lines === undefined ? {} : { lines: params.lines }),
          format,
          // 与 CLI `--format ansi` 对齐：要颜色就不剥色
          strip_ansi: format === "text",
        },
      };
      const payload =
        JSON.stringify({
          id: nextRequestId(),
          method: "pane.read",
          params: request.params,
        }) + "\n";
      const response = await send.request(
        options.socketPath,
        payload,
        options.timeoutMs,
      );
      if (response.kind === "timeout") {
        return {
          ok: false,
          code: "socket-timeout",
          message: `pane.read 超时（${options.timeoutMs}ms 内无响应）`,
        };
      }
      if (response.kind === "error") {
        return { ok: false, code: "socket-error", message: response.message };
      }
      return interpretReadResponse(response.text);
    },
  };
}

/**
 * 解析 `pane.read` 的响应行。
 * 成功信封里取 `result.read`；错误信封取 `error.code` / `error.message`；
 * 两者都认不出 → `herdr-bad-response`（带响应前 200 字符，便于定位协议漂移）。
 */
export function interpretReadResponse(text: string): PaneReadOutcome {
  const envelope: ParsedEnvelope = parseEnvelope(text, "");
  if (envelope.kind === "error") {
    return {
      ok: false,
      code: "socket-error",
      message: `${envelope.error.code}: ${envelope.error.message}`,
    };
  }
  if (envelope.kind !== "ok") {
    return {
      ok: false,
      code: "herdr-bad-response",
      message: `pane.read 响应无法解析：${text.slice(0, 200)}`,
    };
  }
  const read = envelope.result.read;
  if (read === null || typeof read !== "object") {
    return {
      ok: false,
      code: "herdr-bad-response",
      message: `pane.read 响应缺少 result.read：${text.slice(0, 200)}`,
    };
  }
  const record = read as Record<string, unknown>;
  if (typeof record.text !== "string") {
    return {
      ok: false,
      code: "herdr-bad-response",
      message: `pane.read 响应的 read.text 不是字符串：${text.slice(0, 200)}`,
    };
  }
  return {
    ok: true,
    read: {
      paneId: typeof record.pane_id === "string" ? record.pane_id : "",
      source: typeof record.source === "string" ? record.source : "",
      format: typeof record.format === "string" ? record.format : "text",
      text: record.text,
      ...(typeof record.revision === "number"
        ? { revision: record.revision }
        : {}),
      ...(typeof record.truncated === "boolean"
        ? { truncated: record.truncated }
        : {}),
    },
  };
}

/** stable 判稳结果。 */
export interface StabilityOutcome {
  /** 是否在超时前判稳。 */
  stable: boolean;
  /** 判定依据：`revision` 相同（socket 有 revision）或文本相同（服务端未给 revision 时回退）。 */
  basis: "revision" | "text" | "none";
  /** 最后一次读取到的屏内容。 */
  text: string;
  /** 最后一次读取到的 revision（服务端未给则为 undefined）。 */
  revision?: number;
  /** 观察到 revision 变化 / 文本变化的次数。 */
  changes: number;
  /** 已用毫秒。 */
  elapsedMs: number;
}

/** 判稳选项。 */
export interface WaitStableOptions {
  /** 两次读取之间的最小间隔 ms（缺省 400）。 */
  settleMs: number;
  /** 总超时 ms（缺省 30000）；到点未判稳返回 `stable: false`，不抛错。 */
  timeoutMs: number;
}

/** 可注入的等待与时钟面（单测用假时钟，真机用 setTimeout / Date.now）。 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** 缺省时钟。 */
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
};

/**
 * 静默判定（`wait` 的 stable 模式）：反复 `pane.read`，相邻两次 `revision` 相同即判稳；
 * 服务端未给 `revision` 时回退为**文本比对**（设计文档决策项 9）。
 *
 * 语义细节：
 *   - 首次读取只作基线，不判稳（否则「一读就稳」）；
 *   - 每次读取之间至少等 `settleMs`（缺省 400）；
 *   - 总超时到点返回 `stable: false` 与最后一次屏内容，**不抛错**（决策项 9 的「超时返回结构化结果」）；
 *   - `wait_for_output` 的错误信封（如 pane 不存在）由本函数转成 `stable: false` + `error`。
 */
export async function waitForStable(
  reader: PaneReader,
  params: ReadPaneParams,
  options: WaitStableOptions,
  clock: Clock = realClock,
): Promise<StabilityOutcome & { error?: string }> {
  const startedAt = clock.now();
  let lastText = "";
  let lastRevision: number | undefined;
  let changes = 0;
  let first = true;
  // 先读一次拿基线，再进入「等 settle → 再读 → 比对」循环
  for (;;) {
    const outcome = await reader.readPane(params);
    const now = clock.now();
    if (!outcome.ok) {
      return {
        stable: false,
        basis: "none",
        text: lastText,
        ...(lastRevision === undefined ? {} : { revision: lastRevision }),
        changes,
        elapsedMs: now - startedAt,
        error: `${outcome.code}: ${outcome.message}`,
      };
    }
    const read = outcome.read;
    if (first) {
      first = false;
      lastText = read.text;
      lastRevision = read.revision;
    } else {
      const hasRevision =
        read.revision !== undefined && lastRevision !== undefined;
      const sameRevision = hasRevision && read.revision === lastRevision;
      const sameText = read.text === lastText;
      if (!sameText) changes += 1;
      if (sameRevision) {
        return {
          stable: true,
          basis: "revision",
          text: read.text,
          ...(read.revision === undefined ? {} : { revision: read.revision }),
          changes,
          elapsedMs: now - startedAt,
        };
      }
      // 设计口径（决策项 9）：有 revision 时**只认 revision**（相邻两次相同即判稳）；
      // 取不到 revision 时才回退文本比对（依据记为 text，可见）。
      if (!hasRevision && sameText) {
        return {
          stable: true,
          basis: "text",
          text: read.text,
          ...(read.revision === undefined ? {} : { revision: read.revision }),
          changes,
          elapsedMs: now - startedAt,
        };
      }
      lastText = read.text;
      lastRevision = read.revision;
    }
    const elapsed = now - startedAt;
    if (elapsed + options.settleMs > options.timeoutMs) {
      return {
        stable: false,
        basis: lastRevision === undefined ? "text" : "revision",
        text: lastText,
        ...(lastRevision === undefined ? {} : { revision: lastRevision }),
        changes,
        elapsedMs: elapsed,
      };
    }
    await clock.sleep(options.settleMs);
  }
}
