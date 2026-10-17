/**
 * 服务面单测：假 ctx（`get` + `provide`）+ 假 `sessions`，不触宿主、不写真实 `~/.dsh`。
 *
 * 覆盖：
 * - `apply` 注册服务面（cordis `provide` 与极简 ctx 的直接挂载两条路）；
 * - `root` 的三段缺省（显式配置 / `DSH_HOME` / `~/.dsh`）；
 * - 四个纯函数经服务面的返回值；
 * - `ensureSessionDir` 的 0700 与幂等；
 * - `sessionDirFor` 四态（有 cwd / cwd 缺失落 `_no-cwd` / 会话取不到抛 / `sessions` 缺失抛）
 *   以及「不创建目录」「`sessions` 晚挂载仍可用」。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  apply,
  resolveRoot,
  SessionPathsService,
  type SessionPaths,
} from "../src/main.ts";

/** 假宿主 ctx：`get` 读服务表，`provide` 记录挂载。 */
function fakeCtx(services: Record<string, unknown> = {}) {
  const provided = new Map<string, unknown>();
  return {
    provided,
    get: (serviceName: string) => services[serviceName],
    provide: (serviceName: string, value: unknown) => {
      provided.set(serviceName, value);
      return value;
    },
  };
}

/** 假宿主 sessions：只认给定 id 的会话。 */
function fakeSessions(
  byId: Record<string, { header?: { cwd?: string } } | undefined>,
) {
  return {
    get: (sessionId: string) => byId[sessionId],
  };
}

test("apply：经 cordis provide 注册 sessionPaths 服务", () => {
  const ctx = fakeCtx();
  apply(ctx, { root: "/tmp/sessions-x" });
  const service = ctx.provided.get("sessionPaths") as SessionPaths | undefined;
  assert.ok(service !== undefined);
  assert.equal(service.root(), "/tmp/sessions-x");
  assert.equal(service.projectKey("/home/u/p"), "--home-u-p--");
  assert.equal(service.projectDir(undefined), "/tmp/sessions-x/_no-cwd");
  assert.equal(
    service.sessionDir("/home/u/p", "s1"),
    "/tmp/sessions-x/--home-u-p--/s1",
  );
});

test("apply：极简 ctx 无 provide 时退回直接属性挂载", () => {
  const ctx: Record<string, unknown> = {};
  apply(ctx, { root: "/tmp/sessions-y" });
  const service = ctx["sessionPaths"] as SessionPaths | undefined;
  assert.ok(service !== undefined);
  assert.equal(service.root(), "/tmp/sessions-y");
});

test("root 缺省：DSH_HOME/sessions；无 DSH_HOME 时 ~/.dsh/sessions", () => {
  const saved = process.env["DSH_HOME"];
  try {
    process.env["DSH_HOME"] = "/custom/home";
    assert.equal(resolveRoot(), "/custom/home/sessions");
    assert.equal(new SessionPathsService().root(), "/custom/home/sessions");
    delete process.env["DSH_HOME"];
    assert.equal(resolveRoot(), join(homedir(), ".dsh", "sessions"));
  } finally {
    if (saved === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = saved;
  }
});

test("ensureSessionDir：mkdir -p 为 0700 且幂等", async () => {
  const base = await mkdtemp(join(tmpdir(), "session-paths-ensure-"));
  try {
    const service = new SessionPathsService(join(base, "sessions"), fakeCtx());
    const dir = service.sessionDir("/home/u/proj", "s1");
    assert.equal(existsSync(dir), false);

    assert.equal(await service.ensureSessionDir("/home/u/proj", "s1"), dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);

    // 幂等：第二次调用不抛、路径不变、权限仍是 0700。
    assert.equal(await service.ensureSessionDir("/home/u/proj", "s1"), dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("sessionDirFor：有 cwd 时与 sessionDir(cwd, id) 逐字符相等", () => {
  const root = "/tmp/sessions-z";
  const ctx = fakeCtx({
    sessions: fakeSessions({ s1: { header: { cwd: "/home/u/proj" } } }),
  });
  const service = new SessionPathsService(root, ctx);
  assert.equal(
    service.sessionDirFor("s1"),
    service.sessionDir("/home/u/proj", "s1"),
  );
  assert.equal(
    service.sessionDirFor("s1"),
    "/tmp/sessions-z/--home-u-proj--/s1",
  );
});

test("sessionDirFor：header.cwd 缺失落 _no-cwd 桶", () => {
  const root = "/tmp/sessions-z";
  const withHeader = new SessionPathsService(
    root,
    fakeCtx({ sessions: fakeSessions({ s1: { header: {} } }) }),
  );
  assert.equal(withHeader.sessionDirFor("s1"), join(root, "_no-cwd", "s1"));

  const withoutHeader = new SessionPathsService(
    root,
    fakeCtx({ sessions: fakeSessions({ s2: {} }) }),
  );
  assert.equal(withoutHeader.sessionDirFor("s2"), join(root, "_no-cwd", "s2"));
});

test("sessionDirFor：会话取不到即抛明示例外", () => {
  const service = new SessionPathsService(
    "/tmp/sessions-z",
    fakeCtx({ sessions: fakeSessions({}) }),
  );
  assert.throws(() => service.sessionDirFor("nope"), /不在宿主的 sessions/);
});

test("sessionDirFor：sessions 服务缺失即抛明示例外", () => {
  const service = new SessionPathsService("/tmp/sessions-z", fakeCtx());
  assert.throws(() => service.sessionDirFor("s1"), /sessions 服务不可用/);
});

test("sessionDirFor：sessions 晚挂载仍可用（每调用复取服务）", () => {
  const services: Record<string, unknown> = {};
  const ctx = {
    get: (serviceName: string) => services[serviceName],
    provide: () => undefined,
  };
  const service = new SessionPathsService("/tmp/sessions-z", ctx);
  assert.throws(() => service.sessionDirFor("s1"), /sessions 服务不可用/);
  services["sessions"] = fakeSessions({ s1: { header: { cwd: "/p" } } });
  assert.equal(service.sessionDirFor("s1"), "/tmp/sessions-z/--p--/s1");
});

test("sessionDirFor：不创建目录（调用前后目录都不存在）", () => {
  const root = "/tmp/session-paths-not-created/sessions";
  const dir = join(root, "--home-u-proj--", "s1");
  const service = new SessionPathsService(
    root,
    fakeCtx({
      sessions: fakeSessions({ s1: { header: { cwd: "/home/u/proj" } } }),
    }),
  );
  assert.equal(existsSync(dir), false);
  assert.equal(service.sessionDirFor("s1"), dir);
  assert.equal(existsSync(dir), false);
});

test("sessionDirFor：空会话 id 按宿主同语义抛错", () => {
  const service = new SessionPathsService(
    "/tmp/sessions-z",
    fakeCtx({ sessions: fakeSessions({}) }),
  );
  assert.throws(
    () => service.sessionDirFor(""),
    /cannot encode an empty path segment/,
  );
});

test("readService：ctx.get 抛错时按缺失处理（不外泄异常）", () => {
  const ctx = {
    get: () => {
      throw new Error("cannot get property 'sessions' without inject");
    },
    provide: () => undefined,
  };
  const service = new SessionPathsService("/tmp/sessions-z", ctx);
  assert.throws(() => service.sessionDirFor("s1"), /sessions 服务不可用/);
});
