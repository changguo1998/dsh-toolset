/**
 * 集成层装配器: 假服务面 (`ctx.get` / `ctx.provide`) + 假宿主 `sessions`, 拼出本插件
 * `apply` 的宿主接线。
 *
 * 两个假面的形状照 `src/index.ts` 的结构面声明抄 (结构化类型, 不 import 宿主实现):
 * - 服务提供面: `provide(name, value)` 记账, `ctx.get(name)` 按宿主注入返回已挂的服务,
 *   消费方走 `ctx.get("sessionPaths")` 与真实接线同一条路;
 * - 宿主会话面: `sessions.get(id)` 返回 `{ header: { cwd } }`, 只服务 `sessionDirFor`。
 *
 * 临时 HOME: 在 `os.tmpdir()` 下新建目录并把 `HOME` 指过去 (临时清掉 `DSH_HOME`), 于是
 * `root()` 缺省落在 `<临时 HOME>/.dsh/sessions`; 断言只读该临时目录, 不碰真实 `~/.dsh`。
 * `dispose()` 删临时目录并恢复两个环境变量。
 *
 * 本装配器不以 `.test.ts` 结尾, 不参与覆盖率统计 (只统计 `src`)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  apply,
  type SessionPaths,
  type SessionPathsConfig,
} from "../src/index.ts";

/** 假宿主会话: 只声明本包读取的 `header.cwd`。 */
export interface FakeSession {
  header?: { cwd?: string };
}

/** 装配选项。 */
export interface AssembleOptions {
  /** 宿主 `sessions` 面: 会话表 (缺省 `sessions` 服务缺席) / `"absent"`。 */
  sessions?: Record<string, FakeSession | undefined> | "absent";
  /** 服务提供面: 正常 `provide` (缺省) / `"absent"` (极简 ctx 无 provide) / `"throwing"`。 */
  provide?: "face" | "absent" | "throwing";
}

/** 装配体。 */
export interface Assembly {
  /** 宿主 ctx (含 `get` / `provide`, 需 `sessions` 时一并挂上)。 */
  readonly ctx: Record<string, unknown>;
  /** 临时 HOME (`dispose()` 删除)。 */
  readonly home: string;
  /** `ctx.provide` 记下的服务 (名 → 值)。 */
  readonly provided: ReadonlyMap<string, unknown>;
  /** 按消费方写法取服务 (`ctx.get("sessionPaths")`); 未挂上时抛错。 */
  service(): SessionPaths;
  /** 服务是否已注册 (探 `get` 的返回值)。 */
  hasService(): boolean;
  /** 删除临时目录并恢复 `HOME` / `DSH_HOME`。 */
  dispose(): void;
}

/** 拼装 `apply` 与宿主接线; 调用前已把 `HOME` 指到临时目录。 */
export function assemble(
  config?: SessionPathsConfig,
  options: AssembleOptions = {},
): Assembly {
  const home = mkdtempSync(join(tmpdir(), "session-paths-integration-"));
  const savedHome = process.env["HOME"];
  const savedDshHome = process.env["DSH_HOME"];
  process.env["HOME"] = home;
  delete process.env["DSH_HOME"];

  const provided = new Map<string, unknown>();
  const services: Record<string, unknown> = {};
  if (options.sessions !== undefined && options.sessions !== "absent") {
    const byId = options.sessions;
    services["sessions"] = {
      get: (sessionId: string): FakeSession | undefined => byId[sessionId],
    };
  }

  const ctx: Record<string, unknown> = {
    get: (serviceName: string): unknown => {
      const registered = provided.get(serviceName);
      if (registered !== undefined) return registered;
      return services[serviceName];
    },
  };
  if (options.provide !== "absent") {
    ctx["provide"] = (serviceName: string, value: unknown): void => {
      if (options.provide === "throwing") throw new Error("provide boom");
      provided.set(serviceName, value);
    };
  }

  apply(ctx, config);

  const restoreEnv = (): void => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedDshHome === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = savedDshHome;
  };

  return {
    ctx,
    home,
    provided,
    service(): SessionPaths {
      const service = provided.get("sessionPaths");
      if (service === undefined) throw new Error("sessionPaths 服务未注册");
      return service as SessionPaths;
    },
    hasService: () => provided.has("sessionPaths"),
    dispose(): void {
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
