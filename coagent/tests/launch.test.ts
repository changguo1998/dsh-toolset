/**
 * coagent/tests/launch.test.ts — 拉起守门的锚点：`cwd` 校验、命令拼装、参数面校验与脱管痕迹自检。
 *
 * 纯函数 + 临时目录；只驱动 `coagent/src/launch.ts` 的导出。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  booleanArg,
  buildLaunchCommand,
  checkCwd,
  checkForegroundText,
  LAUNCH_COMMAND,
  launchValueArg,
  optionalString,
  parseSpawnArgs,
  positiveInt,
  rejectUnknownKeys,
} from "../src/launch.ts";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "coagent-launch-test-"));
  dirs.push(dir);
  return dir;
}

test("checkCwd: 绝对路径 + 目录才通过，其余给可读原因", async () => {
  const dir = await tempDir();
  assert.deepEqual(await checkCwd(dir), { ok: true });

  const relative = await checkCwd("work");
  assert.equal(relative.ok, false);
  assert.match(relative.ok ? "" : relative.reason, /必须是绝对路径/);

  const file = join(dir, "note.txt");
  await writeFile(file, "x", "utf8");
  const notDir = await checkCwd(file);
  assert.equal(notDir.ok, false);
  assert.match(notDir.ok ? "" : notDir.reason, /不是目录/);

  const missing = await checkCwd(join(dir, "nope"));
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.reason, /不存在或不可访问/);
});

test("buildLaunchCommand: 无参数给常量，有参数按 provider / model / effort 顺序拼", () => {
  assert.equal(LAUNCH_COMMAND, "fffdsh");
  assert.equal(buildLaunchCommand({}), "fffdsh");
  assert.equal(
    buildLaunchCommand({
      provider: "p1",
      model: "p1/m1:high",
      effort: "max",
    }),
    "fffdsh --provider p1 --model p1/m1:high --effort max",
  );
  assert.equal(buildLaunchCommand({ effort: "low" }), "fffdsh --effort low");
});

test("checkForegroundText: 词边界匹配，不误伤 background / screenshot", () => {
  assert.deepEqual(checkForegroundText("fffdsh --provider p1"), { ok: true });
  assert.deepEqual(checkForegroundText("fffdsh; background-task"), {
    ok: true,
  });

  for (const text of [
    "nohup fffdsh",
    "setsid fffdsh",
    "fffdsh &",
    "fffdsh; disown",
    "bg fffdsh",
    "screen -dm fffdsh",
    "tmux new fffdsh",
  ]) {
    const guard = checkForegroundText(text);
    assert.equal(guard.ok, false, `应拒绝：${text}`);
    assert.match(guard.ok ? "" : guard.reason, /脱管痕迹/);
  }
});

test("optionalString: 未给与空串都按未给，非字符串拒绝，已给则去首尾空白", () => {
  assert.deepEqual(optionalString({}, "cwd"), { ok: true, value: undefined });
  assert.deepEqual(optionalString({ cwd: "   " }, "cwd"), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(optionalString({ cwd: " /tmp/work " }, "cwd"), {
    ok: true,
    value: "/tmp/work",
  });
  assert.deepEqual(optionalString({ cwd: 42 }, "cwd"), {
    ok: false,
    reason: "cwd 必须是字符串",
  });
});

test("positiveInt: 只接受正整数（0 / 小数 / 字符串都拒）", () => {
  assert.deepEqual(positiveInt({}, "limit"), { ok: true, value: undefined });
  assert.deepEqual(positiveInt({ limit: 3 }, "limit"), { ok: true, value: 3 });
  for (const value of [0, -1, 2.5, "3", Number.NaN]) {
    const parsed = positiveInt({ limit: value }, "limit");
    assert.equal(parsed.ok, false, `应拒绝：${String(value)}`);
    assert.match(parsed.ok ? "" : parsed.reason, /必须是正整数/);
  }
});

test("booleanArg: 只接受布尔值", () => {
  assert.deepEqual(booleanArg({}, "force"), { ok: true, value: undefined });
  assert.deepEqual(booleanArg({ force: true }, "force"), {
    ok: true,
    value: true,
  });
  const wrong = booleanArg({ force: "true" }, "force");
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok ? "" : wrong.reason, /必须是布尔值/);
});

test("rejectUnknownKeys: 已删除的 target 与未支持的 task / text 各指一条明路", () => {
  assert.deepEqual(rejectUnknownKeys({ cwd: "/tmp" }, ["cwd"]), {
    ok: true,
    value: true,
  });

  const target = rejectUnknownKeys({ target: "tab" }, ["cwd"]);
  assert.equal(target.ok, false);
  assert.match(target.ok ? "" : (target.next ?? ""), /终端单层契约删除/);

  const task = rejectUnknownKeys({ task: "写报告" }, ["cwd"]);
  assert.match(task.ok ? "" : (task.next ?? ""), /channel_delegate/);

  const text = rejectUnknownKeys({ text: "你好" }, ["cwd"]);
  assert.match(text.ok ? "" : (text.next ?? ""), /channel_delegate/);

  const prompt = rejectUnknownKeys({ prompt: "你好" }, ["cwd"]);
  assert.match(prompt.ok ? "" : (prompt.next ?? ""), /channel_delegate/);

  const generic = rejectUnknownKeys({ foo: 1 }, ["cwd", "label"]);
  assert.equal(generic.ok, false);
  assert.match(generic.ok ? "" : generic.reason, /不支持的参数：foo/);
  assert.match(generic.ok ? "" : (generic.next ?? ""), /cwd \/ label/);
});

test("launchValueArg: 字符集与长度（≤64）守门，空串按未给", () => {
  assert.deepEqual(launchValueArg({}, "model"), { ok: true, value: undefined });
  assert.deepEqual(launchValueArg({ model: "  " }, "model"), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(launchValueArg({ model: "p1/m1:high" }, "model"), {
    ok: true,
    value: "p1/m1:high",
  });
  assert.deepEqual(launchValueArg({ effort: "a".repeat(64) }, "effort"), {
    ok: true,
    value: "a".repeat(64),
  });

  const tooLong = launchValueArg({ provider: "a".repeat(65) }, "provider");
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.ok ? "" : tooLong.reason, /不超过 64 字符/);

  const injection = launchValueArg({ model: "m1; rm -rf /" }, "model");
  assert.equal(injection.ok, false);
  assert.match(injection.ok ? "" : injection.reason, /只允许字母/);

  const wrongType = launchValueArg({ provider: 7 }, "provider");
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.ok ? "" : wrongType.reason, /必须是字符串/);
});

test("parseSpawnArgs: 合法参数组装成完整值；label 超长 / 子参数类型错误如实拒绝", () => {
  const parsed = parseSpawnArgs({
    cwd: "/tmp/work",
    label: "reviewer",
    claimTimeoutSec: 60,
    provider: "p1",
    model: "p1/m1:high",
    effort: "max",
  });
  assert.deepEqual(parsed, {
    ok: true,
    value: {
      cwd: "/tmp/work",
      label: "reviewer",
      claimTimeoutSec: 60,
      provider: "p1",
      model: "p1/m1:high",
      effort: "max",
    },
  });

  const tooLong = parseSpawnArgs({ label: "a".repeat(81) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.ok ? "" : tooLong.reason, /label 最长 80/);

  const badCwd = parseSpawnArgs({ cwd: 42 });
  assert.equal(badCwd.ok, false);
  assert.match(badCwd.ok ? "" : badCwd.reason, /cwd 必须是字符串/);

  const badTimeout = parseSpawnArgs({ claimTimeoutSec: 0 });
  assert.equal(badTimeout.ok, false);
  assert.match(badTimeout.ok ? "" : badTimeout.reason, /必须是正整数/);

  const badModel = parseSpawnArgs({ model: "m1|x" });
  assert.equal(badModel.ok, false);
  assert.match(badModel.ok ? "" : badModel.reason, /model 只允许/);

  const empty = parseSpawnArgs({});
  assert.deepEqual(empty, {
    ok: true,
    value: {
      cwd: undefined,
      label: undefined,
      claimTimeoutSec: undefined,
      provider: undefined,
      model: undefined,
      effort: undefined,
    },
  });
});
