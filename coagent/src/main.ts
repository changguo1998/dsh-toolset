/**
 * src/main.ts — 插件入口（DSH bundle 接入面）：注册模型侧工具 `coagent`。
 *
 * 契约对齐 `docs/host/DSH-CTX-API.md` §0（`export { name, inject, Config, apply }`）：
 * - `inject = ["tools"]`：注册面是必需依赖（宿主 base 在 agent 创建前就 provide `tools`）；
 * - `herdrUse` / `sessionChannel`：**注册期**硬前置，缺席不注册工具并告警一次（不降级到库面）；
 * - `sessionPaths`：可选，缺席时记录降级到 `$DSH_HOME/coagent/<会话 id>/` 并告警一次。
 *
 * 状态落点：`<调用方会话目录>/coagent/`（经 `sessionPaths.sessionDirFor` 推导）；父进程正常
 * 退出时把非 `closed` 记录标 `closed(reason=parent-exit)`（终端的关闭由 herdr-use 的退出清理
 * 负责，本包只写记录）。
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { CoagentActions } from "./actions.ts";
import { FileCoagentStore } from "./store.ts";
import { toToolDef } from "./tools.ts";
import {
  isHerdrUseFace,
  isSessionChannelFace,
  isSessionPathsFace,
  systemClock,
} from "./types.ts";
import type {
  Clock,
  CoagentConfig,
  HerdrUseFace,
  ResolvedConfig,
  SessionChannelFace,
  SessionPathsFace,
} from "./types.ts";

/** bundle 条目 id（与 cordis.patch.yml / profile 层一致）。 */
export const name = "coagent";

/** 静态依赖：只有注册面 `tools`（其余服务走 `ctx.get` 可选读取）。 */
export const inject = ["tools"];

/** 插件配置。 */
export type Config = CoagentConfig;

/** 宿主 logger（cordis 的 namespace logger 子集）。 */
export interface CoagentLogger {
  info(message: string): void;
  warn?(message: string): void;
}

/** 结构化宿主 ctx（最小 DSH cordis 形态；服务面 / 测试宿主没有 `tools`）。 */
export interface CoagentHost {
  logger?(ns: string): CoagentLogger;
  get?(key: string): unknown;
  tools?: { register(def: unknown): unknown };
  [key: string]: unknown;
}

const DEFAULT_MAX_LIVE = 4;
const DEFAULT_MAX_RECORDS = 50;
const DEFAULT_CLAIM_TIMEOUT_SEC = 180;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_GRACE_SEC = 15;
const DEFAULT_GRACE_POLL_MS = 250;
const DEFAULT_STALE_AFTER_SEC = 21_600;

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** 配置归一化（数值 clamp 成正整数；`enabled` 缺省 true）。 */
export function resolveConfig(config: CoagentConfig = {}): ResolvedConfig {
  return {
    enabled: config.enabled !== false,
    maxLive: positiveInt(config.maxLive, DEFAULT_MAX_LIVE),
    maxRecords: positiveInt(config.maxRecords, DEFAULT_MAX_RECORDS),
    claimTimeoutSec: positiveInt(
      config.claimTimeoutSec,
      DEFAULT_CLAIM_TIMEOUT_SEC,
    ),
    pollIntervalMs: positiveInt(
      config.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    graceSec: positiveInt(config.graceSec, DEFAULT_GRACE_SEC),
    gracePollMs: positiveInt(config.gracePollMs, DEFAULT_GRACE_POLL_MS),
    staleAfterSec: positiveInt(config.staleAfterSec, DEFAULT_STALE_AFTER_SEC),
  };
}

/**
 * 读服务面（`ctx.get` 优先，退化到直接属性；任何读取失败都按「服务缺失」处理）。
 *
 * cordis 对未 inject 的服务做属性读取会直接抛错，故回退路径必须自吞异常 —— 没挂
 * herdr-use / session-channel 的进程不应因读服务而整包加载失败。
 */
function readService(ctx: CoagentHost, key: string): unknown {
  try {
    if (typeof ctx.get === "function") {
      const value = ctx.get(key);
      if (value !== undefined && value !== null) return value;
    }
  } catch {
    /* ctx.get 不可用：继续走属性读取 */
  }
  try {
    return ctx[key];
  } catch {
    /* 未声明的服务（cordis 抛错）→ 按缺失处理 */
    return undefined;
  }
}

/** 告警一次（logger 缺失时静默；不因日志失败阻断注册）。 */
function warn(ctx: CoagentHost, message: string): void {
  try {
    const logger = ctx.logger?.("coagent");
    if (logger === undefined) return;
    if (typeof logger.warn === "function") {
      logger.warn(message);
      return;
    }
    logger.info(message);
  } catch {
    /* 日志通道异常不影响主流程 */
  }
}

/** 记录根目录：优先 `sessionPaths.sessionDirFor`，缺席时降级到 `$DSH_HOME/coagent/<会话>`。 */
export function coagentRootOf(
  paths: SessionPathsFace | undefined,
  sessionId: string,
  dshHome: string = process.env["DSH_HOME"] ?? join(homedir(), ".dsh"),
): string {
  if (paths === undefined) {
    return join(dshHome, "coagent", sessionId);
  }
  return join(paths.sessionDirFor(sessionId), "coagent");
}

/** 已登记到退出钩子的 store（apply 路径与测试共用；进程内按 root 去重）。 */
const stores = new Set<FileCoagentStore>();
let hookInstalled = false;

/** 登记 store（退出钩子要在退出前写最后一遍）。 */
export function registerStore(store: FileCoagentStore): void {
  for (const existing of stores) {
    if (existing.root === store.root) return;
  }
  stores.add(store);
}

/** 安装退出钩子（幂等；`kill -9` 不跑，残留由下次 `list` 判 `lost`）。 */
export function installExitHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  process.once("exit", () => {
    markParentExitSync();
  });
}

/**
 * 父进程正常退出：把非终态记录标 `closed(reason=parent-exit)` 并同步写盘。
 *
 * 只写记录：终端由 herdr-use 的退出清理按同一份登记表关闭；`kill -9` 时本钩子不跑，
 * 记录留在原态，由下次 `list(probe=live)` 判 `lost`。
 */
export function markParentExitSync(): void {
  const now = Date.now();
  for (const store of stores) {
    try {
      const index = store.readSync();
      let changed = false;
      for (const record of Object.values(index.records)) {
        if (record.state === "closed" || record.pruned === true) continue;
        record.state = "closed";
        record.closed_at = now;
        record.updated_at = now;
        record.close_reason = "parent-exit";
        changed = true;
      }
      if (changed) {
        store.saveSync(index);
        for (const record of Object.values(index.records)) {
          if (record.close_reason !== "parent-exit") continue;
          try {
            store.writeArtifactsSync(record.coagent_id, { meta: record });
          } catch {
            /* 记录目录写不动不阻塞退出 */
          }
        }
      }
    } catch {
      /* 退出路径上不再抛：尽力而为 */
    }
  }
}

/** 动作层构造参数（测试注入 fake 服务与假时钟）。 */
export interface ActionsOptions {
  herdr: HerdrUseFace;
  channel: SessionChannelFace;
  paths?: SessionPathsFace;
  config?: CoagentConfig;
  clock?: Clock;
  profile?: string;
  dshHome?: string;
  warn?: (message: string) => void;
}

/** 构造动作层（唯一构造路径：apply 与测试共用）。 */
export function createCoagentActions(options: ActionsOptions): CoagentActions {
  const resolved = resolveConfig(options.config);
  const dshHome =
    options.dshHome ?? process.env["DSH_HOME"] ?? join(homedir(), ".dsh");
  return new CoagentActions({
    herdr: options.herdr,
    channel: options.channel,
    config: resolved,
    clock: options.clock ?? systemClock,
    profile: options.profile ?? process.env["DSH_PROFILE"] ?? "",
    openStore: (sessionId) => {
      const store = new FileCoagentStore(
        coagentRootOf(options.paths, sessionId, dshHome),
        { maxRecords: resolved.maxRecords },
      );
      registerStore(store);
      return store;
    },
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  });
}

/**
 * 插件入口：服务面可用性判定 + 注册工具。
 *
 * 缺 `herdrUse` 或 `sessionChannel` 时**不注册**工具（F1），并告警一次 —— 与 herdr-use 缺
 * herdr 时同姿态；不降级到 herdr-use 库面，也不自己起进程。
 */
export function apply(ctx: CoagentHost, config: CoagentConfig = {}): void {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return;

  const herdr = readService(ctx, "herdrUse");
  const channel = readService(ctx, "sessionChannel");
  const paths = readService(ctx, "sessionPaths");

  if (!isHerdrUseFace(herdr)) {
    warn(
      ctx,
      "coagent: 缺 herdrUse 共用服务面（需要 herdr-use 的十工具版本），工具未注册",
    );
    return;
  }
  if (!isSessionChannelFace(channel)) {
    warn(ctx, "coagent: 缺 sessionChannel 服务（认领新会话必需），工具未注册");
    return;
  }
  const pathsFace = isSessionPathsFace(paths) ? paths : undefined;
  if (pathsFace === undefined) {
    warn(
      ctx,
      "coagent: 缺 sessionPaths 服务，记录降级到 $DSH_HOME/coagent/<会话 id>/",
    );
  }

  const actions = createCoagentActions({
    herdr,
    channel,
    ...(pathsFace === undefined ? {} : { paths: pathsFace }),
    config: resolved,
    warn: (message) => warn(ctx, message),
  });
  ctx.tools?.register(toToolDef(actions));
  installExitHook();
}
