/**
 * 调度器：单 timer 驱动 + 补发 + 记账（不重试）。
 *
 * 口径（设计 §A 关键时序 / §B / §C③④）：
 * - **单一 timer**：任何时刻至多一个待触发定时器, 任务表变更后重算（`arm()` 先撤销旧 timer）；
 * - **分段**：超过单段上限（缺省 24 h, 远低于平台约 24.8 天上限）的长延迟切成多段,
 *   每段到点重读墙钟再排；
 * - **补发**：周期任务只补最近一次错过的发生时点；一次性超补发窗口转 `missed`；
 * - **同会话同批合并**：同一会话同一批到期的 `deliver` 任务合并成一条消息（一条请求）,
 *   `command` 任务逐条立即执行（语义不同, 不合并）；
 * - **不重试**（2026-10-17 裁定）：投递失败只记账 + 写流水, 周期任务等下一个触发点；
 * - 目标 = 本进程内已注册的活跃 agent（`agents.get(sessionId)`）；未命中 → `skipped`
 *   （`no-active-agent`）, 可配 `awaitAgentMs` 宽限窗口（窗口内按固定间隔复查,
 *   不是失败重试链）。
 */

import { decide, DEFAULT_CATCH_UP_WINDOW_MS, nextWakeAt } from "./due.ts";
import type { DueDecision, DueInput } from "./due.ts";
import type { Journal } from "./journal.ts";
import { isPeriodic, nextAfter } from "./selectors.ts";
import type { TaskStore } from "./store.ts";
import type {
  AgentLike,
  ChannelResult,
  DaemonChannel,
  DaemonTask,
  RunOutcome,
  TaskMode,
} from "./types.ts";

/** timer 原语（内部统一面：`schedule(delayMs, cb) → disposer`）。 */
export interface TimerLike {
  schedule(delayMs: number, callback: () => void): () => void;
}

/** 宿主 `cordis-plugin-timer` 的形状：只有 `timeout(cb, delay)`, 没有 `schedule`。 */
export interface HostTimerLike {
  timeout(callback: () => void, delayMs: number): () => void;
}

/**
 * 把宿主 timer 适配成内部统一面（设计 D16：复用 `ctx.timer` 的 `timeout()`）。
 * 宿主服务缺失或形状不符时由装配层决定回落, 这里不做判断。
 */
export function hostTimer(service: HostTimerLike): TimerLike {
  return {
    schedule(delayMs, callback) {
      return service.timeout(callback, delayMs);
    },
  };
}

/** 进程内定时器（不依赖宿主 timer 服务；unref 避免拖住进程退出）。 */
export function systemTimer(): TimerLike {
  return {
    schedule(delayMs, callback) {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return () => clearTimeout(handle);
    },
  };
}

/** 活跃 agent 解析面（`ctx.agents.get`）。 */
export interface AgentsLike {
  get(sessionId: string): AgentLike | undefined | null;
}

/** 渠道注册表（首期两条; 将来 herdr / headless 渠道实现同一缝）。 */
export class ChannelRegistry {
  readonly #channels = new Map<TaskMode, DaemonChannel>();

  register(channel: DaemonChannel): () => void {
    this.#channels.set(channel.mode, channel);
    return () => {
      if (this.#channels.get(channel.mode) === channel) {
        this.#channels.delete(channel.mode);
      }
    };
  }

  get(mode: TaskMode): DaemonChannel | undefined {
    return this.#channels.get(mode);
  }

  list(): DaemonChannel[] {
    return [...this.#channels.values()];
  }
}

/** 单段 timer 上限缺省值（24 h：跨休眠 / 回拨后仍能尽早重读墙钟）。 */
export const DEFAULT_MAX_DELAY_MS = 24 * 60 * 60 * 1000;

/** 目标未活跃时的复查间隔（宽限窗口内）。 */
const RETRY_AGENT_CHECK_MS = 1000;

export interface SchedulerOptions {
  store: TaskStore;
  journal: Journal;
  channels: ChannelRegistry;
  agents: AgentsLike;
  timer: TimerLike;
  now?: () => number;
  warn?: (message: string) => void;
  maxDelayMs?: number;
  catchUpWindowMs?: number;
  /** 目标未活跃时等多久（缺省 0 = 立即 skipped）。 */
  awaitAgentMs?: number;
  /**
   * `start()` 是否自己加载任务表（缺省 true）。
   * memory-base 作权威底座时由装配层先读出并 `adopt`, 这里置 false 以免覆盖。
   */
  loadStore?: boolean;
}

export interface SchedulerStatus {
  /** 调度器是否已启动（store 不可用时为 false）。 */
  running: boolean;
  /** 单 timer 的下次唤醒时刻（null = 无待触发任务）。 */
  nextAt: number | null;
  /** 在途投递数（关闭时等待其结束）。 */
  inflight: number;
  /** store 不可用原因。 */
  error: string | null;
}

/** 任务记录 → 到期决策切片（`anchor` 取创建时刻）。 */
function toDueInput(task: DaemonTask): DueInput {
  return {
    status: task.status,
    selector: task.selector,
    anchor: task.createdAt,
    next: task.next,
  };
}

interface FireItem {
  task: DaemonTask;
  /** 触发后应写入的 next（一次性 = null）。 */
  next: number | null;
}

interface DeliveryOutcome {
  result: ChannelResult;
  durationMs: number;
}

export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #now: () => number;
  readonly #warn: (message: string) => void;
  readonly #maxDelayMs: number;
  readonly #catchUpWindowMs: number;
  readonly #awaitAgentMs: number;
  #running = false;
  #disposeTimer: (() => void) | null = null;
  #nextAt: number | null = null;
  #lastNow: number | null = null;
  readonly #inflight = new Set<Promise<void>>();
  /** 宽限窗口内的等待起点（任务 id → 首次发现未活跃的时刻）。 */
  readonly #waitingSince = new Map<string, number>();

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#warn =
      options.warn ??
      ((message) => {
        process.stderr.write(`[background-daemon] warn: ${message}\n`);
      });
    this.#maxDelayMs =
      options.maxDelayMs !== undefined && options.maxDelayMs > 0
        ? options.maxDelayMs
        : DEFAULT_MAX_DELAY_MS;
    this.#catchUpWindowMs =
      options.catchUpWindowMs ?? DEFAULT_CATCH_UP_WINDOW_MS;
    this.#awaitAgentMs = Math.max(0, options.awaitAgentMs ?? 0);
  }

  /** 启动：加载任务表 → 补算到期 → 排 timer。store 不可用则不启用（不抛）。 */
  start(): SchedulerStatus {
    if (this.#options.loadStore !== false) {
      const loaded = this.#options.store.load();
      if (!loaded.ok) {
        this.#running = false;
        this.#warn(`任务表面不可用（守护不启用）：${loaded.error}`);
        return this.status();
      }
    }
    this.#running = true;
    // 启动补算：到期的任务立即处理（周期只补最近一次, 一次性超窗转 missed）
    this.#track(this.runDue());
    return this.status();
  }

  /** 任务表变更后重算 timer（新建 / 暂停 / 恢复 / 取消都走这里）。 */
  arm(): void {
    if (!this.#running) return;
    this.#disposeTimer?.();
    this.#disposeTimer = null;
    const now = this.#now();
    const tasks = this.#options.store.list();
    // 清理已删除任务的宽限等待记录（取消 / 删除后不应留在等待表里）
    const alive = new Set(tasks.map((task) => task.id));
    for (const id of [...this.#waitingSince.keys()]) {
      if (!alive.has(id)) this.#waitingSince.delete(id);
    }
    const target = nextWakeAt(tasks.map((task) => toDueInput(task)));
    this.#nextAt = target;
    if (target === null) return;
    let delay = this.#delayFor(target, now);
    if (target <= now) {
      // 已到期：正常到期由 runDue 立即处理；宽限等待中的任务按固定间隔复查（避免忙等）
      delay = this.#waitingDelay(now);
    }
    this.#disposeTimer = this.#options.timer.schedule(delay, () => {
      this.#disposeTimer = null;
      this.#track(this.runDue());
    });
  }

  /** 处理所有到期任务（timer 到点 / 启动补算 / 测试直接驱动）。 */
  async runDue(): Promise<void> {
    if (!this.#running) return;
    const now = this.#now();
    this.#detectRollback(now);
    this.#lastNow = now;
    const fires: FireItem[] = [];
    for (const task of this.#options.store.list()) {
      const decision: DueDecision = decide(
        toDueInput(task),
        now,
        this.#catchUpWindowMs,
      );
      if (decision.kind === "missed") {
        this.#applyMissed(task, decision.reason, now);
        continue;
      }
      if (decision.kind === "fire") {
        fires.push({ task, next: decision.next });
      }
    }
    if (fires.length > 0) await this.#dispatch(fires, now);
    this.arm();
  }

  /** `/daemon run <id>`：立即投递一次（不改 `next` / 状态, 只更新上次结果）。 */
  async runNow(id: string): Promise<ChannelResult> {
    const task = this.#options.store.get(id);
    if (task === undefined) {
      return { ok: false, code: "error", message: `任务不存在：${id}` };
    }
    const now = this.#now();
    const agent = this.#options.agents.get(task.sessionId);
    if (agent === undefined || agent === null) {
      const outcome: ChannelResult = {
        ok: false,
        code: "no-active-agent",
        message: `目标会话无活跃 agent：${task.sessionId}`,
      };
      this.#applyOutcome(task, task.next, now, "skipped", outcome, 0, true);
      return outcome;
    }
    const delivered = await this.#deliver([task], task.mode, agent);
    this.#applyOutcome(
      task,
      task.next,
      now,
      this.#outcomeOf(delivered.result),
      delivered.result,
      delivered.durationMs,
      true,
    );
    return delivered.result;
  }

  /** 关闭：撤销 timer、等在途投递结束（任务表每次变更已落盘, 无需额外 flush）。 */
  async stop(): Promise<void> {
    this.#running = false;
    this.#disposeTimer?.();
    this.#disposeTimer = null;
    this.#nextAt = null;
    await this.settle();
  }

  /** 等在途调度 / 投递结束（关闭与测试共用）。 */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#inflight]);
  }

  status(): SchedulerStatus {
    return {
      running: this.#running,
      nextAt: this.#nextAt,
      inflight: this.#inflight.size,
      error: this.#options.store.error,
    };
  }

  /** 单段延迟：不超上限、不小于 1 ms（0 延迟会在同一 tick 里自旋）。 */
  #delayFor(target: number, now: number): number {
    return Math.min(this.#maxDelayMs, Math.max(1, target - now));
  }

  /** 宽限等待中的复查延迟（截到窗口剩余时间）。 */
  #waitingDelay(now: number): number {
    const since = [...this.#waitingSince.values()].sort(
      (left, right) => left - right,
    )[0];
    if (since === undefined || this.#awaitAgentMs <= 0) return 1;
    const remaining = Math.max(1, this.#awaitAgentMs - (now - since));
    return Math.min(RETRY_AGENT_CHECK_MS, remaining);
  }

  #track(work: Promise<void>): void {
    const tracked = work
      .catch((err) => {
        this.#warn(`调度循环异常（已隔离）：${String(err)}`);
      })
      .finally(() => {
        this.#inflight.delete(tracked);
      });
    this.#inflight.add(tracked);
  }

  /** 墙钟回拨检测：往回跳超过 1 s 即按当前时钟重算周期任务的 next。 */
  #detectRollback(now: number): void {
    if (this.#lastNow === null || now >= this.#lastNow - 1000) return;
    this.#warn(
      `检测到时钟回拨（${new Date(this.#lastNow).toISOString()} → ` +
        `${new Date(now).toISOString()}）：按当前时钟重算周期任务的下次触发`,
    );
    for (const task of this.#options.store.list()) {
      if (task.status !== "active" || !isPeriodic(task.selector)) continue;
      const recomputed = nextAfter(task.selector, now, task.createdAt);
      if (recomputed !== null && recomputed !== task.next) {
        try {
          this.#options.store.update(task.id, { next: recomputed });
        } catch (err) {
          this.#warn(`任务表写回失败（${task.id}）：${String(err)}`);
        }
      }
    }
  }

  /** 到期批次分派：文本按会话合并, 命令逐条。 */
  async #dispatch(fires: FireItem[], now: number): Promise<void> {
    const deliverBySession = new Map<string, FireItem[]>();
    const commands: FireItem[] = [];
    for (const item of fires) {
      if (item.task.mode === "command") {
        commands.push(item);
        continue;
      }
      const bucket = deliverBySession.get(item.task.sessionId);
      if (bucket === undefined)
        deliverBySession.set(item.task.sessionId, [item]);
      else bucket.push(item);
    }
    const jobs: Promise<void>[] = [];
    for (const [sessionId, items] of deliverBySession) {
      jobs.push(this.#fireGroup(sessionId, items, now));
    }
    for (const item of commands) {
      jobs.push(this.#fireGroup(item.task.sessionId, [item], now));
    }
    await Promise.all(jobs);
  }

  async #fireGroup(
    sessionId: string,
    items: FireItem[],
    now: number,
  ): Promise<void> {
    const firstId = items[0]?.task.id;
    const knownSince =
      firstId === undefined ? undefined : this.#waitingSince.get(firstId);
    const agent = this.#options.agents.get(sessionId);
    if (agent === undefined || agent === null) {
      const since = knownSince ?? now;
      for (const item of items) {
        if (!this.#waitingSince.has(item.task.id)) {
          this.#waitingSince.set(item.task.id, since);
        }
      }
      if (this.#awaitAgentMs > 0 && now - since < this.#awaitAgentMs) {
        // 窗口内：保持 next 不变, 下次复查再说（不记流水, 不算重试）
        return;
      }
      for (const item of items) {
        this.#waitingSince.delete(item.task.id);
        const outcome: ChannelResult = {
          ok: false,
          code: "no-active-agent",
          message: `目标会话无活跃 agent：${sessionId}`,
        };
        this.#applyOutcome(
          item.task,
          item.next,
          now,
          "skipped",
          outcome,
          0,
          false,
        );
      }
      return;
    }
    for (const item of items) this.#waitingSince.delete(item.task.id);
    const mode = items[0]?.task.mode ?? "deliver";
    const delivered = await this.#deliver(
      items.map((item) => item.task),
      mode,
      agent,
    );
    const outcome = this.#outcomeOf(delivered.result);
    for (const item of items) {
      this.#applyOutcome(
        item.task,
        item.next,
        now,
        outcome,
        delivered.result,
        delivered.durationMs,
        false,
      );
    }
  }

  /** 调渠道（异常归一成 failed, 不让单次投递炸掉调度循环）。 */
  async #deliver(
    tasks: DaemonTask[],
    mode: TaskMode,
    agent: AgentLike,
  ): Promise<DeliveryOutcome> {
    const channel = this.#options.channels.get(mode);
    if (channel === undefined) {
      return {
        result: { ok: false, code: "error", message: `渠道未注册：${mode}` },
        durationMs: 0,
      };
    }
    const startedAt = this.#now();
    try {
      const result = await channel.deliver({
        tasks,
        agent,
        signal: new AbortController().signal,
      });
      return { result, durationMs: Math.max(0, this.#now() - startedAt) };
    } catch (err) {
      return {
        result: { ok: false, code: "error", message: String(err) },
        durationMs: Math.max(0, this.#now() - startedAt),
      };
    }
  }

  /**
   * 渠道结果 → 结局。
   *
   * `flush_failed` 特别处理（D13）：消息已进内存收件箱、落盘未确认, 记 `delivered` +
   * `durable:false` + 一条告警, **不**自动重投。
   */
  #outcomeOf(result: ChannelResult): RunOutcome {
    if (result.ok) return "delivered";
    if (result.code === "flush_failed") return "delivered";
    if (result.code === "no-active-agent") return "skipped";
    return "failed";
  }

  /** 把结局写回任务表 + 流水（不重试）。 */
  #applyOutcome(
    task: DaemonTask,
    next: number | null,
    now: number,
    outcome: RunOutcome,
    result: ChannelResult,
    durationMs: number,
    manual: boolean,
  ): void {
    const durable = result.durable !== false;
    // `lastError` / 流水的 error 存**原因码**（机器可判）, 人类可读文案进 detail
    const error = result.ok ? null : result.code;
    const detailParts: string[] = [];
    if (!result.ok && result.message !== undefined)
      detailParts.push(result.message);
    if (result.ok && result.detail !== undefined)
      detailParts.push(result.detail);
    if (result.ok && result.guardSkipped === true)
      detailParts.push("guardSkipped");
    if (!result.ok && result.code === "flush_failed") {
      detailParts.push("durable:false");
      this.#warn(
        `投递落盘未确认（durable:false, 不重投）：任务 ${task.id} — ${result.message ?? ""}`,
      );
    }
    this.#options.journal.append({
      taskId: task.id,
      tier: task.tier,
      at: now,
      sessionId: task.sessionId,
      mode: task.mode,
      outcome,
      error,
      durationMs,
      detail: detailParts.length === 0 ? null : detailParts.join("；"),
    });
    if (manual) {
      // 手动触发：保持 next / status 不变, 只更新上次结果
      try {
        this.#options.store.update(task.id, {
          lastFireAt: now,
          lastOutcome: outcome,
          lastError: error,
        });
      } catch (err) {
        this.#warn(`任务表写回失败（${task.id}）：${String(err)}`);
      }
      return;
    }
    const status: DaemonTask["status"] = isPeriodic(task.selector)
      ? task.status
      : "done";
    try {
      this.#options.store.update(task.id, {
        next,
        lastFireAt: now,
        lastOutcome: outcome,
        lastError: error,
        status,
      });
    } catch (err) {
      this.#warn(`任务表写回失败（${task.id}）：${String(err)}`);
    }
    if (!durable) {
      this.#warn(`投递为 volatile（durable:false）：任务 ${task.id}`);
    }
  }

  /** `missed` 结局（一次性过期 / 暂停期间到点）。 */
  #applyMissed(task: DaemonTask, reason: string, now: number): void {
    this.#options.journal.append({
      taskId: task.id,
      tier: task.tier,
      at: now,
      sessionId: task.sessionId,
      mode: task.mode,
      outcome: "missed",
      error: reason,
      durationMs: 0,
      detail: null,
    });
    try {
      this.#options.store.update(task.id, {
        status: "missed",
        next: null,
        lastOutcome: "missed",
        lastError: reason,
      });
    } catch (err) {
      this.#warn(`任务表写回失败（${task.id}）：${String(err)}`);
    }
  }
}
