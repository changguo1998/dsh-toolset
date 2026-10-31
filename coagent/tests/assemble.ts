/**
 * 集成层装配器（不以 `.test.ts` 结尾）：把「假工具面 / 假事件面 / 假服务面」拼成一个最小
 * 宿主 ctx，交给本包的 `apply(ctx, config)`。
 *
 * 三个假面的形状与阶段 2 规范 4.2 一致，换包时可复用同一套写法：
 * - 工具面：收集 `register(def)`，并把注册到的工具交给用例调用；
 * - 事件面：记录 `on(event, listener)`（本包不订阅事件，用例据此钉住边界）；
 * - 服务面：`get(key)` 一次返回全部假服务，`provide(name, value)` 记录本包提供的服务
 *   （本包不 provide，用例据此钉住边界）。
 *
 * 只依赖本包 `src/` 与 Node 标准库；落盘走调用方给的临时目录（`root`）。
 */

import { join } from "node:path";

import { apply } from "../src/index.ts";
import type { ToolDef } from "../src/tools.ts";
import type { CoagentConfig, SessionPathsFace } from "../src/types.ts";
import { FakeChannel } from "./fake-channel.ts";
import { FakeHerdr } from "./fake-herdr.ts";

/** 调用方会话 id（回执 / 记录目录都以它为键）。 */
export const PARENT = "sess-parent";

/** 假工具面：注册即收集。 */
export function fakeToolsFace() {
  const registered: ToolDef[] = [];
  return {
    registered,
    register(def: unknown) {
      registered.push(def as ToolDef);
      return def;
    },
  };
}

/** 假事件面：只记录订阅（本包应当一次都不订阅）。 */
export function fakeEventsFace() {
  const subscriptions: Array<{ event: string; listener: unknown }> = [];
  return {
    subscriptions,
    on(event: string, listener: unknown) {
      subscriptions.push({ event, listener });
      return () => {};
    },
    emit() {},
  };
}

/** 假 sessionPaths：`sessionDirFor` 是唯一必需方法，可注入抛错。 */
export function fakeSessionPaths(root: string) {
  const state = { fail: false };
  const service: SessionPathsFace = {
    sessionDirFor(sessionId: string) {
      if (state.fail) {
        throw new Error(`会话「${sessionId}」不在宿主的 sessions 里`);
      }
      return join(root, `session-${sessionId}`);
    },
  };
  return { service, state };
}

/** 假 provide 面（本包不 provide 服务；保留形状供断言「没有登记」）。 */
export function fakeProvideFace() {
  const provided = new Map<string, unknown>();
  return {
    provided,
    provide(serviceName: string, value: unknown) {
      provided.set(serviceName, value);
    },
  };
}

/** 装配参数。 */
export interface AssemblyOptions {
  /** 临时根目录（`sessionPaths.sessionDirFor` 的落点，也是缺省 cwd）。 */
  root: string;
  /** 调用方会话 cwd（缺省 `root`；用例要传绝对路径时自建）。 */
  cwd?: string;
  /** 是否挂某个假服务（缺省全挂）。 */
  with?: {
    herdr?: boolean;
    channel?: boolean;
    paths?: boolean;
  };
  /** `herdrUse` 的形状：`full` 六方法齐全；`incomplete` 缺 `close`。 */
  herdrShape?: "full" | "incomplete";
  /** 宿主是否提供 `tools` 面（缺省提供）。 */
  tools?: boolean;
  /** `ctx.get` 的行为：`throws` 时只靠属性读取（cordis 缺声明服务的真实形态）。 */
  get?: "ok" | "throws";
  /** 宿主 logger 的形状：`info-only` 没有 `warn`，`none` 完全没有 logger，`throws` 读取即抛。 */
  logger?: "full" | "info-only" | "none" | "throws";
  config?: CoagentConfig;
}

/** 装配结果：注册面、订阅面、日志与调用入口。 */
export interface Assembly {
  /** 注册到的工具名（按注册顺序）。 */
  tools: string[];
  registered: ToolDef[];
  subscriptions: Array<{ event: string; listener: unknown }>;
  provided: Map<string, unknown>;
  logs: string[];
  herdr: FakeHerdr;
  channel: FakeChannel;
  paths: ReturnType<typeof fakeSessionPaths>;
  /** 当前注册到的 `coagent` 工具（没注册到则抛）。 */
  tool(): ToolDef;
  /** 以某个会话身份执行 `coagent`（缺省调用方会话）。 */
  call(
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  /** 某条记录的目录（sessionPaths 形态）。 */
  recordDir(coagentId: string): string;
  /** 会话目录（记录目录的上一级）。 */
  sessionDir(sessionId?: string): string;
}

/** 拼假宿主并调 `apply`。 */
export function assemble(options: AssemblyOptions): Assembly {
  const withFaces = {
    herdr: options.with?.herdr ?? true,
    channel: options.with?.channel ?? true,
    paths: options.with?.paths ?? true,
  };
  const cwd = options.cwd ?? options.root;
  const herdr = new FakeHerdr();
  const channel = new FakeChannel();
  const paths = fakeSessionPaths(options.root);
  const herdrFace: unknown =
    options.herdrShape === "incomplete"
      ? {
          create: herdr.create.bind(herdr),
          run: herdr.run.bind(herdr),
          read: herdr.read.bind(herdr),
          info: herdr.info.bind(herdr),
          list: herdr.list.bind(herdr),
        }
      : herdr;

  const services: Record<string, unknown> = {
    ...(withFaces.herdr ? { herdrUse: herdrFace } : {}),
    ...(withFaces.channel ? { sessionChannel: channel } : {}),
    ...(withFaces.paths ? { sessionPaths: paths.service } : {}),
  };

  const toolsFace = fakeToolsFace();
  const events = fakeEventsFace();
  const provideFace = fakeProvideFace();
  const logs: string[] = [];
  const loggerValue = (): unknown => {
    switch (options.logger) {
      case "none":
        return undefined;
      case "info-only":
        return { info: (message: string) => void logs.push(message) };
      case "throws":
        return undefined;
      default:
        return {
          info: (message: string) => void logs.push(message),
          warn: (message: string) => void logs.push(message),
        };
    }
  };
  const ctx: Record<string, unknown> = {
    logger:
      options.logger === "throws"
        ? () => {
            throw new Error("logger 不可用（测试注入）");
          }
        : () => loggerValue(),
    get:
      options.get === "throws"
        ? () => {
            throw new Error("未声明的服务（cordis 会抛）");
          }
        : (key: string) => services[key],
    events,
    provide: provideFace.provide,
    // 属性读取的退化路径：服务同时挂在 ctx 上。
    ...services,
    ...(options.tools === false ? {} : { tools: toolsFace }),
  };

  apply(ctx, options.config ?? {});

  const tool = (): ToolDef => {
    const found = toolsFace.registered.find((item) => item.name === "coagent");
    if (found === undefined) {
      throw new Error(`未注册 coagent 工具；日志：${logs.join(" | ")}`);
    }
    return found;
  };

  return {
    tools: toolsFace.registered.map((item) => item.name),
    registered: toolsFace.registered,
    subscriptions: events.subscriptions,
    provided: provideFace.provided,
    logs,
    herdr,
    channel,
    paths,
    tool,
    async call(args, sessionId = PARENT) {
      return tool().execute(args, {
        agent: { session: { id: sessionId, cwd } },
      });
    },
    recordDir(coagentId: string): string {
      return join(options.root, `session-${PARENT}`, "coagent", coagentId);
    },
    sessionDir(sessionId: string = PARENT): string {
      return join(options.root, `session-${sessionId}`);
    },
  };
}
