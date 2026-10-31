/**
 * 集成层装配器: 假工具面 + 假事件面 + 假服务面拼 `apply`.
 *
 * 三个假面的形状照宿主面 (`src/index.ts` 的 `BundleHost` / `src/types.ts` 的工具注册表与服务替身):
 * - 假工具面: `register(def)` 收集注册项, 等价宿主 `ctx.tools`;
 * - 假事件面: `on` / `emit` 记录订阅, 用来钉住「本包无事件消费者, apply 不订阅任何事件」;
 * - 假服务面: `ctx.get(name)` 受保护读取 `sandbox` / `sandboxPolicy` / `approval` / `clock`,
 *   直读未提供 Service 即抛 (`cannot get property "<name>" without inject`), 与 cordis 守卫同形;
 *   `expose: "property"` 模拟没有 `ctx.get` 的极简宿主, 走 apply 的属性回落分支.
 *
 * 工作目录与落盘根都在 `os.tmpdir()` 下的临时工作区里, 用 `cleanup()` 删除.
 * 本装配器不以 `.test.ts` 结尾, 不参与覆盖率统计 (只统 `src`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../src/index.ts";
import type { BundleHost, Config } from "../src/index.ts";
import type { ToolDef, ToolExecLike } from "../src/tools.ts";
import type {
  ApprovalServiceLike,
  SandboxPolicyServiceLike,
  SandboxProviderLike,
} from "../src/types.ts";

/** clock 服务面 (结构替身, 形状照 clock-base 的 `clock`). */
export interface ClockServiceLike {
  now(): number;
  scope(ctx?: unknown): unknown;
}

/** 假服务面: 四项都可缺省 (缺项即「极简 profile 没有该服务」). */
export interface FakeServices {
  sandbox?: SandboxProviderLike;
  sandboxPolicy?: SandboxPolicyServiceLike;
  approval?: ApprovalServiceLike;
  clock?: ClockServiceLike;
}

/** 假工具面: 按注册顺序收集工具定义. */
export interface FakeToolSurface {
  readonly defs: ToolDef[];
  register(definition: unknown): unknown;
}

/** 一次事件订阅. */
export interface FakeListener {
  readonly event: string;
  readonly handler: (payload: unknown) => void;
}

/** 假事件面: 记录订阅并可主动派发 (本包不使用, 用于断言不订阅). */
export interface FakeEventSurface {
  readonly listeners: FakeListener[];
  on(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): void;
}

/** 装配体: 注册结果 / 事件面 / 日志 / 执行与渲染入口 / 卸载与清理. */
export interface Assembly {
  /** 临时工作区 (策略根 = 本目录). */
  readonly workspace: string;
  readonly tools: FakeToolSurface;
  readonly events: FakeEventSurface;
  /** 经 `ctx.logger` 收集的日志行. */
  readonly logs: string[];
  /** apply 与运行期直接写 stderr 的告警 (logger 缺 warn 或无 logger 时). */
  readonly stderr: string[];
  readonly ctx: BundleHost;
  /** 取最后注册的工具定义 (未注册时抛错). */
  tool(): ToolDef;
  /** 调工具 `execute`, 缺省参数为空对象. */
  call(args?: unknown, exec?: ToolExecLike): Promise<unknown>;
  /** 调工具 `output.render` 并拼回执文本. */
  render(value: unknown, args?: unknown): string;
  /** 触发 `ctx.effect` 登记的卸载 disposer. */
  unload(): void;
  /** 删除临时工作区. */
  cleanup(): void;
}

/** 装配选项. */
export interface AssembleOptions {
  /**
   * 服务面: 缺省 = 围栏齐全 (放行式 confine + workspace-write 指向临时工作区);
   * `"none"` = 四项全缺; 函数 = 按临时工作区造自定义服务面.
   */
  services?: FakeServices | "none" | ((workspace: string) => FakeServices);
  /** 宿主读取口: `get` = cordis 风格受保护读取 (缺省); `property` = 极简宿主无 ctx.get. */
  expose?: "get" | "property";
  /** 是否提供工具面 (缺省 true; false = 模拟宿主未提供 ctx.tools). */
  tools?: boolean;
  /** 日志面: 收集 (缺省) / 有 logger 但缺 warn / 完全无 logger. */
  logger?: "collect" | "without-warn" | "none";
}

/** 缺省服务面: 围栏齐全, 策略根即临时工作区. */
export function defaultServices(workspace: string): FakeServices {
  return {
    sandbox: {
      async confine(argv) {
        return { argv, enforcement: "full" };
      },
    },
    sandboxPolicy: {
      resolve() {
        return { mode: "workspace-write", workspaceRoot: workspace };
      },
    },
    approval: {
      async request() {
        return "allowed-once";
      },
    },
  };
}

/** 捕获一段代码里写 stderr 的行 (结束后恢复原函数). */
export function captureStderr(run: () => void): string[] {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes;
}

/** cordis 里未 inject 的服务属性直读即抛; 只守卫这四个可选服务. */
const GUARDED = new Set(["sandbox", "sandboxPolicy", "approval", "clock"]);

/** 拼装 `apply` 与宿主接线: 假工具面 + 假事件面 + 假服务面 → 注册结果与执行入口. */
export function assemble(
  config?: Config,
  options: AssembleOptions = {},
): Assembly {
  const workspace = mkdtempSync(
    join(tmpdir(), "script-interpreter-integration-"),
  );
  const logs: string[] = [];
  const defs: ToolDef[] = [];
  const listeners: FakeListener[] = [];
  const disposers: Array<() => unknown> = [];

  const services: FakeServices =
    options.services === "none"
      ? {}
      : typeof options.services === "function"
        ? options.services(workspace)
        : (options.services ?? defaultServices(workspace));

  const tools: FakeToolSurface = {
    defs,
    register(definition: unknown): unknown {
      defs.push(definition as ToolDef);
      return definition;
    },
  };

  const events: FakeEventSurface = {
    listeners,
    on(event, handler) {
      const entry: FakeListener = { event, handler };
      listeners.push(entry);
      return () => {
        const at = listeners.indexOf(entry);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    emit(event, payload) {
      for (const entry of [...listeners]) {
        if (entry.event === event) entry.handler(payload);
      }
    },
  };

  const base: Record<string, unknown> = {
    on: events.on,
    emit: events.emit,
    effect(fn: () => () => void): () => void {
      const dispose = fn();
      disposers.push(dispose);
      return () => {
        void dispose();
      };
    },
    ...(options.tools === false ? {} : { tools }),
  };

  const logger = options.logger ?? "collect";
  if (logger !== "none") {
    base["logger"] = (ns: string) => {
      const sink: {
        info(message: string): void;
        warn?(message: string): void;
      } = { info: (message) => logs.push(`${ns}: ${message}`) };
      if (logger === "collect") {
        sink.warn = (message) => logs.push(`${ns}: 警告：${message}`);
      }
      return sink;
    };
  }

  let ctx: BundleHost;
  if (options.expose === "property") {
    ctx = { ...base, ...services } as unknown as BundleHost;
  } else {
    const table = services as Record<string, unknown>;
    const guarded = new Proxy(
      { ...base, get: (name: string): unknown => table[name] },
      {
        get(target, prop, receiver) {
          if (
            typeof prop === "string" &&
            GUARDED.has(prop) &&
            !Reflect.has(target, prop)
          ) {
            throw new Error(`cannot get property "${prop}" without inject`);
          }
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    ctx = guarded as unknown as BundleHost;
  }

  const stderr = captureStderr(() => {
    apply(ctx, config);
  });

  const tool = (): ToolDef => {
    const last = defs.at(-1);
    if (last === undefined) throw new Error("apply 没有注册任何工具");
    return last;
  };

  return {
    workspace,
    tools,
    events,
    logs,
    stderr,
    ctx,
    tool,
    call(args: unknown = {}, exec?: ToolExecLike): Promise<unknown> {
      return tool().execute(args, exec);
    },
    render(value: unknown, args: unknown = {}): string {
      return tool()
        .output.render(args, value)
        .map((block) => block.text)
        .join("\n");
    },
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
    cleanup(): void {
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
