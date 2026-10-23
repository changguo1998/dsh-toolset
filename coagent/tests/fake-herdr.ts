/**
 * tests/fake-herdr.ts — fake herdr-use 服务面（结构与契约里的 `HerdrUseService` 一致）。
 *
 * 只实现 coagent 消费的六个方法 + 可选自检；每次调用都记账（`calls`），便于断言
 * 「只走服务面」「回滚只 close 一次」「run 只调一次且命令是 fffdsh」。
 */

import type {
  HerdrActionResult,
  HerdrCreateOptions,
  HerdrReadOptions,
  HerdrUseFace,
} from "../src/types.ts";

/** 假服务面返回的错误形状。 */
export interface FakeFailure {
  code: string;
  message: string;
}

/** 假终端。 */
export interface FakeTerminal {
  terminalId: string;
  label: string;
  cwd: string;
  foreground: boolean;
  running: boolean;
}

/** 一次服务面调用。 */
export interface FakeCall {
  method: string;
  args: unknown[];
}

function notRegistered(terminalId: string): HerdrActionResult {
  return {
    ok: false,
    error: {
      code: "terminal-not-registered",
      message: `终端 ${terminalId} 未登记（已关闭或从未创建）`,
    },
  };
}

export class FakeHerdr implements HerdrUseFace {
  readonly calls: FakeCall[] = [];
  readonly terminals = new Map<string, FakeTerminal>();
  /** `read` 返回的屏文本（认领快速失败用例改它）。 */
  screen = "";
  createError?: FakeFailure;
  runError?: FakeFailure;
  infoError?: FakeFailure;
  /** 前 N 次 `close` 失败（回滚失败 / close_failed 用例）。 */
  closeErrors = 0;
  /** 收到 `/quit` 后是否把 `running` 置 false（缺省 true；false = `/quit` 无效）。 */
  quitKills = true;
  #seq = 0;

  countOf(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  lastCall(method: string): FakeCall | undefined {
    const filtered = this.calls.filter((call) => call.method === method);
    return filtered[filtered.length - 1];
  }

  async create(
    opts: HerdrCreateOptions = {},
    context?: unknown,
  ): Promise<HerdrActionResult> {
    this.calls.push({ method: "create", args: [opts, context] });
    if (this.createError !== undefined) {
      return { ok: false, error: { ...this.createError } };
    }
    this.#seq += 1;
    const terminalId = `t${this.#seq}`;
    this.terminals.set(terminalId, {
      terminalId,
      label: opts.label ?? "",
      cwd: opts.cwd ?? "",
      foreground: opts.foreground !== false,
      running: true,
    });
    return {
      ok: true,
      payload: {
        terminal_id: terminalId,
        label: opts.label,
        cwd: opts.cwd,
        foreground: opts.foreground !== false,
      },
    };
  }

  async run(
    terminalId: string,
    command: string,
    context?: unknown,
  ): Promise<HerdrActionResult> {
    this.calls.push({ method: "run", args: [terminalId, command, context] });
    if (this.runError !== undefined) {
      return { ok: false, error: { ...this.runError } };
    }
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return notRegistered(terminalId);
    if (command === "/quit" && this.quitKills) terminal.running = false;
    return { ok: true, payload: { terminal_id: terminalId } };
  }

  async read(
    terminalId: string,
    opts?: HerdrReadOptions,
    context?: unknown,
  ): Promise<HerdrActionResult> {
    this.calls.push({ method: "read", args: [terminalId, opts, context] });
    if (!this.terminals.has(terminalId)) return notRegistered(terminalId);
    return {
      ok: true,
      payload: {
        terminal_id: terminalId,
        text: this.screen,
        source: opts?.source ?? "recent-unwrapped",
        lines: opts?.lines ?? 120,
        format: opts?.format ?? "text",
      },
    };
  }

  async info(
    terminalId: string,
    context?: unknown,
  ): Promise<HerdrActionResult> {
    this.calls.push({ method: "info", args: [terminalId, context] });
    if (this.infoError !== undefined) {
      return { ok: false, error: { ...this.infoError } };
    }
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return notRegistered(terminalId);
    return {
      ok: true,
      payload: {
        terminal_id: terminalId,
        running: terminal.running,
        shell_pid: 4242,
        foreground_processes: terminal.running
          ? [{ pid: 4242, command: "dsh" }]
          : [],
      },
    };
  }

  async close(
    terminalId: string,
    context?: unknown,
  ): Promise<HerdrActionResult> {
    this.calls.push({ method: "close", args: [terminalId, context] });
    if (this.closeErrors > 0) {
      this.closeErrors -= 1;
      return {
        ok: false,
        error: { code: "herdr-cli-error", message: "关闭终端失败（假故障）" },
      };
    }
    if (!this.terminals.has(terminalId)) return notRegistered(terminalId);
    this.terminals.delete(terminalId);
    return { ok: true, payload: { terminal_id: terminalId } };
  }

  async list(context?: unknown): Promise<HerdrActionResult> {
    this.calls.push({ method: "list", args: [context] });
    return {
      ok: true,
      payload: {
        terminals: [...this.terminals.values()].map((terminal) => ({
          terminal_id: terminal.terminalId,
          label: terminal.label,
          foreground: terminal.foreground,
          registered: true,
          focused: false,
          pane_count: 1,
        })),
      },
    };
  }

  isRegistered(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }
}
