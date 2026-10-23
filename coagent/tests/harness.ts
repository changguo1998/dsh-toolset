/**
 * tests/harness.ts — 组装 fake 服务面 + 假时钟 + 临时目录，给各用例一个 `coagent` 工具。
 *
 * 只用测试目录，不碰真实 session-channel / herdr / $DSH_HOME；每个用例结束删目录。
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoagentActions } from "../src/main.ts";
import { toToolDef, type ToolDef } from "../src/tools.ts";
import type {
  CoagentConfig,
  CoagentIndex,
  SessionPathsFace,
} from "../src/types.ts";
import { FakeChannel } from "./fake-channel.ts";
import { ManualClock } from "./fake-clock.ts";
import { FakeHerdr } from "./fake-herdr.ts";

/** 调用方会话 id（回执 / 记录目录都以它为键）。 */
export const PARENT = "sess-parent";

/** 父会话的 profile（认领匹配用）。 */
export const PROFILE = "fff";

export interface Harness {
  /** 测试根目录（sessionPaths 的 root，也是临时目录）。 */
  dir: string;
  /** 父会话 cwd（存在且是目录）。 */
  parentCwd: string;
  herdr: FakeHerdr;
  channel: FakeChannel;
  clock: ManualClock;
  tool: ToolDef;
  exec: { agent: { session: { id: string; cwd: string } } };
  /** 某条记录的目录。 */
  recordDir(coagentId: string): string;
  /** 会话目录（记录目录的上一级）。 */
  sessionDir(sessionId?: string): string;
  spawn(args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  cleanup(): Promise<void>;
}

/** 读记录目录里的文件（断言 meta / claim.log / screen.log 用）。 */
export async function readArtifact(
  harness: Harness,
  coagentId: string,
  name: string,
): Promise<string> {
  return readFile(join(harness.recordDir(coagentId), name), "utf8");
}

/** 构造 harness（config 可在缺省上覆盖）。 */
export async function createHarness(
  options: {
    config?: CoagentConfig;
    parentCwd?: string;
    /** 不传则用临时目录生成 fake sessionPaths。 */
    paths?: SessionPathsFace;
    /** 缺省 true：让 `createCoagentActions` 用临时目录；false 时不传 sessionPaths（降级路径）。 */
    withPaths?: boolean;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "coagent-test-"));
  const parentCwd = options.parentCwd ?? join(dir, "work");
  await mkdir(parentCwd, { recursive: true });

  const herdr = new FakeHerdr();
  const channel = new FakeChannel();
  const clock = new ManualClock();
  const paths =
    options.withPaths === false
      ? undefined
      : (options.paths ?? {
          sessionDirFor: (sessionId: string) =>
            join(dir, `session-${sessionId}`),
        });

  const actions = createCoagentActions({
    herdr,
    channel,
    ...(paths === undefined ? {} : { paths }),
    clock,
    profile: PROFILE,
    dshHome: join(dir, "dsh-home"),
    config: {
      pollIntervalMs: 1000,
      claimTimeoutSec: 3,
      graceSec: 3,
      gracePollMs: 250,
      maxLive: 4,
      maxRecords: 50,
      ...options.config,
    },
  });
  const tool = toToolDef(actions);
  const exec = {
    agent: { session: { id: PARENT, cwd: parentCwd } },
  };

  return {
    dir,
    parentCwd,
    herdr,
    channel,
    clock,
    tool,
    exec,
    recordDir(coagentId: string): string {
      return join(dir, `session-${PARENT}`, "coagent", coagentId);
    },
    sessionDir(sessionId: string = PARENT): string {
      return join(dir, `session-${sessionId}`);
    },
    spawn(args: Record<string, unknown> = {}) {
      return tool.execute({ action: "spawn", ...args }, exec);
    },
    close(args: Record<string, unknown>) {
      return tool.execute({ action: "close", ...args }, exec);
    },
    list(args: Record<string, unknown> = {}) {
      return tool.execute({ action: "list", ...args }, exec);
    },
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 让「下一轮轮询」看到新会话上线：默认在第一次 sleep 时注入 peer，
 * `afterSleeps` 控制第几次 sleep 之后注入（缺省 1 = 第二轮命中）。
 */
export function schedulePeer(
  harness: Harness,
  options: {
    sessionId?: string;
    pid?: number;
    afterSleeps?: number;
    cwd?: string;
    profile?: string;
  } = {},
): void {
  const after = options.afterSleeps ?? 1;
  let sleeps = 0;
  harness.clock.onSleep(() => {
    sleeps += 1;
    if (sleeps !== after) return;
    harness.channel.addPeer({
      sessionId: options.sessionId ?? "sess-child",
      pid: options.pid ?? 4321,
      cwd: options.cwd ?? harness.parentCwd,
      profile: options.profile ?? PROFILE,
      startedAt: harness.clock.now(),
    });
  });
}

/** 读索引（断言记录状态与墓碑用）。 */
export async function readIndex(harness: Harness): Promise<CoagentIndex> {
  const text = await readFile(
    join(harness.sessionDir(), "coagent", "index.json"),
    "utf8",
  );
  return JSON.parse(text) as CoagentIndex;
}
