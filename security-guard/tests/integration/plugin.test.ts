// security-guard 集成层: 经假宿主调 `apply`, 断言服务面 `guard` 的注册与 canonical 形状、
// 单调守卫面与 waterfall 降级两条挂载路径的判定结果、以及经宿主接线后的读/写拦截面。
// 装配器见 `tests/assemble.ts`（不以 `.test.ts` 结尾, 不计入覆盖率）。
//
// 本包不注册工具、不订阅除 `tools/pre-execute` 以外的事件, 也没有 `output.render` 投影,
// 故"工具注册名 / execute / render / 事件注入内容"四类断言是零值断言, 真正的契约面是
// 服务面 `guard` 与两条判定挂载路径。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { apply } from "../../src/index.ts";
import type { PreExecuteExecution } from "../../src/index.ts";
import { assemble } from "../assemble.ts";

const HOME = "/home/tester";
// 仓库内不出现危险命令字面量（与 guard.test.ts 同款拼接构造）
const RISKY = ["su", "do --version"].join("");

function execOf(name: string, args: unknown): PreExecuteExecution {
  return {
    name,
    arguments: args,
    callId: "call-integration",
    signal: new AbortController().signal,
  };
}

/** 临时目录 fixture: 敏感名文件 + 普通文件（敏感名按 basename 匹配, 与家目录无关）。 */
function makeFixture(): {
  dir: string;
  envPath: string;
  normalPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "sg-integration-"));
  const envPath = join(dir, ".env");
  const normalPath = join(dir, "notes.md");
  writeFileSync(envPath, "TOKEN=fixture\n");
  writeFileSync(normalPath, "# notes\n");
  return {
    dir,
    envPath,
    normalPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// 装配: 服务面与零注册面
// ---------------------------------------------------------------------------

test("apply: 经 provide 注册 guard 服务，ctx.get 读回同一实例，canonical 三方法齐备", () => {
  const host = assemble({ config: { homeDir: HOME } });
  assert.deepEqual(host.services.names(), ["guard"]);
  const service = host.guard();
  assert.equal(
    host.services.get("guard"),
    service,
    "provide 与 get 是同一实例",
  );
  assert.equal(typeof service.recent, "function");
  assert.equal(typeof service.policy, "function");
  assert.equal(typeof service.inspectCommand, "function");
  // recent 初始为空数组; policy 是快照对象
  assert.deepEqual(service.recent(), []);
  assert.equal(typeof service.policy(), "object");
});

test("装配面: 本包不注册工具、不订阅除 pre-execute 外的事件（单调守卫形态零监听器）", () => {
  const host = assemble({
    monotonic: true,
    config: { homeDir: HOME },
  });
  assert.deepEqual(host.tools.names(), [], "不注册任何工具");
  assert.deepEqual(host.tools.defs, []);
  assert.equal(host.events.listenerCount(), 0, "单调守卫形态不再挂监听器");
  assert.equal(host.tools.guards.length, 1, "恰注册一条单调守卫");
});

test("装配: 无 provide 面时仍挂判定面，服务面为空且取用即抛", async () => {
  const host = assemble({ shape: "no-provide", config: { homeDir: HOME } });
  assert.deepEqual(host.services.names(), []);
  assert.throws(() => host.guard(), /服务面 guard 未注册/);
  assert.equal(
    host.events.listenerCount(),
    1,
    "判定面照常挂载（waterfall 降级）",
  );
  const decision = await host.decide(execOf("bash", { command: RISKY }));
  assert.equal(decision.kind, "deny");
});

// ---------------------------------------------------------------------------
// 单调守卫面（宿主 ctx.tools.guard）
// ---------------------------------------------------------------------------

test("单调守卫: 命中回执字符串（canonical 规则 id / 原因 / 放行方式），未命中 undefined", async () => {
  const host = assemble({ monotonic: true, config: { homeDir: HOME } });
  const denied = await host.decide(execOf("bash", { command: RISKY }));
  assert.equal(denied.kind, "deny");
  const reason = (denied as { reason: string }).reason;
  assert.match(
    reason,
    /^\[security-guard\] 已拦截：命令命中黑名单规则「sudo」。/,
  );
  assert.match(reason, /原因：/);
  assert.match(reason, /放行方式：/);
  assert.match(reason, /commandBlacklist\.allowPatterns/);

  assert.deepEqual(
    await host.decide(execOf("bash", { command: "echo hi && ls -la" })),
    { kind: "allow" },
    "未命中 → 放行",
  );
  // 两次判定都经服务面同一引擎记账（守卫只判定一次）
  assert.deepEqual(
    host
      .guard()
      .recent()
      .map((r) => r.verdict),
    ["allow", "deny"],
  );
});

test("单调守卫: 挂载日志写明形态（monotonic guard）", () => {
  const host = assemble({ monotonic: true, config: { homeDir: HOME } });
  assert.ok(
    host.logs.info.some((line) => line.includes("mounted: monotonic guard")),
    `日志应写明单调守卫形态: ${host.logs.info.join(" | ")}`,
  );
  assert.deepEqual(host.logs.warn, []);
});

// ---------------------------------------------------------------------------
// waterfall 降级（宿主无 tools.guard）
// ---------------------------------------------------------------------------

test("waterfall: 命中返回 { kind: 'deny', reason }，回执带规则 id 与放行方式", async () => {
  const host = assemble({ config: { homeDir: HOME } });
  assert.equal(host.events.listenerCount("tools/pre-execute"), 1);
  const decision = await host.decide(
    execOf("read", { file_path: "~/.ssh/id_rsa" }),
  );
  assert.equal(decision.kind, "deny");
  const reason = (decision as { reason: string }).reason;
  assert.match(reason, /\[security-guard\] 已拦截：读取敏感文件/);
  assert.match(reason, /ssh-directory/);
  assert.match(reason, /工具：read/);
  assert.match(reason, /sensitiveFiles\.allowedPaths/);
});

test("waterfall: 未命中交给 next()（调用一次）并沿用链路后续决策", async () => {
  const host = assemble({ config: { homeDir: HOME } });
  let nextCalls = 0;
  // 在守卫之后追加一个监听器: 守卫放行时会调到它, 用它证明 next 链路被走通
  host.events.on("tools/pre-execute", async (_exec, next) => {
    nextCalls += 1;
    return next();
  });
  const decision = await host.decide(
    execOf("bash", { command: "echo integration" }),
  );
  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(nextCalls, 1, "放行路径恰好下传一次");
  // 命中时不走 next（后面的监听器一次都不该被调用）
  nextCalls = 0;
  await host.decide(execOf("bash", { command: RISKY }));
  assert.equal(nextCalls, 0, "拒绝路径截断链路");
});

test("waterfall: 挂载日志写明降级原因（回退 + 宿主无 tools.guard）", () => {
  const host = assemble({ config: { homeDir: HOME } });
  assert.ok(
    host.logs.info.some((line) => line.includes("回退")),
    `日志应写明降级路径: ${host.logs.info.join(" | ")}`,
  );
});

test("拒绝路径: 日志取回执前两行（规则摘要不丢），完整回执留在判定结果里", async () => {
  const host = assemble({ config: { homeDir: HOME } });
  await host.decide(execOf("bash", { command: RISKY }));
  const blocked = host.logs.info.find((line) =>
    line.includes("blocked tool=bash"),
  );
  assert.ok(
    blocked !== undefined,
    `应有 blocked 日志: ${host.logs.info.join(" | ")}`,
  );
  assert.match(blocked!, /blocked tool=bash/);
  assert.match(blocked!, /命令命中黑名单规则「sudo」/);
  assert.doesNotMatch(blocked!, /放行方式：/, "日志只取前两行");
});

// ---------------------------------------------------------------------------
// 服务面 canonical 值（外部命令复查 + 策略快照）
// ---------------------------------------------------------------------------

test("服务面: inspectCommand 经宿主 ctx.get 复查外部命令（来源标注 + recent 记账）", () => {
  const host = assemble({ config: { homeDir: HOME } });
  const service = host.guard();
  const receipt = service.inspectCommand(RISKY, "metric_loop{tick} id=p1");
  assert.ok(typeof receipt === "string", "命中应返回回执字符串");
  assert.match(receipt!, /命令复查来源：metric_loop\{tick\} id=p1/);
  assert.match(receipt!, /命令命中黑名单规则「sudo」/);
  assert.equal(
    service.inspectCommand("echo integration"),
    null,
    "普通命令放行",
  );
  // 外部复查与工具判定共用同一引擎: toolName 存的是来源标注
  assert.deepEqual(
    service.recent().map((r) => [r.toolName, r.verdict]),
    [
      ["external-command", "allow"],
      ["metric_loop{tick} id=p1", "deny"],
    ],
    "缺省来源标注为 external-command",
  );
});

test("服务面: policy() 快照与装配时的配置一致（开关 / 未登记策略 / 规则 id）", () => {
  const host = assemble({
    config: {
      homeDir: HOME,
      unknownToolPolicy: "deny",
      unknownToolAllowlist: ["mcp__*"],
      commandBlacklist: { allowPatterns: ["^echo ok$"] },
      sensitiveFiles: { allowedPaths: ["~/open"] },
    },
  });
  const snapshot = host.guard().policy();
  assert.equal(snapshot.enabled, true);
  assert.deepEqual(snapshot.unknownToolPolicy, {
    value: "deny",
    effective: "deny",
    invalid: false,
  });
  assert.deepEqual([...snapshot.unknownToolAllowlist], ["mcp__*"]);
  assert.deepEqual([...snapshot.commandBlacklist.allowPatterns], ["^echo ok$"]);
  assert.deepEqual(
    snapshot.sensitiveFiles.allowedPaths.map((rule) => rule.id),
    ["allowed-1"],
  );
  assert.ok(
    snapshot.commandBlacklist.rules.some((rule) => rule.id === "sudo"),
    "默认规则出现在快照里",
  );
});

test("服务面: 未登记工具策略经宿主生效（deny 拦携带路径参数的未登记工具）", async () => {
  const host = assemble({
    monotonic: true,
    config: { homeDir: HOME, unknownToolPolicy: "deny" },
  });
  const decision = await host.decide(
    execOf("mcp__files_read", { path: "/tmp/x.md" }),
  );
  assert.equal(decision.kind, "deny");
  assert.match(
    (decision as { reason: string }).reason,
    /未登记工具「mcp__files_read」携带潜在路径\/命令参数（path）/,
  );
  // 放行名单在三态之前判定
  const allowedHost = assemble({
    monotonic: true,
    config: {
      homeDir: HOME,
      unknownToolPolicy: "deny",
      unknownToolAllowlist: ["mcp__*"],
    },
  });
  assert.deepEqual(
    await allowedHost.decide(execOf("mcp__files_read", { path: "/tmp/x.md" })),
    { kind: "allow" },
  );
});

// ---------------------------------------------------------------------------
// 落盘: 临时目录 fixture 上的读/写拦截面
// ---------------------------------------------------------------------------

test("落盘: 读敏感文件（.env）拦为读侧，读普通文件放行，写 .env 拦为写侧", async () => {
  const fixture = makeFixture();
  try {
    const host = assemble({
      monotonic: true,
      config: { homeDir: fixture.dir },
    });
    // 读侧: read 工具的 file_path 命中 basename 规则
    const readDenied = await host.decide(
      execOf("read", { file_path: fixture.envPath }),
    );
    assert.equal(readDenied.kind, "deny");
    const readReceipt = (readDenied as { reason: string }).reason;
    assert.match(readReceipt, /已拦截：读取敏感文件/);
    assert.match(readReceipt, /env-file/);
    assert.match(readReceipt, /工具：read/);

    // 普通文件放行（不误伤）
    assert.deepEqual(
      await host.decide(execOf("read", { file_path: fixture.normalPath })),
      { kind: "allow" },
    );

    // 写侧: write 工具命中同一路径, 措辞为「写入」
    const writeDenied = await host.decide(
      execOf("write", { file_path: fixture.envPath, content: "x" }),
    );
    assert.equal(writeDenied.kind, "deny");
    const writeReceipt = (writeDenied as { reason: string }).reason;
    assert.match(writeReceipt, /已拦截：写入敏感文件/);
    assert.match(writeReceipt, /工具：write/);

    // shell 命令文本里出现该路径 → 命令内路径按读写两面标注
    const shellDenied = await host.decide(
      execOf("bash", { command: `cat ${fixture.envPath}` }),
    );
    assert.equal(shellDenied.kind, "deny");
    assert.match(
      (shellDenied as { reason: string }).reason,
      /已拦截：读写敏感文件/,
    );

    // recent() 新在前: 最后一次 shell 判定在最前, 最早那次 read 判定在最后
    assert.deepEqual(
      host
        .guard()
        .recent()
        .map((r) => r.verdict),
      ["deny", "deny", "allow", "deny"],
    );
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 重复挂载
// ---------------------------------------------------------------------------

test("重复挂载: 同名服务重复 provide 抛错（与 cordis 一致），不静默覆盖", () => {
  const host = assemble({ config: { homeDir: HOME } });
  const registered = host.guard();
  assert.throws(
    () => apply(host.ctx as never, { homeDir: HOME }),
    /service "guard" already registered/,
  );
  assert.equal(host.guard(), registered, "原服务实例保持不变");
});
