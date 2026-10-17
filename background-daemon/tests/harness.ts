/**
 * 测试共用的假件（假 timer / 假渠道 / 组装一条完整的守护链路）。
 *
 * 不放 `*.test.ts` 命名里：它不是用例文件, 由各测试 import 使用。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Journal } from "../src/journal.ts";
import {
  ChannelRegistry,
  Scheduler,
  type AgentsLike,
  type TimerLike,
} from "../src/scheduler.ts";
import { TaskStore } from "../src/store.ts";
import type {
  AgentLike,
  ChannelResult,
  DaemonChannel,
  DaemonTask,
  DeliveryRequest,
  NewTaskInput,
} from "../src/types.ts";

export const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

/** 假 timer：记录每次排期, 支持统计存活段与手动触发。 */
export class FakeTimer implements TimerLike {
  readonly entries: {
    delay: number;
    callback: () => void;
    disposed: boolean;
  }[] = [];

  schedule(delay: number, callback: () => void): () => void {
    const entry = { delay, callback, disposed: false };
    this.entries.push(entry);
    return () => {
      entry.disposed = true;
    };
  }

  get live(): { delay: number; callback: () => void; disposed: boolean }[] {
    return this.entries.filter((entry) => !entry.disposed);
  }

  get pendingDelay(): number | null {
    return this.live[0]?.delay ?? null;
  }
}

export interface FakeChannel extends DaemonChannel {
  readonly requests: DeliveryRequest[];
}

export function makeChannel(
  mode: "deliver" | "command",
  respond: (
    request: DeliveryRequest,
  ) => Promise<ChannelResult> | ChannelResult = () => ({
    ok: true,
    durable: true,
  }),
): FakeChannel {
  const requests: DeliveryRequest[] = [];
  return {
    mode,
    requests,
    async deliver(request: DeliveryRequest): Promise<ChannelResult> {
      requests.push(request);
      return await respond(request);
    },
  };
}

export interface Harness {
  dir: string;
  clock: { value: number };
  store: TaskStore;
  journal: Journal;
  timer: FakeTimer;
  agents: Map<string, AgentLike>;
  text: FakeChannel;
  command: FakeChannel;
  scheduler: Scheduler;
  warnings: string[];
  create(
    input: Partial<NewTaskInput> & { selector: NewTaskInput["selector"] },
  ): DaemonTask;
  cleanup(): void;
}

export function harness(
  options: {
    awaitAgentMs?: number;
    catchUpWindowMs?: number;
    maxDelayMs?: number;
    respondText?: (
      request: DeliveryRequest,
    ) => Promise<ChannelResult> | ChannelResult;
    respondCommand?: (
      request: DeliveryRequest,
    ) => Promise<ChannelResult> | ChannelResult;
    agents?: Map<string, AgentLike>;
    start?: boolean;
  } = {},
): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "background-daemon-test-"));
  const clock = { value: NOW };
  const store = new TaskStore(path.join(dir, "tasks.json"), () => clock.value);
  const journal = new Journal(path.join(dir, "journal.jsonl"), { limit: 50 });
  journal.load();
  const warnings: string[] = [];
  const agentMap = options.agents ?? new Map<string, AgentLike>();
  if (options.agents === undefined) {
    agentMap.set("sess-1", {
      session: { id: "sess-1" },
      status: "idle",
      followup: () => {},
    });
  }
  const agents: AgentsLike = { get: (id) => agentMap.get(id) };
  const text = makeChannel("deliver", options.respondText);
  const command = makeChannel("command", options.respondCommand);
  const channels = new ChannelRegistry();
  channels.register(text);
  channels.register(command);
  const timer = new FakeTimer();
  const scheduler = new Scheduler({
    store,
    journal,
    channels,
    agents,
    timer,
    now: () => clock.value,
    warn: (message) => warnings.push(message),
    ...(options.awaitAgentMs === undefined
      ? {}
      : { awaitAgentMs: options.awaitAgentMs }),
    ...(options.catchUpWindowMs === undefined
      ? {}
      : { catchUpWindowMs: options.catchUpWindowMs }),
    ...(options.maxDelayMs === undefined
      ? {}
      : { maxDelayMs: options.maxDelayMs }),
  });
  if (options.start !== false) scheduler.start();
  return {
    dir,
    clock,
    store,
    journal,
    timer,
    agents: agentMap,
    text,
    command,
    scheduler,
    warnings,
    create(input) {
      return store.create({
        mode: "deliver",
        sessionId: "sess-1",
        payload: "提醒",
        ...input,
      });
    },
    cleanup() {
      // 临时目录在系统 tmp 下；测试进程结束即回收, 这里显式删掉避免堆积
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
