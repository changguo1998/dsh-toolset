/**
 * src/actions.ts — `spawn` / `list` / `close` 的实现与按 id 串行。
 *
 * 三段职责（2026-10-23 裁定）：
 * - `spawn`：前置校验 → `create` 新终端 → `run fffdsh` → 轮询 `peers` 认领；任一步失败即
 *   `close(terminal_id)` 一次回滚并落 `failed` 记录（`claim_timeout` 例外：落 `lost`、不关终端）。
 * - `list`：清理与排障，只回答「有哪些记录、终端 / 会话还在不在」；不返回任务态与忙闲。
 * - `close`：`/quit` → 等进程退出 → `close(terminal_id)`；幂等，失败给 `force` 出口。
 *
 * 依赖姿态：只经 deps 里的服务面（herdrUse / sessionChannel）+ 本包的 store，不直接起进程。
 */

import { randomBytes } from "node:crypto";

import {
  CLAIM_TIMEOUT_REASONS,
  claimSession,
  type ClaimResult,
} from "./channel.ts";
import {
  errorTextOf,
  isTerminalGone,
  runningOf,
  screenTextOf,
  terminalIdOf,
} from "./herdr.ts";
import {
  booleanArg,
  buildLaunchCommand,
  checkCwd,
  checkForegroundText,
  optionalString,
  parseSpawnArgs,
  positiveInt,
} from "./launch.ts";
import { findPeer, probeRecord } from "./probe.ts";
import {
  PathsUnavailableError,
  StoreError,
  type FileCoagentStore,
} from "./store.ts";
import { ALL_STATES, failure, LIVE_STATES, TERMINAL_STATES } from "./types.ts";
import type {
  CallerSession,
  Clock,
  CoagentIndex,
  CoagentRecord,
  CoagentState,
  HerdrActionResult,
  HerdrUseFace,
  ProbeOutcome,
  ResolvedConfig,
  ServiceContext,
  SessionChannelFace,
} from "./types.ts";

/** 动作名（与工具 schema 的 enum 一致）。 */
export const ACTIONS = ["spawn", "list", "close"] as const;
export type CoagentAction = (typeof ACTIONS)[number];

/** 动作依赖（全部可注入，测试用 fake）。 */
export interface ActionDeps {
  herdr: HerdrUseFace;
  channel: SessionChannelFace;
  config: ResolvedConfig;
  clock: Clock;
  /** 本进程的 profile（认领匹配用；取不到传空串）。 */
  profile: string;
  /** 打开某会话的 store（路径推导可能抛错，由动作层转 `session_paths_unavailable`）。 */
  openStore(sessionId: string): FileCoagentStore;
  /** 告警（服务缺失 / 降级）。 */
  warn?(message: string): void;
}

/** 已建记录但终态无终端时的回执字段（避免每个分支重复拼）。 */
interface ArchiveOptions {
  state: CoagentState;
  failCode?: CoagentRecord["fail_code"];
  failReason?: string;
  screen?: string;
  terminalClosed?: boolean;
  rollbackFailed?: boolean;
  claimLog?: string;
  /** 可操作的下一步（覆盖按状态推导的缺省提示）。 */
  next?: string;
}

/** 失败回执 + 记录字段（失败也带 `coagent_id`，便于立刻 `list` 排障）。 */
function failWith(
  code: Parameters<typeof failure>[0],
  reason: string,
  next: string | undefined,
  coagentId: string,
): Record<string, unknown> {
  const base = failure(code, reason, next);
  return coagentId === "" ? base : { ...base, coagent_id: coagentId };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 新 id：`c-` + 8 位 hex（终端 label 是 `coagent/<id>`）。 */
export function newCoagentId(): string {
  return `c-${randomBytes(4).toString("hex")}`;
}

/** 计入 `maxLive` 的记录数。 */
export function countLive(index: CoagentIndex): number {
  return Object.values(index.records).filter(
    (record) => record.pruned !== true && LIVE_STATES.includes(record.state),
  ).length;
}

/** 已知会话 id（认领时排除旧会话）。 */
function knownSessions(index: CoagentIndex): Set<string> {
  const known = new Set<string>();
  for (const record of Object.values(index.records)) {
    if (record.session_id !== undefined) known.add(record.session_id);
  }
  return known;
}

/** 屏摘要：取尾部（报错总在最后），最多 800 字符。 */
export function screenExcerpt(screen: string | undefined): string | undefined {
  if (screen === undefined) return undefined;
  const trimmed = screen.trim();
  if (trimmed === "") return undefined;
  return trimmed.length <= 800 ? trimmed : `…${trimmed.slice(-799)}`;
}

/** 动作层：三个动作 + 两把锁。 */
export class CoagentActions {
  readonly #deps: ActionDeps;
  /** 按 key 串行（`spawn` 用进程级 key，其余按 `coagent_id`）。 */
  #locks = new Map<string, Promise<void>>();

  constructor(deps: ActionDeps) {
    this.#deps = deps;
  }

  /** 工具入口：分派 + 统一异常映射（意外错误不裸抛给宿主）。 */
  async run(
    action: string,
    args: Record<string, unknown>,
    caller: CallerSession,
  ): Promise<Record<string, unknown>> {
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return failure(
        "invalid_action",
        `未知动作「${action}」：只支持 ${ACTIONS.join(" / ")}`,
        "spawn 拉起、list 查看、close 收尾；派任务用 channel_delegate，看屏用 herdr_read",
      );
    }
    // `action` 只是分派键，不属于任何动作的参数面；去掉后再做未知键校验。
    const { action: _action, ...params } = args;
    try {
      switch (action as CoagentAction) {
        case "spawn":
          // 进程级排他：并发建终端会互相踩 $DSH_HOME/profiles 的启动写盘。
          return await this.#withLock("__spawn__", () =>
            this.#spawn(params, caller),
          );
        case "list":
          return await this.#list(params, caller);
        case "close": {
          const id = optionalString(params, "coagent_id");
          const key = id.ok && id.value !== undefined ? id.value : "__close__";
          return await this.#withLock(key, () => this.#close(params, caller));
        }
      }
    } catch (error) {
      if (error instanceof PathsUnavailableError) {
        return failure(
          "session_paths_unavailable",
          `会话目录不可用：${describe(error)}`,
          "确认 session-paths 服务可用（宿主 sessions 里能查到本会话）；或在输出里报告该错误",
        );
      }
      if (error instanceof StoreError) {
        return failure(
          "record_write_failed",
          `状态落盘失败：${describe(error)}`,
          "检查会话目录是否可写；记录可能不完整，用 coagent list 核对",
        );
      }
      const code =
        action === "spawn"
          ? "launch_failed"
          : action === "close"
            ? "close_failed"
            : "record_write_failed";
      return failure(
        code,
        `${action} 内部错误：${describe(error)}`,
        "带上回执与 coagent list 的输出排查；若为服务面异常，确认 herdrUse / sessionChannel 可用",
      );
    }
  }

  /** 串行执行（前一个失败也继续排队）。 */
  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.#locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** 打开调用方会话的 store，失败转 `session_paths_unavailable`。 */
  #store(caller: CallerSession): FileCoagentStore {
    try {
      return this.#deps.openStore(caller.id);
    } catch (error) {
      throw new PathsUnavailableError(
        `无法推导会话 ${caller.id} 的目录：${describe(error)}`,
      );
    }
  }

  /** 服务面调用：把抛错的实现统一成失败回执。 */
  async #invoke(
    call: () => Promise<HerdrActionResult>,
  ): Promise<HerdrActionResult> {
    try {
      return await call();
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "herdr-cli-error",
          message: `服务面调用抛错：${describe(error)}`,
        },
      };
    }
  }

  /** 回滚关闭终端：成功或「本来就不在」都算成功。 */
  async #safeClose(
    terminalId: string,
    context: ServiceContext,
  ): Promise<{ ok: boolean; detail?: string }> {
    const closed = await this.#invoke(() =>
      this.#deps.herdr.close(terminalId, context),
    );
    if (closed.ok || isTerminalGone(closed)) return { ok: true };
    return { ok: false, detail: errorTextOf(closed) };
  }

  /** 写记录（索引 + 记录目录）；调用方负责把失败转成回执。 */
  async #persist(
    store: FileCoagentStore,
    record: CoagentRecord,
    extra: { claimLog?: string; screen?: string } = {},
  ): Promise<void> {
    record.updated_at = this.#deps.clock.now();
    const snapshot = { ...record };
    await store.update((index) => {
      index.records[snapshot.coagent_id] = snapshot;
    });
    await store.writeArtifacts(snapshot.coagent_id, {
      meta: snapshot,
      ...(extra.claimLog === undefined ? {} : { claimLog: extra.claimLog }),
      ...(extra.screen === undefined ? {} : { screen: extra.screen }),
    });
  }

  /** 拉起阶段的失败落点：写 `failed` / `lost` 记录并返回失败回执。 */
  async #archive(
    store: FileCoagentStore,
    record: CoagentRecord,
    options: ArchiveOptions,
  ): Promise<Record<string, unknown>> {
    record.state = options.state;
    if (options.failCode !== undefined) record.fail_code = options.failCode;
    if (options.failReason !== undefined) {
      record.fail_reason = options.failReason;
    }
    if (options.terminalClosed !== undefined) {
      record.terminal_closed = options.terminalClosed;
    }
    if (options.rollbackFailed !== undefined) {
      record.rollback_failed = options.rollbackFailed;
    }
    const excerpt = screenExcerpt(options.screen);
    if (excerpt !== undefined) record.screen_excerpt = excerpt;
    try {
      await this.#persist(store, record, {
        ...(options.claimLog === undefined
          ? {}
          : { claimLog: options.claimLog }),
        ...(options.screen === undefined ? {} : { screen: options.screen }),
      });
    } catch (error) {
      this.#deps.warn?.(
        `coagent: 失败记录落盘失败（${record.coagent_id}）：${describe(error)}`,
      );
      return failWith(
        "record_write_failed",
        `拉起失败且记录写入失败：${describe(error)}`,
        "检查会话目录写权限；终端可能需要用 herdr_list / herdr_close 手工清理",
        record.coagent_id,
      );
    }
    const code = options.failCode ?? "launch_failed";
    return failWith(
      code,
      options.failReason ?? "拉起失败",
      options.next ??
        (options.rollbackFailed === true
          ? "回滚也失败了：用 herdr_list 找到该 terminal_id，再用 herdr_close 手工关掉"
          : undefined),
      record.coagent_id,
    );
  }

  // ---------------------------------------------------------------- spawn

  async #spawn(
    args: Record<string, unknown>,
    caller: CallerSession,
  ): Promise<Record<string, unknown>> {
    const parsed = parseSpawnArgs(args);
    if (!parsed.ok) {
      return failWith("invalid_params", parsed.reason, parsed.next, "");
    }
    const cmd = buildLaunchCommand(parsed.value);
    const store = this.#store(caller);
    const cwd = parsed.value.cwd ?? caller.cwd;
    if (cwd === "") {
      return failWith(
        "cwd_invalid",
        "没有可用的启动目录：调用方会话没带 cwd，且未传 cwd",
        "显式传一个绝对路径作为 cwd",
        "",
      );
    }
    const cwdCheck = await checkCwd(cwd);
    if (!cwdCheck.ok) {
      return failWith(
        "cwd_invalid",
        cwdCheck.reason,
        "传一个存在且可访问的绝对路径；spawn 不会替你创建目录",
        "",
      );
    }

    const index = await store.read();
    const live = countLive(index);
    if (live >= this.#deps.config.maxLive) {
      return failWith(
        "limit_exceeded",
        `本会话已有 ${live} 个进行中的 coagent（上限 ${this.#deps.config.maxLive}）`,
        "先 coagent close 一条，或调大配置 maxLive；本包不排队",
        "",
      );
    }

    const coagentId = newCoagentId();
    const label = parsed.value.label ?? `coagent-${coagentId}`;
    const startedAt = this.#deps.clock.now();
    const record: CoagentRecord = {
      coagent_id: coagentId,
      state: "starting",
      cwd,
      label,
      terminal_label: `coagent/${coagentId}`,
      cmd,
      started_at: startedAt,
      updated_at: startedAt,
    };
    const context: ServiceContext = {
      session: { id: caller.id, cwd },
    };

    // 前台约束（F10）：不建终端、不提交命令，但按裁定落 failed 记录。
    const guard = checkForegroundText(cmd);
    if (!guard.ok) {
      return this.#archive(store, record, {
        state: "failed",
        failCode: "launch_forbidden",
        failReason: guard.reason,
      });
    }

    // 建终端（F2）：服务面保证失败不登记，故没有可回滚对象。
    const created = await this.#invoke(() =>
      this.#deps.herdr.create(
        { foreground: true, cwd, label: record.terminal_label },
        context,
      ),
    );
    if (!created.ok) {
      return this.#archive(store, record, {
        state: "failed",
        failCode: "terminal_create_failed",
        failReason: `建终端失败：${errorTextOf(created)}`,
      });
    }
    const terminalId = terminalIdOf(created);
    if (terminalId === undefined) {
      return this.#archive(store, record, {
        state: "failed",
        failCode: "terminal_create_failed",
        failReason: "create 回执没有 terminal_id（无法定位终端，也无法回滚）",
        rollbackFailed: true,
      });
    }
    record.terminal_id = terminalId;

    try {
      await this.#persist(store, record);
    } catch (error) {
      const rollback = await this.#safeClose(terminalId, context);
      this.#deps.warn?.(
        `coagent: 记录落盘失败，已回滚终端 ${terminalId}（${describe(error)}）`,
      );
      return failWith(
        "record_write_failed",
        `记录落盘失败：${describe(error)}`,
        rollback.ok
          ? "检查会话目录写权限后重试"
          : `回滚也失败：用 herdr_close({terminal_id:"${terminalId}"}) 手工关掉`,
        coagentId,
      );
    }

    // 提交 `fffdsh`（F3）：失败即回滚一次 close。
    const ran = await this.#invoke(() =>
      this.#deps.herdr.run(terminalId, cmd, context),
    );
    if (!ran.ok) {
      const rollback = await this.#safeClose(terminalId, context);
      return this.#archive(store, record, {
        state: "failed",
        failCode: "launch_failed",
        failReason: `提交 ${cmd} 失败：${errorTextOf(ran)}`,
        terminalClosed: rollback.ok,
        rollbackFailed: !rollback.ok,
      });
    }

    // 认领：轮询 peers + 取屏找 `fffdsh` 自己的报错。
    const claimLog: string[] = [];
    const claim = await claimSession({
      channel: this.#deps.channel,
      clock: this.#deps.clock,
      criteria: {
        cwd,
        profile: this.#deps.profile,
        startedAt,
        known: knownSessions(index),
      },
      timeoutMs:
        (parsed.value.claimTimeoutSec ?? this.#deps.config.claimTimeoutSec) *
        1000,
      pollIntervalMs: this.#deps.config.pollIntervalMs,
      readScreen: async () => {
        const read = await this.#invoke(() =>
          this.#deps.herdr.read(
            terminalId,
            { source: "recent-unwrapped", lines: 120, format: "text" },
            context,
          ),
        );
        return screenTextOf(read);
      },
      log: (line) => claimLog.push(line),
    });

    return this.#finishClaim(store, record, claim, claimLog, context);
  }

  /** 认领三种结局的统一落点（成功 / 屏报错回滚 / 超时留终端）。 */
  async #finishClaim(
    store: FileCoagentStore,
    record: CoagentRecord,
    claim: ClaimResult,
    claimLog: string[],
    context: ServiceContext,
  ): Promise<Record<string, unknown>> {
    const log = claimLog.join("\n");

    if (claim.kind === "claimed") {
      record.state = "ready";
      record.session_id = claim.peer.sessionId;
      record.claimed_at = this.#deps.clock.now();
      try {
        await this.#persist(store, record, { claimLog: log });
      } catch (error) {
        const terminalId = record.terminal_id;
        const rollback =
          terminalId === undefined
            ? { ok: false }
            : await this.#safeClose(terminalId, context);
        return failWith(
          "record_write_failed",
          `已认领会话 ${claim.peer.sessionId}，但记录落盘失败：${describe(error)}`,
          rollback.ok
            ? "检查会话目录写权限后重试；刚拉起的会话已被回滚关闭"
            : `会话 ${claim.peer.sessionId} 仍在运行：用 channel_delegate 接管，或用 herdr_list / herdr_close 清理`,
          record.coagent_id,
        );
      }
      return {
        ok: true,
        coagent_id: record.coagent_id,
        terminal_id: record.terminal_id,
        session_id: record.session_id,
        state: "ready",
        cwd: record.cwd,
        label: record.label,
        cmd: record.cmd,
        terminal_label: record.terminal_label,
        started_at: record.started_at,
        claimed_at: record.claimed_at,
        paths: { dir: store.recordDir(record.coagent_id) },
      };
    }

    if (claim.kind === "screen-failed") {
      const terminalId = record.terminal_id;
      const rollback =
        terminalId === undefined
          ? { ok: false, detail: "没有 terminal_id" }
          : await this.#safeClose(terminalId, context);
      return this.#archive(store, record, {
        state: "failed",
        failCode: "launch_failed",
        failReason: claim.reason,
        screen: claim.screen,
        terminalClosed: rollback.ok,
        rollbackFailed: !rollback.ok,
        claimLog: log,
        next: claim.next,
      });
    }

    // F6：认领超时。终端保留（屏上可能有排障信息），记录落 `lost`。
    return this.#archive(store, record, {
      state: "lost",
      failCode: "claim_timeout",
      failReason: claim.reason,
      ...(claim.screen === undefined ? {} : { screen: claim.screen }),
      claimLog: log,
      next: "用 coagent list 查看屏摘要与原因；确认后用 coagent close 归档（终端保留供排障）",
    });
  }

  // ----------------------------------------------------------------- list

  async #list(
    args: Record<string, unknown>,
    caller: CallerSession,
  ): Promise<Record<string, unknown>> {
    const coagentId = optionalString(args, "coagent_id");
    if (!coagentId.ok) {
      return failWith("invalid_params", coagentId.reason, undefined, "");
    }
    const state = optionalString(args, "state");
    if (!state.ok) {
      return failWith("invalid_params", state.reason, undefined, "");
    }
    if (
      state.value !== undefined &&
      !(ALL_STATES as readonly string[]).includes(state.value)
    ) {
      return failWith(
        "invalid_params",
        `state 只支持 ${ALL_STATES.join(" / ")}`,
        undefined,
        "",
      );
    }
    const probe = optionalString(args, "probe");
    if (!probe.ok) {
      return failWith("invalid_params", probe.reason, undefined, "");
    }
    const probeMode = probe.value ?? "live";
    if (probeMode !== "live" && probeMode !== "none") {
      return failWith(
        "invalid_params",
        "probe 只支持 live / none",
        undefined,
        "",
      );
    }
    const limit = positiveInt(args, "limit");
    if (!limit.ok) {
      return failWith("invalid_params", limit.reason, undefined, "");
    }
    const limitValue = Math.min(limit.value ?? 20, 200);
    const listExtras = Object.keys(args).filter(
      (key) => !["coagent_id", "state", "probe", "limit"].includes(key),
    );
    if (listExtras.length > 0) {
      return failWith(
        "invalid_params",
        `不支持的参数：${listExtras.join(", ")}`,
        "list 只接受 coagent_id / state / probe / limit",
        "",
      );
    }

    const store = this.#store(caller);
    const index = await store.read();
    const context: ServiceContext = {
      session: { id: caller.id, cwd: caller.cwd },
    };

    const selected = Object.values(index.records).filter((record) => {
      if (
        coagentId.value !== undefined &&
        record.coagent_id !== coagentId.value
      ) {
        return false;
      }
      if (state.value !== undefined && record.state !== state.value) {
        return false;
      }
      return true;
    });

    const running = new Map<string, boolean | undefined>();
    if (probeMode === "live") {
      const changed: CoagentRecord[] = [];
      let budget = this.#deps.config.maxLive;
      for (const record of selected) {
        if (budget <= 0) break;
        if (record.pruned === true) continue;
        if (TERMINAL_STATES.includes(record.state)) continue;
        budget -= 1;
        const outcome = await this.#probe(record, context);
        running.set(record.coagent_id, outcome.terminal_running);
        if (outcome.state !== record.state) {
          record.state = outcome.state;
          record.updated_at = this.#deps.clock.now();
          changed.push(record);
        }
      }
      if (changed.length > 0) {
        await store.update((fresh) => {
          for (const record of changed) {
            fresh.records[record.coagent_id] = record;
          }
        });
      }
    }

    const now = this.#deps.clock.now();
    const items = selected
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, limitValue)
      .map((record) => ({
        coagent_id: record.coagent_id,
        terminal_id: record.terminal_id,
        session_id: record.session_id,
        state: record.state,
        cwd: record.cwd,
        label: record.label,
        started_at: record.started_at,
        elapsed_ms: Math.max(0, now - record.started_at),
        ...(running.get(record.coagent_id) === undefined
          ? {}
          : { terminal_running: running.get(record.coagent_id) }),
        ...(record.pruned === true ? { pruned: true } : {}),
        ...(this.#isStale(record, now) ? { stale: true } : {}),
      }));

    return {
      ok: true,
      items,
      live: countLive(index),
      max_live: this.#deps.config.maxLive,
    };
  }

  /** 探测一条记录；服务面异常时保留原状态（不让 list 因一次失败改坏记录）。 */
  async #probe(
    record: CoagentRecord,
    context: ServiceContext,
  ): Promise<ProbeOutcome> {
    try {
      return await probeRecord(
        {
          herdr: this.#deps.herdr,
          channel: this.#deps.channel,
          context,
        },
        record,
      );
    } catch (error) {
      this.#deps.warn?.(
        `coagent: 探测 ${record.coagent_id} 失败（保留原状态）：${describe(error)}`,
      );
      return { state: record.state };
    }
  }

  /** `stale`：非终态且久未推进（只标记，不自动杀）。 */
  #isStale(record: CoagentRecord, now: number): boolean {
    if (record.pruned === true) return false;
    if (TERMINAL_STATES.includes(record.state)) return false;
    return now - record.updated_at > this.#deps.config.staleAfterSec * 1000;
  }

  // ---------------------------------------------------------------- close

  async #close(
    args: Record<string, unknown>,
    caller: CallerSession,
  ): Promise<Record<string, unknown>> {
    const id = optionalString(args, "coagent_id");
    if (!id.ok || id.value === undefined) {
      return failWith(
        "invalid_params",
        id.ok ? "close 需要 coagent_id" : id.reason,
        "用 coagent list 取 coagent_id",
        "",
      );
    }
    const force = booleanArg(args, "force");
    if (!force.ok) {
      return failWith("invalid_params", force.reason, undefined, "");
    }
    const keep = booleanArg(args, "keep");
    if (!keep.ok) {
      return failWith("invalid_params", keep.reason, undefined, "");
    }
    const closeExtras = Object.keys(args).filter(
      (key) => !["coagent_id", "force", "keep"].includes(key),
    );
    if (closeExtras.length > 0) {
      return failWith(
        "invalid_params",
        `不支持的参数：${closeExtras.join(", ")}`,
        "close 只接受 coagent_id / force / keep",
        "",
      );
    }

    const store = this.#store(caller);
    const index = await store.read();
    const record = index.records[id.value];
    if (record === undefined) {
      return failWith(
        "not_found",
        `没有 coagent 记录「${id.value}」`,
        "用 coagent list 看本会话有哪些记录；区分大小写",
        "",
      );
    }

    if (record.state === "closed") {
      return {
        ok: true,
        coagent_id: record.coagent_id,
        state: "closed",
        ...(record.terminal_id === undefined
          ? {}
          : { terminal_id: record.terminal_id }),
        already_closed: true,
        removed_files: false,
      };
    }

    const archivedFrom = record.state;
    const context: ServiceContext = {
      session: { id: caller.id, cwd: caller.cwd },
    };
    const needsTerminal =
      record.terminal_id !== undefined && record.terminal_closed !== true;
    if (needsTerminal && force.value !== true) {
      // 先落 `closing`：即便进程卡住，list 也能看出「已在收尾」。
      record.state = "closing";
      await this.#persist(store, record);
    }
    const closedWith = await this.#closeTerminal(
      record,
      force.value === true,
      context,
    );
    if (!closedWith.ok) {
      if (needsTerminal) {
        record.state = "closing";
        await this.#persist(store, record).catch(() => undefined);
      }
      return failWith(
        "close_failed",
        closedWith.reason,
        "确认进程已退出后重试；仍不行用 close({force:true}) 直接关终端，或用 herdr_close({terminal_id}) 手工关",
        record.coagent_id,
      );
    }

    record.state = "closed";
    record.closed_at = this.#deps.clock.now();
    record.terminal_closed = true;
    if (closedWith.value !== undefined) {
      record.close_reason = closedWith.value;
    }
    try {
      await this.#persist(store, record);
    } catch (error) {
      return failWith(
        "record_write_failed",
        `终端已关闭，但记录落盘失败：${describe(error)}`,
        "用 coagent list 核对；必要时手工删掉索引里的这条记录",
        record.coagent_id,
      );
    }

    const removed =
      keep.value === true
        ? false
        : await this.#dropRecordDir(store, record.coagent_id);

    return {
      ok: true,
      coagent_id: record.coagent_id,
      state: "closed",
      ...(record.terminal_id === undefined
        ? {}
        : { terminal_id: record.terminal_id }),
      ...(closedWith.value === undefined
        ? {}
        : { closed_with: closedWith.value }),
      ...(archivedFrom === "failed" || archivedFrom === "lost"
        ? { archived_from: archivedFrom }
        : {}),
      removed_files: removed,
    };
  }

  /**
   * 关闭终端：`force` 直接 `close`；否则先 `/quit` 再等进程退出（上限 `graceSec`），
   * 仍未退出就不关（留 `closing` 给 `force` 出口）。终端已不在视为成功。
   */
  async #closeTerminal(
    record: CoagentRecord,
    force: boolean,
    context: ServiceContext,
  ): Promise<
    | { ok: true; value?: "quit" | "terminal_close" }
    | { ok: false; reason: string }
  > {
    const terminalId = record.terminal_id;
    if (terminalId === undefined || record.terminal_closed === true) {
      return { ok: true };
    }

    if (!force) {
      return this.#gracefulClose(record, terminalId, context);
    }

    const closed = await this.#invoke(() =>
      this.#deps.herdr.close(terminalId, context),
    );
    if (!closed.ok && !isTerminalGone(closed)) {
      return {
        ok: false,
        reason: `关闭终端失败：${errorTextOf(closed)}`,
      };
    }
    return { ok: true, value: "terminal_close" };
  }

  /** 优雅关闭：`/quit` → 等退出 → `close`。 */
  async #gracefulClose(
    record: CoagentRecord,
    terminalId: string,
    context: ServiceContext,
  ): Promise<{ ok: true; value: "quit" } | { ok: false; reason: string }> {
    await this.#invoke(() =>
      this.#deps.herdr.run(terminalId, "/quit", context),
    );
    const exited = await this.#waitExit(record, terminalId, context);
    if (!exited) {
      return {
        ok: false,
        reason: `发出 /quit 后 ${this.#deps.config.graceSec}s 内仍有前台进程或终端未关闭`,
      };
    }
    const closed = await this.#invoke(() =>
      this.#deps.herdr.close(terminalId, context),
    );
    if (!closed.ok && !isTerminalGone(closed)) {
      return {
        ok: false,
        reason: `进程已退出，但关闭终端失败：${errorTextOf(closed)}`,
      };
    }
    return { ok: true, value: "quit" };
  }

  /** 等进程退出 / 终端消失（`graceSec` 上限；只读探测，不改记录）。 */
  async #waitExit(
    record: CoagentRecord,
    terminalId: string,
    context: ServiceContext,
  ): Promise<boolean> {
    const deadline = this.#deps.clock.now() + this.#deps.config.graceSec * 1000;
    for (;;) {
      const info = await this.#invoke(() =>
        this.#deps.herdr.info(terminalId, context),
      );
      if (isTerminalGone(info)) return true;
      if (info.ok && runningOf(info) === false) return true;
      if (record.session_id !== undefined) {
        const peer = await findPeer(this.#deps.channel, record.session_id);
        if (peer.known && peer.peer === undefined) return true;
      }
      if (this.#deps.clock.now() >= deadline) return false;
      await this.#deps.clock.sleep(this.#deps.config.gracePollMs);
      if (this.#deps.clock.now() >= deadline) return false;
    }
  }

  /** 删记录目录并在索引里留墓碑；目录删失败不阻塞回执。 */
  async #dropRecordDir(
    store: FileCoagentStore,
    coagentId: string,
  ): Promise<boolean> {
    let removed = false;
    try {
      removed = await store.removeRecordDir(coagentId);
      await store.update((index) => {
        const record = index.records[coagentId];
        if (record !== undefined) record.pruned = true;
      });
    } catch (error) {
      this.#deps.warn?.(
        `coagent: 删记录目录失败（${coagentId}）：${describe(error)}`,
      );
      return false;
    }
    return removed;
  }
}
