/**
 * 集成层: 本插件 `apply` 与宿主接线 (假服务面 + 假宿主 `sessions`, 临时 HOME)。
 *
 * 与单元层 `tests/service.test.ts` 的分工: 单元层按单个方法 / 分支断言; 这里走完整链路 ——
 * `apply` 挂服务 → 消费方 `ctx.get("sessionPaths")` 取用 → 五个服务方法给出 canonical 值,
 * 其中 `ensureSessionDir` 真的落到临时 HOME 的 `~/.dsh/sessions` 下, `sessionDirFor` 走假
 * `sessions` 面取 `header.cwd`。断言一律逐字符相等 (路径不靠「包含」判断)。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { encodeSegment } from "../../src/index.ts";
import { assemble, type Assembly } from "../assemble.ts";

/** 在临时 HOME 上装配一次, 用例结束无论成败都删临时目录。 */
function withAssembly(
  run: (assembly: Assembly) => void | Promise<void>,
  options?: Parameters<typeof assemble>[1],
): Promise<void> {
  const assembly = assemble(undefined, options);
  return (async () => {
    try {
      await run(assembly);
    } finally {
      assembly.dispose();
    }
  })();
}

test("装配: apply 经宿主 provide 挂上 sessionPaths, 消费方 ctx.get 可取", () =>
  withAssembly((assembly) => {
    assert.equal(assembly.hasService(), true);
    const viaCtx = assembly.ctx["get"] as (name: string) => unknown;
    assert.equal(viaCtx("sessionPaths"), assembly.service());
  }));

test("root: 临时 HOME 下缺省为 <HOME>/.dsh/sessions", () =>
  withAssembly((assembly) => {
    assert.equal(
      assembly.service().root(),
      join(assembly.home, ".dsh", "sessions"),
    );
  }));

test("root: 显式 config.root 优先于临时 HOME", () => {
  const assembly = assemble({ root: "/srv/sessions" });
  try {
    assert.equal(assembly.service().root(), "/srv/sessions");
  } finally {
    assembly.dispose();
  }
});

test("encodeSegment: canonical 段值与宿主编码逐字符一致", () => {
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.equal(encodeSegment("~"), "~007E");
  assert.equal(
    encodeSegment("07bd659f-f134-44de-9946-8c9f7575af28"),
    "07bd659f-f134-44de-9946-8c9f7575af28",
  );
});

test("projectKey: canonical 桶名 (真实桶 / 转义 / 分隔符合并)", () =>
  withAssembly((assembly) => {
    const service = assembly.service();
    assert.equal(
      service.projectKey("/home/guochang/Projects/dsh-toolset"),
      "--home-guochang-Projects-dsh-toolset--",
    );
    assert.equal(service.projectKey("/tmp/中文"), "--tmp-~4E2D~6587--");
    assert.equal(service.projectKey("//a\\\\b::c"), "--a-b-c--");
    assert.equal(service.projectKey("/"), "--root--");
  }));

test("projectDir: cwd 缺失落 _no-cwd, 有 cwd 走 projectKey 桶", () =>
  withAssembly((assembly) => {
    const service = assembly.service();
    assert.equal(
      service.projectDir(undefined),
      join(service.root(), "_no-cwd"),
    );
    assert.equal(
      service.projectDir("/home/u/proj"),
      join(service.root(), "--home-u-proj--"),
    );
  }));

test("sessionDir: canonical 会话目录, 末段与 encodeSegment 一致", () =>
  withAssembly((assembly) => {
    const service = assembly.service();
    const root = service.root();
    assert.equal(
      service.sessionDir("/home/u/proj", "s1"),
      join(root, "--home-u-proj--", "s1"),
    );
    assert.equal(
      service.sessionDir(undefined, "s1"),
      join(root, "_no-cwd", "s1"),
    );
    assert.equal(
      service.sessionDir("/home/u/proj", "../x"),
      join(root, "--home-u-proj--", encodeSegment("../x")),
    );
    assert.equal(
      service.sessionDir("/home/u/proj", ".."),
      join(root, "--home-u-proj--", "~002E~002E"),
    );
  }));

test("ensureSessionDir: 在临时 HOME 下落盘 0700 且幂等", () =>
  withAssembly(async (assembly) => {
    const service = assembly.service();
    const dir = service.sessionDir("/home/u/proj", "s1");
    assert.equal(existsSync(dir), false);

    assert.equal(await service.ensureSessionDir("/home/u/proj", "s1"), dir);
    assert.equal(existsSync(dir), true);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);

    assert.equal(await service.ensureSessionDir("/home/u/proj", "s1"), dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }));

test("ensureSessionDir: cwd 缺失落 _no-cwd 桶并落盘", () =>
  withAssembly(async (assembly) => {
    const service = assembly.service();
    const dir = await service.ensureSessionDir(undefined, "s2");
    assert.equal(dir, join(service.root(), "_no-cwd", "s2"));
    assert.equal(existsSync(dir), true);
  }));

test("sessionDirFor: 经假 sessions 的 header.cwd 与 sessionDir 逐字符相等", () =>
  withAssembly(
    (assembly) => {
      const service = assembly.service();
      assert.equal(
        service.sessionDirFor("s1"),
        service.sessionDir("/home/u/proj", "s1"),
      );
      // header.cwd 缺失同样落 _no-cwd 桶。
      assert.equal(
        service.sessionDirFor("s2"),
        service.sessionDir(undefined, "s2"),
      );
    },
    { sessions: { s1: { header: { cwd: "/home/u/proj" } }, s2: {} } },
  ));

test("sessionDirFor: sessions 缺席时抛明示例外, 其余服务方法照常", () =>
  withAssembly((assembly) => {
    const service = assembly.service();
    assert.throws(() => service.sessionDirFor("s1"), /sessions 服务不可用/);
    assert.equal(
      service.sessionDir("/home/u/proj", "s1"),
      join(service.root(), "--home-u-proj--", "s1"),
    );
  }));

test("dispose: 删除临时 HOME 并恢复 HOME / DSH_HOME", () => {
  const beforeHome = process.env["HOME"];
  const beforeDshHome = process.env["DSH_HOME"];
  const assembly = assemble();
  const { home } = assembly;
  assert.equal(existsSync(home), true);
  assembly.dispose();
  assert.equal(existsSync(home), false);
  assert.equal(process.env["HOME"], beforeHome);
  assert.equal(process.env["DSH_HOME"], beforeDshHome);
});
