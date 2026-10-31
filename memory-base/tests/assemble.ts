/**
 * tests/assemble.ts — 集成层装配器（不以 `.test.ts` 结尾）
 *
 * 把「假工具面 / 假事件面 / 假服务面」拼成一个最小宿主 ctx，交给本包 `apply(ctx, config)`，
 * 再把暴露出来的 `memory` 服务、`memory_query` 工具与事件订阅交回用例。三个假面的形状与
 * 阶段 2 规范 4.2 一致，换包时可复用同一套写法：
 *
 * - 工具面：收集 `register(def)`，用例按工具名取回并调 `execute` / `output.render`；
 * - 事件面：记录 `on(event, listener)` 并支持解绑（本包不订阅事件，用例断言其为空）；
 * - 服务面：`get(key)` 只回假 `sessionPaths`，`provide(name, value)` 记录本包暴露的 `memory`。
 *
 * 外部世界全部为替身，库落盘只写 `os.tmpdir()` 下的临时目录（装配器自己建、`cleanup()` 自己删）：
 * - `dshHome` → `<dir>/dsh`，U 库落 `<dir>/dsh/memory-base/user.db`；
 * - `projectRoot` → `<dir>/repo`，P 库落 `<dir>/repo/.dsh/project.db`；
 * - `sessionPaths.sessionDirFor(id)` → `<dir>/sessions/<id>`，S 库落 `session.db`。
 *
 * 装配器不跑 `apply` 以外的宿主逻辑，也**不主动打开任何库**（层库仍由首次写入惰性创建）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply,
  getMemoryBundle,
  type BundleHost,
  type KnowledgeConfig,
  type MemoryBundle,
  type MemoryGlobalService,
} from "../src/index.ts";
import type { SessionPathsLike } from "../src/tiers.ts";

/** `memory_query` 工具定义的最小结构面（本包只注册这一个工具）。 */
export interface MemoryQueryToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  output: {
    schema: Record<string, unknown>;
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

/** 服务面对象的最小结构（`ctx.get` 的返回值）。 */
export interface FakeServices {
  sessionPaths?: SessionPathsLike;
}

/** 工具面的三种形态。 */
export type ToolsMode = "ok" | "missing" | "throws";

/** 服务暴露面（`ctx.provide`）的三种形态。 */
export type ProvideMode = "ok" | "missing" | "throws";

/** 服务读取面（`ctx.get`）的三种形态。 */
export type GetMode = "ok" | "missing" | "throws";

/** 装配参数。 */
export interface AssemblyOptions {
  /** 插件配置（落点由装配器的临时目录补齐）。 */
  config?: KnowledgeConfig;
  /** 会话目录解析面：缺省按 `<dir>/sessions/<id>` 分桶；`none` 不挂（S 层不可写）。 */
  sessionPaths?: SessionPathsLike | "none";
  /** 工具面形态。 */
  tools?: ToolsMode;
  /** `provide` 形态。 */
  provide?: ProvideMode;
  /** `get` 形态（`throws` = 宿主服务读取抛错，用于锁 `apply` 的启动失败分支）。 */
  get?: GetMode;
  /** 是否给宿主 `logger`（缺省给；`false` 时日志丢弃）。 */
  logger?: boolean;
}

/** 装配结果：注册面、服务面、假件与调用入口。 */
export interface Assembly {
  /** 临时工作区根（用例可在此断言落盘路径）。 */
  readonly dir: string;
  readonly provided: Map<string, unknown>;
  readonly tools: MemoryQueryToolDef[];
  readonly subscriptions: Array<{
    event: string;
    listener: (...args: unknown[]) => unknown;
  }>;
  /** 宿主 `logger(...).info()` 收到的日志（按顺序）。 */
  readonly logs: string[];
  /** 本包暴露的 `memory` 服务（未 provide 时抛，附日志便于定位）。 */
  memory(): MemoryGlobalService;
  /** 本包当前的 bundle（`getMemoryBundle()` 的当前值）。 */
  bundle(): MemoryBundle | undefined;
  /** 按名取工具（没注册到则抛，附日志便于定位）。 */
  tool(name: string): MemoryQueryToolDef;
  /** 调工具 `execute`。 */
  call(
    name: string,
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  /** 调工具 `output.render` 取投影文本。 */
  render(name: string, value: unknown, args?: unknown): string;
  /** 关掉当前 bundle 并删掉临时工作区（幂等）。 */
  cleanup(): void;
}

/** 造临时工作区 + 假宿主，并调 `apply`。 */
export function assemble(options: AssemblyOptions = {}): Assembly {
  const dir = mkdtempSync(join(tmpdir(), "kb-it-"));
  const sessionPaths: SessionPathsLike = {
    sessionDirFor: (sessionId: string) => join(dir, "sessions", sessionId),
  };
  const config: KnowledgeConfig = {
    dshHome: join(dir, "dsh"),
    projectRoot: join(dir, "repo"),
    project: "it-proj",
    ...options.config,
  };

  const services: FakeServices = {
    ...(options.sessionPaths === "none"
      ? {}
      : {
          sessionPaths:
            options.sessionPaths === undefined
              ? sessionPaths
              : options.sessionPaths,
        }),
  };

  const tools: MemoryQueryToolDef[] = [];
  const subscriptions: Assembly["subscriptions"] = [];
  const provided = new Map<string, unknown>();
  const logs: string[] = [];

  const toolsFace =
    options.tools === "missing"
      ? undefined
      : {
          register(def: unknown): unknown {
            if (options.tools === "throws") {
              throw new Error("tools.register 抛错（测试注入）");
            }
            tools.push(def as MemoryQueryToolDef);
            return def;
          },
        };

  const host: BundleHost = {
    ...(options.logger === false
      ? {}
      : {
          logger: () => ({
            info: (message: string) => void logs.push(message),
          }),
        }),
    ...(options.provide === "missing"
      ? {}
      : {
          provide(nextName: string, value: unknown): unknown {
            if (options.provide === "throws") {
              throw new Error("provide 抛错（测试注入）");
            }
            provided.set(nextName, value);
            return value;
          },
        }),
    ...(options.get === "missing"
      ? {}
      : {
          get(name: string): unknown {
            if (options.get === "throws") {
              throw new Error("get 抛错（测试注入）");
            }
            return name === "sessionPaths"
              ? (services as Record<string, unknown>).sessionPaths
              : undefined;
          },
        }),
    on(event, listener) {
      const entry = {
        event,
        listener: listener as (...args: unknown[]) => unknown,
      };
      subscriptions.push(entry);
      return () => {
        const index = subscriptions.indexOf(entry);
        if (index === -1) return false;
        subscriptions.splice(index, 1);
        return true;
      };
    },
    ...(toolsFace === undefined ? {} : { tools: toolsFace }),
  };

  apply(host, config);

  const tool = (name: string): MemoryQueryToolDef => {
    const found = tools.find((item) => item.name === name);
    if (found === undefined) {
      throw new Error(
        `未注册工具 ${name}；日志：${logs.join(" | ") || "（无）"}`,
      );
    }
    return found;
  };

  let cleaned = false;
  return {
    dir,
    provided,
    tools,
    subscriptions,
    logs,
    memory() {
      const value = provided.get("memory");
      if (value === undefined) {
        throw new Error(
          `未 provide memory；日志：${logs.join(" | ") || "（无）"}`,
        );
      }
      return value as MemoryGlobalService;
    },
    bundle: () => getMemoryBundle(),
    tool,
    call(name, args, exec) {
      return tool(name).execute(args, exec);
    },
    render(name, value, args = {}) {
      const blocks = tool(name).output.render(args, value);
      return blocks.map((block) => block.text).join("\n");
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      getMemoryBundle()?.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
