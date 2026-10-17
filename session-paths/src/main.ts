/**
 * session-paths 插件入口（DSH bundle 接入面）。
 *
 * 角色：把「宿主把会话目录放在哪」收敛成仓内唯一事实源 —— `src/encode.ts` 复刻宿主的
 * `encodeSegment` / `projectKey` / `projectDir` / `sessionDir`，本文件把它包成服务
 * `sessionPaths`（`provide: ["sessionPaths"]`），供 memory-base 的 S 库、output-compress 的
 * `digest.db`、auto-approve 的会话审计、agent-group 的状态文件等消费方共用。
 *
 * 服务面（`ctx.get("sessionPaths")`）：
 * - 四个纯函数 `root()` / `projectKey(cwd)` / `projectDir(cwd)` / `sessionDir(cwd, sessionId)`：
 *   只算路径、不落盘，目录不存在也不报错；
 * - `sessionDirFor(sessionId)`：手里只有会话 id 的调用用它 —— 内部经宿主 `sessions` 取
 *   `header.cwd`（缺失按宿主的 `_no-cwd` 桶），再委托 `sessionDir`；`sessions` 不可用或会话
 *   取不到即抛明示例外。同步、不建目录（宿主建会话时就建好了会话目录）；
 * - `ensureSessionDir(cwd, sessionId)`：唯一写盘入口（`mkdir -p` + 0700，幂等）。
 *
 * 宿主依赖姿态：**不写进 `inject`**。`sessions` 只在 `sessionDirFor` 里可选读取 —— 宿主缺该
 * 服务时本包照常加载，纯函数与 `ensureSessionDir` 的消费方不受影响。宿主 `cwd` 本就可缺
 * （`SessionHeader.cwd?: string`，见 `docs/host/DSH-CTX-API.md` §1），故 `cwd` 入参允许
 * `undefined`。目录存在性与可写性由宿主 / 消费方负责，本包只算路径（`ensureSessionDir`
 * 除外）。
 */

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  encodeSegment,
  projectDir as encodeProjectDir,
  projectKey as encodeProjectKey,
  sessionDir as encodeSessionDir,
} from "./encode.ts";

// 纯函数同时对外透出：消费方要走纯函数面（手里同时有 cwd 与 sessionId）时不必自己拼路径。
export { encodeSegment, projectDir, projectKey, sessionDir } from "./encode.ts";

/** bundle 条目 id（与 cordis.patch.yml / profile 层一致）。 */
export const name = "session-paths";

/** 服务面挂载声明：其他插件经 `ctx.get("sessionPaths")` 取用。 */
export const provide = ["sessionPaths"];

/** 插件配置（profile 的 cordis.patch.yml 在本条目下 config 键；缺省值见 `resolveRoot`）。 */
export interface SessionPathsConfig {
  /** sessions 根；缺省读环境变量 `DSH_HOME` → `<DSH_HOME>/sessions`，无该变量回落 `~/.dsh/sessions`。 */
  root?: string;
}

/** 与既有包命名习惯对齐（`Config` = 宿主透传的配置对象）。 */
export type Config = SessionPathsConfig;

/** 服务面（`ctx.get("sessionPaths")`）；边界语义见文件头。 */
export interface SessionPaths {
  /** 已 resolve 的绝对路径。 */
  root(): string;
  /** 宿主 `projectKey` 的忠实复刻（`--…--` 外壳 / `~XXXX` 转义 / 251 截断）。 */
  projectKey(cwd: string): string;
  /** `cwd` 缺失 → `<root>/_no-cwd`。 */
  projectDir(cwd: string | undefined): string;
  /** `<projectDir>/<encodeSegment(sessionId)>`。 */
  sessionDir(cwd: string | undefined, sessionId: string): string;
  /** 按会话 id 直接给目录：内部经宿主 `sessions` 取 `header.cwd`，再走 `sessionDir`。 */
  sessionDirFor(sessionId: string): string;
  /** 唯一写盘入口：`mkdir -p`（0700）、幂等，返回目录路径。 */
  ensureSessionDir(cwd: string | undefined, sessionId: string): Promise<string>;
}

/** 宿主 `sessions` 服务的最小结构面（`SessionStore.get` + `Session.header.cwd`）。 */
interface SessionStoreLike {
  get(sessionId: string): { header?: { cwd?: string } } | undefined;
}

/**
 * 归一 sessions 根：显式配置优先；否则 `DSH_HOME/sessions`；再否则 `~/.dsh/sessions`。
 * 返回值一律是绝对路径（宿主 `dshHomePath('sessions')` 的同义实现，宿主面没有插件可用的
 * `dshHomePath`，故自己按 `DSH_HOME` 约定推）。
 */
export function resolveRoot(root?: string): string {
  if (typeof root === "string" && root.length > 0) return resolve(root);
  const home = process.env["DSH_HOME"];
  if (typeof home === "string" && home.length > 0) {
    return resolve(join(home, "sessions"));
  }
  return resolve(join(homedir(), ".dsh", "sessions"));
}

/**
 * 可选读取宿主服务（与 session-channel 的 `readService` 同套路）：`get` 本身的读取也要保护
 * —— 代理宿主上任何未 inject 的属性读都可能抛。
 */
function readService<T>(ctx: unknown, serviceName: string): T | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  const c = ctx as Record<string, unknown>;
  let getter: ((key: string) => unknown) | undefined;
  try {
    const g = c["get"];
    if (typeof g === "function") getter = g as (key: string) => unknown;
  } catch {
    getter = undefined;
  }
  if (getter !== undefined) {
    try {
      const service = getter.call(c, serviceName);
      if (service !== undefined && service !== null) return service as T;
    } catch {
      /* 严格模式读取异常 → 尝试直接属性读 */
    }
  }
  try {
    const direct = c[serviceName];
    if (direct !== undefined && direct !== null) return direct as T;
  } catch {
    /* 忽略：不可读即视为缺失 */
  }
  return undefined;
}

/** 服务实现：把 sessions 根绑进纯函数，并补 `sessionDirFor` 与 `ensureSessionDir`。 */
export class SessionPathsService implements SessionPaths {
  readonly #root: string;
  readonly #ctx: unknown;

  constructor(root?: string, ctx?: unknown) {
    this.#root = resolveRoot(root);
    this.#ctx = ctx;
  }

  root(): string {
    return this.#root;
  }

  projectKey(cwd: string): string {
    return encodeProjectKey(cwd);
  }

  projectDir(cwd: string | undefined): string {
    return encodeProjectDir(this.#root, cwd);
  }

  sessionDir(cwd: string | undefined, sessionId: string): string {
    return encodeSessionDir(this.#root, cwd, sessionId);
  }

  sessionDirFor(sessionId: string): string {
    if (sessionId.length === 0) {
      throw new Error("cannot encode an empty path segment");
    }
    const sessions = readService<SessionStoreLike>(this.#ctx, "sessions");
    if (sessions === undefined || typeof sessions.get !== "function") {
      throw new Error(
        "sessionPaths.sessionDirFor: 宿主 sessions 服务不可用，无法解析会话 cwd（本包对 sessions 只做可选读取；纯函数与 ensureSessionDir 不受影响）",
      );
    }
    const session = sessions.get(sessionId);
    if (session === undefined || session === null) {
      throw new Error(
        `sessionPaths.sessionDirFor: 会话「${sessionId}」不在宿主的 sessions 里，无法解析其 cwd`,
      );
    }
    const cwd = session.header?.cwd;
    return this.sessionDir(
      typeof cwd === "string" ? cwd : undefined,
      sessionId,
    );
  }

  async ensureSessionDir(
    cwd: string | undefined,
    sessionId: string,
  ): Promise<string> {
    const dir = this.sessionDir(cwd, sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // 已存在的目录（如宿主建好的会话目录）保持同一权限口径；chmod 幂等。
    await chmod(dir, 0o700);
    return dir;
  }
}

/** 挂载：把服务面挂到 ctx（cordis `provide`）；极简 ctx 无 `provide` 时退回直接属性挂载。 */
export function apply(ctx: unknown, config?: SessionPathsConfig): void {
  const service = new SessionPathsService(config?.root, ctx);
  const c = (ctx ?? {}) as { provide?: unknown };
  let provideFn: ((serviceName: string, value: unknown) => unknown) | undefined;
  try {
    const p = c.provide;
    if (typeof p === "function") {
      provideFn = p as (serviceName: string, value: unknown) => unknown;
    }
  } catch {
    provideFn = undefined;
  }
  if (provideFn !== undefined) {
    provideFn.call(ctx, "sessionPaths", service);
    return;
  }
  if (ctx === null || typeof ctx !== "object") {
    process.stderr.write(
      "[session-paths] warn: ctx 无 provide，服务面 sessionPaths 未注册\n",
    );
    return;
  }
  try {
    (ctx as Record<string, unknown>)["sessionPaths"] = service;
  } catch (error) {
    process.stderr.write(
      `[session-paths] warn: 服务面 sessionPaths 注册失败：${String(error)}\n`,
    );
  }
}
