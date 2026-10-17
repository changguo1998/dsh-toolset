/**
 * encode 单测：与宿主的目录编码逐字符对拍（表驱动）。
 *
 * 期望值的来源：
 * - 真实桶名：本机 `~/.dsh/sessions/` 实测目录（七个桶）；
 * - 合成向量（`~XXXX` 转义 / 连续分隔符合并 / `_no-cwd` / `.` 与 `..` / 251 截断）：
 *   直接从宿主已安装包 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` 截出
 *   `encodeSegment` / `projectKey` / `projectDir` / `sessionDir` 四个函数（它们不导出），
 *   在本地 eval 出真实实现后取值 —— 是对拍而非重新实现。
 *
 * 断言一律逐字符相等（`assert.equal`），不用「包含」。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  encodeSegment,
  projectDir,
  projectKey,
  sessionDir,
} from "../src/encode.ts";

test("projectKey：本机真实桶名逐字符相等", () => {
  const cases: ReadonlyArray<readonly [cwd: string, bucket: string]> = [
    ["/home/guochang", "--home-guochang--"],
    ["/home/guochang/.dsh", "--home-guochang-.dsh--"],
    ["/home/guochang/.dsh/profiles/tui", "--home-guochang-.dsh-profiles-tui--"],
    ["/home/guochang/fff", "--home-guochang-fff--"],
    [
      "/home/guochang/Projects/dsh-toolset",
      "--home-guochang-Projects-dsh-toolset--",
    ],
    [
      "/home/guochang/Projects/dsh-toolset/.worktree/preference-analysis",
      "--home-guochang-Projects-dsh-toolset-.worktree-preference-analysis--",
    ],
    ["/home/guochang/Projects/RTEMS", "--home-guochang-Projects-RTEMS--"],
  ];
  for (const [cwd, bucket] of cases) {
    assert.equal(projectKey(cwd), bucket, cwd);
  }
});

test("projectKey：非白名单字符走 ~XXXX（4 位大写十六进制）", () => {
  const cases: ReadonlyArray<readonly [cwd: string, bucket: string]> = [
    ["/tmp/中文", "--tmp-~4E2D~6587--"],
    ["~", "--~007E--"],
    ["/tmp/a~b", "--tmp-a~007Eb--"],
  ];
  for (const [cwd, bucket] of cases) {
    assert.equal(projectKey(cwd), bucket, cwd);
  }
});

test("projectKey：分隔符归一为 - 且连续分隔符合并、前导 - 去掉", () => {
  const cases: ReadonlyArray<readonly [cwd: string, bucket: string]> = [
    ["//a\\\\b::c", "--a-b-c--"],
    ["C:\\Users\\x", "--C-Users-x--"],
    ["/", "--root--"],
    // 末尾分隔符变成一个 -，宿主不去尾（有意有损）；照抄该行为。
    ["/home/x/", "--home-x---"],
  ];
  for (const [cwd, bucket] of cases) {
    assert.equal(projectKey(cwd), bucket, cwd);
  }
});

test("projectKey：正文截断到 251 字符（外壳之外，总长 255）", () => {
  const key = projectKey("a".repeat(300));
  assert.equal(key, `--${"a".repeat(251)}--`);
  assert.equal(key.length, 255);
});

test("projectKey：空 cwd 按宿主同语义抛错", () => {
  assert.throws(() => projectKey(""), /cannot encode an empty project path/);
});

test("encodeSegment：安全字符原样、不安全字符转义", () => {
  const cases: ReadonlyArray<readonly [raw: string, segment: string]> = [
    [
      "07bd659f-f134-44de-9946-8c9f7575af28",
      "07bd659f-f134-44de-9946-8c9f7575af28",
    ],
    ["...", "..."],
    ["~", "~007E"],
    ["a b", "a~0020b"],
    ["a/b", "a~002Fb"],
    ["中", "~4E2D"],
    // 孤立代理项按 UTF-16 码元转义，可原样还原。
    ["\uD800", "~D800"],
    ["\u0000", "~0000"],
    ["\u00e9", "~00E9"],
  ];
  for (const [raw, segment] of cases) {
    assert.equal(encodeSegment(raw), segment, JSON.stringify(raw));
  }
});

test("encodeSegment：. 与 .. 特判、空串抛错", () => {
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.throws(() => encodeSegment(""), /cannot encode an empty path segment/);
});

test("encodeSegment：路径穿越串不产生分隔符", () => {
  const encoded = encodeSegment("../x");
  assert.equal(encoded, "..~002Fx");
  assert.ok(!encoded.includes("/"));
});

test("projectDir：cwd 缺失走 _no-cwd，其余走 projectKey", () => {
  assert.equal(projectDir("/srv/sessions", undefined), "/srv/sessions/_no-cwd");
  assert.equal(
    projectDir("/srv/sessions", "/home/x"),
    "/srv/sessions/--home-x--",
  );
  assert.throws(
    () => projectDir("/srv/sessions", ""),
    /cannot encode an empty project path/,
  );
});

test("sessionDir：项目桶 + 编码后的会话 id", () => {
  assert.equal(
    sessionDir("/srv/sessions", "/home/x", "s1"),
    "/srv/sessions/--home-x--/s1",
  );
  assert.equal(
    sessionDir("/srv/sessions", undefined, "s1"),
    "/srv/sessions/_no-cwd/s1",
  );
  assert.equal(
    sessionDir("/srv/sessions", "/p", "../x"),
    "/srv/sessions/--p--/..~002Fx",
  );
  assert.throws(
    () => sessionDir("/srv/sessions", "/p", ""),
    /cannot encode an empty path segment/,
  );
});

test("纯函数不落盘：目录不存在也照常返回", async () => {
  const base = await mkdtemp(join(tmpdir(), "session-paths-pure-"));
  const root = join(base, "sessions");
  try {
    const dir = sessionDir(root, "/home/x", "s1");
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(root), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
