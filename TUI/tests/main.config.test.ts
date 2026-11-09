// TUI/tests/main.config.test.ts — 展示类配置归一化（main.ts 配置边界）
//
// 覆盖：默认值；合法值透传；非法值（非有限数/越界/小数）回退默认并告警。
// normalizeTuiDisplayConfig 为纯函数，真实链路在 apply() 一次性归一化，
// app 内不再判断合法性。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPROVAL_TIMEOUT_DEFAULT_MS,
  normalizeTuiDisplayConfig,
  parseTuiStartupArgs,
  planStartupRoute,
  planStartupSelection,
  readAgentModelSelection,
  resolveApprovalTimeoutMs,
  setAgentModelSelection,
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

test("parseTuiStartupArgs：--provider/--model/--effort 两种写法与空值忽略", () => {
  assert.deepEqual(
    parseTuiStartupArgs([
      "--provider",
      "p1",
      "--model",
      "p1/m1:high",
      "--effort",
      "max",
    ]),
    {
      continueLatest: false,
      provider: "p1",
      model: "p1/m1:high",
      effort: "max",
    },
  );
  assert.deepEqual(
    parseTuiStartupArgs([
      "--provider=p1",
      "--model=m1",
      "--effort=low",
      "--resume=s1",
    ]),
    {
      resume: "s1",
      continueLatest: false,
      provider: "p1",
      model: "m1",
      effort: "low",
    },
  );
  assert.deepEqual(
    parseTuiStartupArgs(["--provider=", "--model", "--effort"]),
    { continueLatest: false },
    "空值 / 缺值忽略",
  );
});

// --- 启动参数并入初始路由（`--model` 抢在首个请求之前） ---
//
// 会话开局 / 恢复的 `session-start` steer 注入会立刻起回合并发请求，故启动模型必须在
// 句柄就绪后同步写进宿主（agentOptions + `model.select`），不能等 App 启动后再切。

test("planStartupRoute：命令行 > 基线；--model 带 provider 段同时改 provider", () => {
  const base = { provider: "tg", model: "ds41f", reasoningEffort: "low" };
  assert.deepEqual(
    planStartupRoute(base, parseTuiStartupArgs([])),
    { route: { provider: "tg", model: "ds41f", reasoningEffort: "low" } },
    "无启动参数 → 路由原样、无 override",
  );
  assert.deepEqual(
    planStartupRoute(base, parseTuiStartupArgs(["--model", "tg/ds4f"])),
    {
      route: { provider: "tg", model: "ds4f", reasoningEffort: "low" },
      override: { provider: "tg", model: "ds4f" },
    },
    "provider 段覆盖 provider；effort 沿用基线",
  );
  assert.deepEqual(
    planStartupRoute(base, parseTuiStartupArgs(["--model", "ds4f:max"])),
    {
      route: { provider: "tg", model: "ds4f", reasoningEffort: "max" },
      override: { model: "ds4f", reasoningEffort: "max" },
    },
    "裸 model 用基线 provider；:effort 覆盖 effort",
  );
  assert.deepEqual(
    planStartupRoute(base, parseTuiStartupArgs(["--provider", "ustc"])),
    {
      route: { provider: "ustc", model: "ds41f", reasoningEffort: "low" },
      override: { provider: "ustc" },
    },
    "--provider 单给保留 model / effort",
  );
  assert.deepEqual(
    planStartupRoute(base, parseTuiStartupArgs(["--effort", "high"])),
    {
      route: { provider: "tg", model: "ds41f", reasoningEffort: "high" },
      override: { reasoningEffort: "high" },
    },
  );
});

test("planStartupRoute：--model 拆分失败 / 基线不全时不猜", () => {
  const base = { provider: "tg", model: "ds41f" };
  assert.deepEqual(
    planStartupRoute(base, parseTuiStartupArgs(["--model", "p:"])),
    { route: { provider: "tg", model: "ds41f" } },
    "拆分失败 → 不覆盖（交给启动后目录校验告警）",
  );
  assert.deepEqual(
    planStartupRoute({}, parseTuiStartupArgs(["--model", "ds4f"])),
    { route: {}, override: { model: "ds4f" } },
    "基线缺 provider：路由保持，override 仍交给句柄按记录选择补齐",
  );
});

test("planStartupSelection：显式字段优先，缺的按宿主当前选择补齐", () => {
  const current = { provider: "tg", model: "ds41f", reasoningEffort: "low" };
  assert.equal(
    planStartupSelection(current, undefined),
    undefined,
    "无 override → 不预置（不写默认路由）",
  );
  assert.deepEqual(
    planStartupSelection(current, { provider: "other" }),
    { provider: "other", model: "ds41f", reasoningEffort: "low" },
    "--provider 单给保留记录选择的 model / effort",
  );
  assert.deepEqual(
    planStartupSelection(current, { model: "ds4f" }),
    { provider: "tg", model: "ds4f", reasoningEffort: "low" },
    "裸 model 保留记录选择的 provider / effort",
  );
  assert.equal(
    planStartupSelection(undefined, { reasoningEffort: "high" }),
    undefined,
    "provider / model 补不齐 → 不预置",
  );
});

test("readAgentModelSelection / setAgentModelSelection：读写宿主 Agent.model", () => {
  const calls: { provider: string; model: string }[] = [];
  const warns: string[] = [];
  const warn = (m: string) => {
    warns.push(m);
  };
  const agent = {
    model: {
      current: () => ({
        provider: "tg",
        model: "ds41f",
        reasoningEffort: "low",
      }),
      select: (sel: { provider: string; model: string }) => {
        calls.push(sel);
      },
    },
  };
  assert.deepEqual(readAgentModelSelection(agent), {
    provider: "tg",
    model: "ds41f",
    reasoningEffort: "low",
  });
  assert.equal(
    setAgentModelSelection(agent, { provider: "tg", model: "ds4f" }, warn),
    true,
  );
  assert.deepEqual(calls, [{ provider: "tg", model: "ds4f" }]);
  assert.deepEqual(warns, []);

  assert.equal(
    setAgentModelSelection({}, { provider: "tg", model: "ds4f" }, warn),
    false,
    "缺 model.select → false（新建会话仍有 agentOptions 兜底）",
  );
  assert.match(warns.join(""), /agent\.model\.select/);

  const boom = {
    model: {
      select: () => {
        throw new Error("not ready");
      },
    },
  };
  assert.equal(
    setAgentModelSelection(boom, { provider: "tg", model: "ds4f" }, warn),
    false,
  );
  assert.match(warns.join(""), /预置失败/);
  assert.equal(
    readAgentModelSelection({
      model: {
        current: () => {
          throw new Error("no session");
        },
      },
    }),
    undefined,
    "current 抛错按缺失处理",
  );
});

test("main.ts：启动模型在建 adapter / App 之前同步预置（首个请求前生效）", () => {
  const source = readFileSync(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const pinned = source.indexOf("const startupPinned = planStartupSelection(");
  const adapter = source.indexOf("const adapter = createRealDshAdapter({");
  assert.ok(pinned > 0, "main.ts 应有句柄就绪后的同步预置");
  assert.ok(adapter > 0, "main.ts 应装配真实 adapter");
  assert.ok(
    pinned < adapter,
    "预置必须在 adapter / App 启动之前（会话开局 steer 注入会立刻发首个请求）",
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

test("审批超时取用链：配置文件 > 插件 config > 缺省 1 min（BACKLOG 3.3.7）", () => {
  assert.equal(
    resolveApprovalTimeoutMs(45_000, 30_000),
    45_000,
    "配置文件值优先",
  );
  assert.equal(
    resolveApprovalTimeoutMs(undefined, 30_000),
    30_000,
    "配置文件缺失时取插件 config",
  );
  assert.equal(
    resolveApprovalTimeoutMs(undefined, undefined),
    APPROVAL_TIMEOUT_DEFAULT_MS,
    "两级都缺失 → 缺省",
  );
  assert.equal(
    APPROVAL_TIMEOUT_DEFAULT_MS,
    60_000,
    "缺省 = 1 min（60_000 ms）",
  );
});
