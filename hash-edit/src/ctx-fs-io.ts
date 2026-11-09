/**
 * `ctx.fs` 实现（项目级追踪文档的 D2 / D3）：逐行仿照官方 `write` / `edit` 的五步。
 *
 * 1. 会话策略: `ctx.fs.sandboxMode` 有值（挂着围栏后端）时取 `ctx.sandboxPolicy.resolve({ session })`;
 * 2. 解析: `ctx.fs.resolve(path, { cwd, signal })`, `cwd` 由 `ctx.workingDirectory.ensure(agent, signal)` 给;
 * 3. 意图: `ctx.waterfall("fs/write-intent", target, exec, () => 自身意图)`;
 * 4. 写入: `ctx.fs.writeText(target, text, intent, signal, sandboxPolicy)`;
 * 5. 观察: 写后 `ctx.emit("fs/observed", target, { kind: "present", version }, exec)`, 读后同理。
 *
 * 与官方片段的两处有意差异（都写进包级追踪文档的「实现记录」）：
 * - 意图瀑布的兜底返回**本包自己的** `replaceIfVersion`（官方 `write` 自身没有版本基准,
 *   兜底才是 `() => undefined`）。`dsh-base` 缺省关闭观测策略, 兜底成 `undefined` 会让版本守卫静默消失;
 * - 读后补一条 `fs/observed` 观察记录: 观测策略打开时, 先读后写才不会被判成 `FS_NOT_OBSERVED`。
 *
 * 行级锚点（`LINE:HASH`）与后端版本守卫互补: 锚点判定 staleness 的粒度是行, 后端只管整文件版本;
 * 两者都不满足时按锚点先拒, 拒绝发生在任何写操作之前。
 *
 * 服务缺失（宿主没挂 `ctx.fs`）时**不回落** node 标准库, 直接返回可行动错误（跨包统一口径）。
 *
 * 错误：后端抛的 `FsError` 在这里按码映射成本包 `HashFileError`（文案在 `hash-edit/src/io.ts` 的
 * `hashFileErrorText`）。`FS_STALE_VERSION` 对应「文件在读取后被修改, 请重新 hash_read」;
 * `FS_SANDBOX_DENIED` 原样透出（自带 `[sandbox: …]` 标记与升档指引）。
 */

import {
  HashFileError,
  isHashFileErrorCode,
  throwIfAborted,
  type HashDirEntry,
  type HashFileInfo,
  type HashFileIo,
  type HashFileTarget,
  type HashResolveOptions,
  type HashWriteIntent,
  type HashWriteOutcome,
} from "./io.ts";

/** 工具执行上下文（宿主 `exec`，只读鸭子类型; 与 index.ts 的 `ToolExecLike` 同形）。 */
export interface HashExecLike {
  readonly callId?: string;
  readonly signal?: AbortSignal;
  /** 调用方 agent：`workingDirectory.ensure` 的入参与沙箱会话的键。 */
  readonly agent?: unknown;
}

/** 宿主 `ctx.fs` 里本包用到的成员（结构面; 本包不 import 宿主包）。 */
export interface HashFsServiceLike {
  /** 后端缺省围栏模式; `undefined` = 该后端不围栏。 */
  readonly sandboxMode?: string;
  resolve(path: string, opts?: HashResolveOptions): Promise<HashFileTarget>;
  stat(
    target: HashFileTarget,
    signal?: AbortSignal,
  ): Promise<HashFileInfo | undefined>;
  readText(target: HashFileTarget, signal?: AbortSignal): Promise<string>;
  writeText(
    target: HashFileTarget,
    text: string,
    intent?: HashWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<HashWriteOutcome>;
  listDir(
    target: HashFileTarget,
    signal?: AbortSignal,
  ): Promise<HashDirEntry[]>;
}

/** 宿主 `ctx.workingDirectory` 里本包用到的成员。 */
export interface HashWorkingDirectoryLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
}

/** 宿主 `ctx.sandboxPolicy` 里本包用到的成员（返回的策略本包不解读, 原样回传）。 */
export interface HashSandboxPolicyServiceLike {
  resolve(opts?: { session?: unknown }): unknown;
}

/** 观察记录（宿主 `FsObservation` 的同形子集）。 */
export type HashObservation =
  | { readonly kind: "present"; readonly version: string }
  | { readonly kind: "absent" };

/** 本包消费的宿主面：文件系统是必需项, 其余可选（缺了就按跨包口径降级）。 */
export interface HashFsHostLike {
  readonly fs?: HashFsServiceLike | undefined;
  readonly workingDirectory?: HashWorkingDirectoryLike | undefined;
  readonly sandboxPolicy?: HashSandboxPolicyServiceLike | undefined;
  /** 单槽决策瀑布（宿主 `ctx.waterfall`）。 */
  waterfall?(
    event: "fs/write-intent",
    target: HashFileTarget,
    actor: unknown,
    next: () =>
      HashWriteIntent | undefined | Promise<HashWriteIntent | undefined>,
  ): Promise<HashWriteIntent | undefined>;
  /** 单槽 / 广播事件（宿主 `ctx.emit`）。 */
  emit?(
    event: "fs/observed",
    target: HashFileTarget,
    observation: HashObservation,
    actor: unknown,
  ): void;
}

/** 取调用方会话（宿主 `exec.agent.session`）。 */
function sessionOf(exec: HashExecLike | undefined): unknown {
  const agent = exec?.agent;
  if (typeof agent !== "object" || agent === null) return undefined;
  return (agent as { session?: unknown }).session;
}

/**
 * 受保护地读宿主可选服务（`workingDirectory` / `sandboxPolicy`）:
 * cordis 的 ctx 代理对未 inject 的属性直读会抛 `cannot get property "X" without inject`,
 * `ctx.get(name)` 是官方的不经 inject 校验的读取口（服务未提供时返回 undefined）;
 * 库面 / 单测的普通对象宿主没有 `get`, 退回直接属性读。
 */
function optionalService<T>(host: HashFsHostLike, name: string): T | undefined {
  const getter = (host as { get?(name: string): unknown }).get;
  if (typeof getter === "function") {
    try {
      const service = getter.call(host, name);
      if (service !== undefined) return service as T;
    } catch {
      // `ctx.get` 不可用（非宿主对象）时退回属性读。
    }
  }
  try {
    return (host as unknown as Record<string, unknown>)[name] as T | undefined;
  } catch {
    return undefined;
  }
}

/** 错误转一行详情。 */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 后端抛出的错误转成本包错误: 已经是本包错误就原样抛, 带官方 `code` 的按码映射,
 * 其余一律 `FS_IO_ERROR`（原始 message 留在括号里）。
 */
function mapError(error: unknown): HashFileError {
  if (error instanceof HashFileError) return error;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (isHashFileErrorCode(code)) {
      return new HashFileError(code, error.message, error);
    }
  }
  return new HashFileError("FS_IO_ERROR", detailOf(error), error);
}

/** 服务缺失时的替身: 每个方法都给出同一条可行动说明, 绝不退回 node 标准库。 */
function unavailableHashFileIo(): HashFileIo {
  const reason =
    "ctx.fs 不可用（宿主未提供文件系统服务）：hash_read / hash_edit 只在官方文件围栏内读写, 不退回 node 标准库; 请确认 profile 挂载了 fs 后端";
  const reject = async (): Promise<never> => {
    throw new HashFileError("FS_UNAVAILABLE", reason);
  };
  return {
    resolve: reject,
    stat: reject,
    readText: reject,
    writeText: reject,
    listDir: reject,
  };
}

/**
 * 本次调用的相对路径基准（官方 `sessionResolveOptions` 的同口径）:
 * 有 agent 与 `workingDirectory` 时取会话目录; 两者缺一即交给后端缺省, **不回落进程的工作目录**。
 * @param host 宿主面（`workingDirectory` 可选）。
 * @param exec 本次调用的执行上下文。
 */
export async function resolveExecCwd(
  host: HashFsHostLike,
  exec: HashExecLike | undefined,
): Promise<string | undefined> {
  const agent = exec?.agent;
  const workingDirectory = optionalService<HashWorkingDirectoryLike>(
    host,
    "workingDirectory",
  );
  if (agent === undefined || workingDirectory === undefined) {
    return undefined;
  }
  return workingDirectory.ensure(agent, exec?.signal);
}

/**
 * 按一次工具调用的上下文构造 `ctx.fs` 实现。
 * @param host 宿主面（`fs` 缺失时返回替身 io）。
 * @param exec 本次调用的执行上下文: `agent` 决定相对路径基准与沙箱会话, `signal` 贯穿所有调用。
 */
export function ctxHashFileIo(
  host: HashFsHostLike,
  exec: HashExecLike | undefined,
): HashFileIo {
  const service = host.fs;
  if (service === undefined) return unavailableHashFileIo();
  const execSignal = exec?.signal;
  const session = sessionOf(exec);
  const signalOf = (call?: AbortSignal): AbortSignal | undefined =>
    call ?? execSignal;
  /** 相对路径基准: 显式 `cwd` 优先, 其次会话目录, 再次交给后端缺省。 */
  const resolveOptions = async (
    call: AbortSignal | undefined,
    cwd: string | undefined,
  ): Promise<HashResolveOptions> => {
    const signal = signalOf(call);
    const base = cwd ?? (await resolveExecCwd(host, exec));
    if (base === undefined) return signal === undefined ? {} : { signal };
    return signal === undefined ? { cwd: base } : { cwd: base, signal };
  };
  /** 本次调用的围栏策略; 后端不围栏（`sandboxMode` 缺省）时交给后端自己判。 */
  const sandboxPolicy = (): unknown => {
    if (service.sandboxMode === undefined) return undefined;
    return optionalService<HashSandboxPolicyServiceLike>(
      host,
      "sandboxPolicy",
    )?.resolve(session === undefined ? {} : { session });
  };
  const observe = (
    target: HashFileTarget,
    observation: HashObservation,
  ): void => {
    host.emit?.("fs/observed", target, observation, exec);
  };
  return {
    async resolve(path, opts) {
      throwIfAborted(signalOf(opts?.signal));
      const options = await resolveOptions(opts?.signal, opts?.cwd);
      try {
        return await service.resolve(path, options);
      } catch (error) {
        throw mapError(error);
      }
    },
    async stat(target, call) {
      const signal = signalOf(call);
      throwIfAborted(signal);
      let info: HashFileInfo | undefined;
      try {
        info = await service.stat(target, signal);
      } catch (error) {
        throw mapError(error);
      }
      observe(
        target,
        info === undefined
          ? { kind: "absent" }
          : { kind: "present", version: info.version },
      );
      return info;
    },
    async readText(target, call) {
      const signal = signalOf(call);
      throwIfAborted(signal);
      try {
        return await service.readText(target, signal);
      } catch (error) {
        throw mapError(error);
      }
    },
    async writeText(target, text, intent, call) {
      const signal = signalOf(call);
      throwIfAborted(signal);
      const policy = sandboxPolicy();
      // 意图瀑布: 有监听者时由它决定（版本守卫 / 观察策略 / 审批）; 无监听者时用本包自己的基准。
      const own = intent;
      let effective: HashWriteIntent | undefined = own;
      if (host.waterfall !== undefined) {
        try {
          effective =
            (await host.waterfall(
              "fs/write-intent",
              target,
              exec,
              () => own,
            )) ?? own;
        } catch (error) {
          throw mapError(error);
        }
      }
      let outcome: HashWriteOutcome;
      try {
        outcome = await service.writeText(
          target,
          text,
          effective,
          signal,
          policy,
        );
      } catch (error) {
        throw mapError(error);
      }
      observe(target, { kind: "present", version: outcome.version });
      return { version: outcome.version };
    },
    async listDir(target, call) {
      const signal = signalOf(call);
      throwIfAborted(signal);
      try {
        return await service.listDir(target, signal);
      } catch (error) {
        throw mapError(error);
      }
    },
  };
}
