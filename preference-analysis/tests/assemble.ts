/**
 * 集成层装配器：用假事件面 / 假 memory 服务面 / 假工具面 / 假 rule-engine 面拼出本包 `apply`。
 *
 * 三个假面形状统一 —— 每个面只有「注册入口 + 调用记录 + 解绑计数」，不引宿主代码：
 * - 事件面：`on` 收集监听器，`emit` 喂事件，`off` 摘除并计数；
 * - 工具面：`register` 收集工具定义，`call` / `render` 走定义里的 `execute` / `output.render`；
 * - 服务面：memory 用 `preference-analysis/tests/fakes.ts` 的冻结句柄面，ruleEngine 收集消费者并可代调 `decide`。
 *
 * ctx 按 cordis 语义造：服务只能经 `ctx.get` 取（直接读属性抛错）；`viaGet: false` 时
 * 退回直接属性，覆盖非 cordis 测试宿主的兜底路径。状态一律落临时目录，`cleanup` 删除。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, type Config } from "../src/index.ts";
import { emptyLedger, type LedgerFile } from "../src/ledger.ts";
import type { ToolDef } from "../src/tools.ts";
import { fakeMemory, userEvent, type FakeMemory } from "./fakes.ts";

/** pin-note 动态保持的一条登记（结构面，不 import 对方代码）。 */
export interface HeldEntry {
  key: string;
  provider: () => string | undefined;
}

/** 假事件面。 */
export interface FakeEventFace {
  /** 订阅过的事件名（按注册顺序）。 */
  readonly names: string[];
  readonly listeners: Array<(session: unknown, event: unknown) => void>;
  /** 已执行的解绑次数。 */
  readonly offs: number;
  emit(session: unknown, event: unknown): void;
}

/** 假工具面。 */
export interface FakeToolFace {
  readonly defs: ToolDef[];
  register(def: unknown): void;
  /** 按注册名调 `execute`（未注册即抛错，避免静默跳过）。 */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** 按注册名调 `output.render`，返回拼好的文本。 */
  render(name: string, value: unknown): string;
}

/** 假 pin-note 面（动态保持登记）。 */
export interface FakePinNotesFace {
  readonly holds: HeldEntry[];
  readonly offs: number;
  hold(key: string, provider: () => string | undefined): () => void;
  /** 代宿主同步某 key 的 provider（缺省最近一条；未登记给 null）。 */
  text(key?: string): string | null;
}

/** 装配结果。 */
export interface IntegrationHost {
  readonly ctx: unknown;
  readonly dir: string;
  readonly ledgerPath: string;
  readonly memory: FakeMemory;
  readonly events: FakeEventFace;
  readonly tools: FakeToolFace;
  readonly pinNotes: FakePinNotesFace;
  /** `apply` 期间写到 stderr 的告警（按行收集）。 */
  readonly warnings: string[];
  /** 喂一条 user/message 事件（会话 id / cwd 可指定）。 */
  feed(
    sessionId: string,
    text: string,
    options?: { cwd?: string; time?: number; sourceKind?: string },
  ): void;
  /** 读账簿（文件不存在给空账簿）。 */
  readLedger(): Promise<LedgerFile>;
  /**
   * 触发一轮归纳并等账簿满足条件：每次轮询发一条 `compaction/end`（按 `minIntervalMs`
   * 节流），超时抛错。`nudge: false` 时只轮询（等启动后那次归纳）。
   */
  flush(
    goal: (ledger: LedgerFile) => boolean,
    options?: { nudge?: boolean; timeoutMs?: number },
  ): Promise<LedgerFile>;
  dispose(): void;
  /** 解绑事件 / 消费者并删除临时目录。 */
  cleanup(): Promise<void>;
}

/** 装配选项。 */
export interface AssembleOptions {
  config?: Partial<Config>;
  /** 缺省造一份假 memory；`null` 表示服务缺席。 */
  memory?: FakeMemory | null;
  /** 缺省提供 pin-note 动态保持面；`false` 表示服务缺席。 */
  pinNotes?: boolean;
  /** 缺省提供工具面；`false` 表示服务缺席。 */
  tools?: boolean;
  /** 缺省 true = cordis 语义（服务只能经 `ctx.get`）；false = 直接属性。 */
  viaGet?: boolean;
  /** 复用已有目录（缺省新建临时目录）。 */
  dir?: string;
}

const POLL_INTERVAL_MS = 10;
const DEFAULT_TIMEOUT_MS = 2_000;

/** 拼出本包 `apply` 与三个假面。 */
export async function assemble(
  options: AssembleOptions = {},
): Promise<IntegrationHost> {
  const dir =
    options.dir ?? (await mkdtemp(join(tmpdir(), "pref-integration-")));
  const ledgerPath = options.config?.ledgerPath ?? join(dir, "ledger.json");
  const memory =
    options.memory === null ? fakeMemory() : (options.memory ?? fakeMemory());

  // 事件面
  const eventNames: string[] = [];
  const listeners: Array<(session: unknown, event: unknown) => void> = [];
  let eventOffs = 0;
  const events: FakeEventFace = {
    names: eventNames,
    listeners,
    get offs() {
      return eventOffs;
    },
    emit(session, event) {
      for (const listener of [...listeners]) listener(session, event);
    },
  };

  // 工具面
  const defs: ToolDef[] = [];
  const tools: FakeToolFace = {
    defs,
    register(def) {
      defs.push(def as ToolDef);
    },
    async call(name, args = {}) {
      return findTool(defs, name).execute(args);
    },
    render(name, value) {
      return findTool(defs, name)
        .output.render({}, value)
        .map((block) => block.text)
        .join("");
    },
  };

  // pin-note 面（动态保持登记）
  const holds: HeldEntry[] = [];
  let holdOffs = 0;
  const pinNotes: FakePinNotesFace = {
    holds,
    get offs() {
      return holdOffs;
    },
    hold(key, provider) {
      const entry: HeldEntry = { key, provider };
      holds.push(entry);
      return () => {
        holdOffs += 1;
        const index = holds.indexOf(entry);
        if (index >= 0) holds.splice(index, 1);
      };
    },
    text(key) {
      const entry =
        key === undefined
          ? holds[holds.length - 1]
          : holds.find((h) => h.key === key);
      return entry === undefined ? null : (entry.provider() ?? null);
    },
  };

  // ctx：服务只进 get 表（cordis 里直接读未 inject 的属性会抛错）
  const services: Record<string, unknown> = {};
  if (options.memory !== null) services["memory"] = memory.face;
  if (options.pinNotes !== false) services["pinNotes"] = pinNotes;
  if (options.tools !== false) services["tools"] = tools;
  const target: Record<string, unknown> = {
    on(name: string, listener: (session: unknown, event: unknown) => void) {
      eventNames.push(name);
      listeners.push(listener);
      return () => {
        eventOffs += 1;
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  if (options.viaGet !== false) {
    target["get"] = (name: string): unknown => services[name];
  } else {
    for (const [name, value] of Object.entries(services)) target[name] = value;
  }
  const ctx = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && !(property in object)) {
        throw new Error(`cannot get property "${property}" without inject`);
      }
      return Reflect.get(object, property, receiver);
    },
  });

  // apply 期告警（stderr）单独收集；装配结束后立即还原
  const warnings: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    warnings.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stderr.write;
  let dispose: () => void;
  try {
    dispose = apply(ctx, {
      ledgerPath,
      minIntervalMs: 1,
      ...options.config,
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  const host: IntegrationHost = {
    ctx,
    dir,
    ledgerPath,
    memory,
    events,
    tools,
    pinNotes,
    warnings,
    feed(sessionId, text, feedOptions = {}) {
      events.emit(
        { id: sessionId, header: { cwd: feedOptions.cwd ?? "/p" } },
        userEvent(text, {
          time: feedOptions.time ?? Date.now(),
          ...(feedOptions.sourceKind === undefined
            ? { sourceKind: feedOptions.sourceKind }
            : {}),
        }),
      );
    },
    async readLedger() {
      try {
        return JSON.parse(await readFile(ledgerPath, "utf8")) as LedgerFile;
      } catch {
        return emptyLedger(0);
      }
    },
    async flush(goal, flushOptions = {}) {
      const deadline =
        Date.now() + (flushOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      for (;;) {
        if (flushOptions.nudge !== false) {
          events.emit(
            { id: "flush", header: { cwd: "/p" } },
            { type: "compaction/end" },
          );
        }
        await delay(POLL_INTERVAL_MS);
        const ledger = await host.readLedger();
        if (goal(ledger)) return ledger;
        if (Date.now() > deadline) {
          throw new Error(
            `等待账簿超时：${JSON.stringify({
              entries: ledger.entries.length,
              statuses: ledger.entries.map((entry) => entry.status),
              unformed: ledger.unformed,
            })}`,
          );
        }
      }
    },
    dispose() {
      dispose();
    },
    async cleanup() {
      dispose();
      // 启动后那次归纳可能仍在写盘：等一拍再删目录，避免 ENOENT 噪声
      await delay(POLL_INTERVAL_MS);
      await rm(dir, { recursive: true, force: true });
    },
  };
  return host;
}

function findTool(defs: readonly ToolDef[], name: string): ToolDef {
  const tool = defs.find((def) => def.name === name);
  if (tool === undefined) {
    throw new Error(
      `工具未注册：${name}（已注册 ${defs.map((def) => def.name).join(", ")}）`,
    );
  }
  return tool;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
