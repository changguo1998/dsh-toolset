// tests/main.config.test.ts — 展示类配置归一化（main.ts 配置边界）
//
// 覆盖：默认值；合法值透传；非法值（非有限数/越界/小数）回退默认并告警。
// normalizeTuiDisplayConfig 为纯函数，真实链路在 apply() 一次性归一化，
// app 内不再判断合法性。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeTuiDisplayConfig,
  parseTuiStartupArgs,
  waitForHostService,
} from "../src/main.ts";

function collect(): { warns: string[]; warn: (m: string) => void } {
  const warns: string[] = [];
  return { warns, warn: (m) => warns.push(m) };
}

test("归一化默认值：gutter 4", () => {
  const c = normalizeTuiDisplayConfig(undefined);
  assert.deepEqual(c, { messageGutter: 4 });
});

test("归一化合法值透传：自定义 gutter", () => {
  const c = normalizeTuiDisplayConfig({ messageGutter: 20 });
  assert.deepEqual(c, { messageGutter: 20 });
});

test("归一化非法值回退默认并告警", () => {
  const { warns, warn } = collect();
  const c = normalizeTuiDisplayConfig(
    {
      messageGutter: -5,
    },
    warn,
  );
  assert.equal(c.messageGutter, 4);
  assert.ok(warns.length >= 1, "每项非法值各告警一次，实际:" + warns.length);
  assert.ok(warns.every((w) => w.includes("回退默认")));
});

test("归一化越界/非有限数同样回退", () => {
  const { warns, warn } = collect();
  const c = normalizeTuiDisplayConfig(
    {
      messageGutter: 21,
    },
    warn,
  );
  assert.equal(c.messageGutter, 4, "越界回退默认");
  assert.ok(warns.length >= 1);
});

test("归一化小数四舍五入并在界内", () => {
  // 用非默认值（9.6 → 10）：默认值已为 4，若用 3.6 无法区分「四舍五入」与「回退默认」
  const c = normalizeTuiDisplayConfig({ messageGutter: 9.6 });
  assert.equal(c.messageGutter, 10);
});

// --- TUI#2：CLI 启动参数（宿主内层参数 ctx.cmdlineArgs 的 TUI 自有 flag 解析） ---

test("parseTuiStartupArgs：--resume 两种写法、-c/--continue、优先级与忽略项", () => {
  assert.deepEqual(parseTuiStartupArgs([]), { continueLatest: false });
  assert.deepEqual(parseTuiStartupArgs(["--resume", "s42"]), {
    resume: "s42",
    continueLatest: false,
  });
  assert.deepEqual(parseTuiStartupArgs(["--resume=s42"]), {
    resume: "s42",
    continueLatest: false,
  });
  assert.deepEqual(parseTuiStartupArgs(["-c"]), { continueLatest: true });
  assert.deepEqual(parseTuiStartupArgs(["--continue"]), {
    continueLatest: true,
  });
  assert.deepEqual(
    parseTuiStartupArgs(["-c", "--resume", "x"]),
    { resume: "x", continueLatest: true },
    "--resume 优先于 -c（两者都记录，启动侧取 resume）",
  );
  assert.deepEqual(
    parseTuiStartupArgs(["--theme", "dark", "-c"]),
    { continueLatest: true },
    "未知参数忽略（多插件共享、不消费）",
  );
  assert.deepEqual(
    parseTuiStartupArgs(["--resume"]),
    { continueLatest: false },
    "--resume 缺值 → 视为未提供",
  );
  assert.deepEqual(
    parseTuiStartupArgs(["--resume", "--continue"]),
    { continueLatest: true },
    "--resume 后紧跟其它 flag → 缺值，不吞掉 -c",
  );
  assert.deepEqual(
    parseTuiStartupArgs(["--resume="]),
    { continueLatest: false },
    "--resume= 空值 → 视为未提供",
  );
});

// --- 服务就绪等待（回归：「历史会话不可用（宿主未挂载 sessionQuery）」根因修复） ---
//
// 宿主服务随插件树并发装载，apply 早期 ctx.get('sessionQuery') 可能为空；
// waitForHostService 供启动决策有界等待，超时按未挂载处理。

test("waitForHostService：服务已就绪 → 立即返回，不等待", async () => {
  const svc = { name: "ready" };
  let calls = 0;
  const got = await waitForHostService<{ name: string }>(() => {
    calls++;
    return svc;
  }, 1_000);
  assert.equal(got, svc);
  assert.equal(calls, 1, "就绪时只读一次");
});

test("waitForHostService：等待期内就绪 → 返回服务实例", async () => {
  const svc = { name: "late" };
  let calls = 0;
  const got = await waitForHostService<{ name: string }>(
    () => {
      calls++;
      return calls >= 3 ? svc : undefined;
    },
    1_000,
    5,
  );
  assert.equal(got, svc);
  assert.ok(calls >= 3, "轮询到就绪为止，实际读 " + calls + " 次");
});

test("waitForHostService：始终未挂载 → 超时返回 undefined（有界）", async () => {
  let calls = 0;
  const started = Date.now();
  const got = await waitForHostService<{ name: string }>(
    () => {
      calls++;
      return undefined;
    },
    30,
    5,
  );
  assert.equal(got, undefined);
  assert.ok(calls >= 1, "至少读一次");
  assert.ok(Date.now() - started < 1_000, "超时后有界返回，不永久挂起");
});

test("main.ts：security-guard 服务按惰读 getter 提供（不是 apply 期快照）", () => {
  // BACKLOG「TUI 两处 guard 读法不一致」：与 `$` 复查的 getGuard 同口径；
  // 快照写法会在「TUI 先于 security-guard 装载」时误报不可用。
  const source = readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /get guard\(\): SecurityGuardLike \| undefined \{/);
  assert.doesNotMatch(
    source,
    /\n    guard: \(ctx as \{ get\?: \(name: string\) => unknown \}\)\.get\?\.\("guard"\)/,
    "不应再有 apply 期的 guard 值快照",
  );
});
