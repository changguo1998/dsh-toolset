/**
 * src/service.ts — 进程内服务面 `herdrUse`（供编排类插件复用）
 *
 * 与十个工具**同源**：每个方法都直接调 `dispatchAction(action, args, dispatchDeps, context)`，
 * 因此共用同一份 registry、同一把写锁、同一套会话绑定。服务面不经宿主
 * `tools/pre-execute`（进程内可信 API），但动作层的归属校验与沙箱外的 guard 复查仍在。
 *
 * 会话上下文：末参 `context` 可为宿主工具 `exec`、`{ session: { id, cwd } }` 或
 * `{ id, cwd }`（`readSessionContext` 三种形态都支持）；不传则由 `resolveSession` 兜底，
 * 仍取不到返回 `session-unavailable`。
 *
 * 不暴露 registry（避免外部误写），只给 `isRegistered` 与归一化后的 `config`。
 */

import type { DispatchDeps } from "./actions.ts";
import { dispatchAction } from "./actions.ts";
import type {
  ActionResult,
  HerdrUseAction,
  ReadFormat,
  ReadSource,
  ResolvedConfig,
} from "./types.ts";

/** `create` 选项。 */
export interface CreateOptions {
  /** 缺省 true（前台，继承父会话）；false = `--session dshbg`。 */
  foreground?: boolean;
  /** 新终端工作目录（缺省调用方会话 cwd）。 */
  cwd?: string;
  /** 归属标记（缺省配置 label）。 */
  label?: string;
}

/** `read` 选项。 */
export interface ReadOptions {
  source?: ReadSource;
  lines?: number;
  format?: ReadFormat;
}

/** `wait` 选项（match / regex / stable 三选一）。 */
export interface WaitOptions {
  match?: string;
  regex?: string;
  stable?: boolean;
  settleMs?: number;
  timeoutMs?: number;
  source?: ReadSource;
  lines?: number;
}

/** 服务面（`ctx.provide("herdrUse", …)`）。 */
export interface HerdrUseService {
  dispatch(
    action: HerdrUseAction,
    args: Record<string, unknown>,
    context?: unknown,
  ): Promise<ActionResult>;
  list(context?: unknown): Promise<ActionResult>;
  read(
    terminalId: string,
    opts?: ReadOptions,
    context?: unknown,
  ): Promise<ActionResult>;
  info(terminalId: string, context?: unknown): Promise<ActionResult>;
  wait(
    terminalId: string,
    opts?: WaitOptions,
    context?: unknown,
  ): Promise<ActionResult>;
  create(opts?: CreateOptions, context?: unknown): Promise<ActionResult>;
  close(terminalId: string, context?: unknown): Promise<ActionResult>;
  label(
    terminalId: string,
    label: string,
    context?: unknown,
  ): Promise<ActionResult>;
  text(
    terminalId: string,
    text: string,
    context?: unknown,
  ): Promise<ActionResult>;
  key(
    terminalId: string,
    keys: readonly string[],
    context?: unknown,
  ): Promise<ActionResult>;
  run(
    terminalId: string,
    command: string,
    context?: unknown,
  ): Promise<ActionResult>;
  isRegistered(terminalId: string): boolean;
  readonly config: ResolvedConfig;
}

/** 去掉 undefined 值（内部动作参数用 snake_case，避免把 undefined 写进回执）。 */
function argsOf(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * 构造服务面。`deps` 必须与工具注册用的是**同一个对象**（同一 registry / runner / reader），
 * 否则退出清理与归属判定会对不上。
 */
export function createHerdrUseService(deps: DispatchDeps): HerdrUseService {
  const call = (
    action: HerdrUseAction,
    args: Record<string, unknown>,
    context?: unknown,
  ): Promise<ActionResult> => dispatchAction(action, args, deps, context);
  return {
    dispatch(action, args, context) {
      return call(action, args, context);
    },
    list(context) {
      return call("list", {}, context);
    },
    read(terminalId, opts = {}, context) {
      return call(
        "read",
        argsOf({
          terminal_id: terminalId,
          source: opts.source,
          lines: opts.lines,
          format: opts.format,
        }),
        context,
      );
    },
    info(terminalId, context) {
      return call("info", { terminal_id: terminalId }, context);
    },
    wait(terminalId, opts = {}, context) {
      return call(
        "wait",
        argsOf({
          terminal_id: terminalId,
          match: opts.match,
          regex: opts.regex,
          stable: opts.stable,
          settle_ms: opts.settleMs,
          timeout_ms: opts.timeoutMs,
          source: opts.source,
          lines: opts.lines,
        }),
        context,
      );
    },
    create(opts = {}, context) {
      return call(
        "create",
        argsOf({
          foreground: opts.foreground,
          cwd: opts.cwd,
          label: opts.label,
        }),
        context,
      );
    },
    close(terminalId, context) {
      return call("close", { terminal_id: terminalId }, context);
    },
    label(terminalId, label, context) {
      return call("label", { terminal_id: terminalId, label }, context);
    },
    text(terminalId, text, context) {
      return call("text", { terminal_id: terminalId, text }, context);
    },
    key(terminalId, keys, context) {
      return call("key", { terminal_id: terminalId, keys: [...keys] }, context);
    },
    run(terminalId, command, context) {
      return call("run", { terminal_id: terminalId, command }, context);
    },
    isRegistered(terminalId) {
      return deps.registry.has(terminalId);
    },
    config: deps.config,
  };
}
