/**
 * 装配面测试：bundle 契约导出 + 配置解析（缺省 / 钳位 / 净化）+ 工具注册与降级。
 *
 * 与真实执行无关（不需要机器上有 Python）：解释器缺失时也必须照常注册工具。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_SPILL_PREFIX,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  apply,
  inject,
  name,
  resolveSettings,
} from "../src/index.ts";
import { TOOL_NAME } from "../src/tools.ts";
import {
  cordisHost,
  fakeApproval,
  fakePolicyService,
  fakeSandbox,
  mockHost,
} from "./helpers.ts";

test("bundle 契约：name 与 inject", () => {
  assert.equal(name, "script-interpreter");
  assert.deepEqual(inject, ["tools"]);
});

test("resolveSettings：缺省值（只 Python / 不审批 / 30s / 10 万 / dsh-script-）", () => {
  const settings = resolveSettings();
  assert.deepEqual(settings.languages, ["python"]);
  assert.equal(settings.approval, "never");
  assert.equal(settings.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(settings.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
  assert.equal(settings.spillPrefix, DEFAULT_SPILL_PREFIX);
  assert.equal(settings.pythonPath, undefined);
  assert.equal(settings.bashPath, undefined);
});

test("resolveSettings：语言去重去空，空表保留为空", () => {
  assert.deepEqual(
    resolveSettings({ languages: ["python", "python", " "] }).languages,
    ["python"],
  );
  assert.deepEqual(resolveSettings({ languages: [] }).languages, []);
});

test("resolveSettings：超时与输出上限钳位，非法值回退缺省", () => {
  assert.equal(resolveSettings({ timeoutMs: 1_000 }).timeoutMs, 1_000);
  assert.equal(
    resolveSettings({ timeoutMs: 10_000_000 }).timeoutMs,
    MAX_TIMEOUT_MS,
  );
  assert.equal(resolveSettings({ timeoutMs: 0 }).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(
    resolveSettings({ timeoutMs: -5 }).timeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  assert.equal(
    resolveSettings({ timeoutMs: Number.NaN }).timeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  assert.equal(
    resolveSettings({ maxOutputChars: 1_000 }).maxOutputChars,
    1_000,
  );
  assert.equal(
    resolveSettings({ maxOutputChars: -1 }).maxOutputChars,
    DEFAULT_MAX_OUTPUT_CHARS,
  );
});

test("resolveSettings：审批取值只有 ask 生效，其它一律 never", () => {
  assert.equal(resolveSettings({ approval: "ask" }).approval, "ask");
  assert.equal(resolveSettings({ approval: "never" }).approval, "never");
  assert.equal(
    resolveSettings({ approval: "whatever" as unknown as "ask" }).approval,
    "never",
  );
});

test("resolveSettings：落盘前缀净化掉路径分隔符与点开头", () => {
  assert.equal(
    resolveSettings({ spillPrefix: "/tmp/x-" }).spillPrefix,
    "tmp-x-",
  );
  assert.equal(
    resolveSettings({ spillPrefix: "  " }).spillPrefix,
    DEFAULT_SPILL_PREFIX,
  );
  assert.equal(
    resolveSettings({ spillPrefix: "..." }).spillPrefix,
    DEFAULT_SPILL_PREFIX,
  );
});

test("resolveSettings：解释器路径覆盖去空白，空串按未配置", () => {
  assert.equal(
    resolveSettings({ pythonPath: " /opt/py/bin/python " }).pythonPath,
    "/opt/py/bin/python",
  );
  assert.equal(resolveSettings({ pythonPath: "   " }).pythonPath, undefined);
});

test("apply：缺省注册唯一工具 script_run，语言枚举只含 python", () => {
  const host = mockHost();
  apply(host.ctx);
  assert.equal(host.defs.length, 1);
  const tool = host.tool();
  assert.equal(tool.name, TOOL_NAME);
  assert.equal(tool.name, "script_run");
  const properties = tool.parameters.properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    "description",
    "language",
    "script",
    "timeoutMs",
    "workdir",
  ]);
  // 硬拒层对拍：security-guard 登记的命令参数键必须是 script（不是 command / code）。
  assert.ok("script" in properties);
  assert.ok(!("command" in properties));
  assert.ok(!("code" in properties));
  assert.deepEqual(tool.parameters.required, ["script", "description"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual((properties.language as { enum?: readonly string[] }).enum, [
    "python",
  ]);
  // 与官方面不重叠：不注册 bash / run_code 等官方工具名。
  const names = host.defs.map((def) => def.name);
  for (const official of ["bash", "run_code", "run_script", "python_exec"]) {
    assert.ok(!names.includes(official), `不应注册官方工具名 ${official}`);
  }
  assert.ok(
    host.logs.some((line) => line.includes("script-interpreter ready")),
  );
});

test("apply：语言表为空时不注册任何工具并告警", () => {
  const host = mockHost();
  apply(host.ctx, { languages: [] });
  assert.deepEqual(host.defs, []);
  assert.ok(
    host.logs.some((line) => line.includes("不注册 script_run")),
    host.logs.join("\n"),
  );
});

test("apply：全部语言都未知时不注册任何工具并告警", () => {
  const host = mockHost();
  apply(host.ctx, { languages: ["ruby"] });
  assert.deepEqual(host.defs, []);
  assert.ok(host.logs.some((line) => line.includes("未知语言 ruby")));
});

test("apply：解释器路径覆盖不可执行时仍注册，日志给安装指引", () => {
  const host = mockHost();
  apply(host.ctx, { pythonPath: "/nonexistent/python-interpreter" });
  assert.equal(host.defs.length, 1);
  assert.equal(host.tool().name, "script_run");
  assert.ok(
    host.logs.some((line) => line.includes("未探测到解释器")),
    host.logs.join("\n"),
  );
});

test("apply：沙箱服务缺失时在装载日志里告警，服务齐全时不告警", () => {
  const missing = mockHost();
  apply(missing.ctx);
  assert.ok(
    missing.logs.some((line) => line.includes("沙箱服务不完整")),
    missing.logs.join("\n"),
  );
  const complete = mockHost({
    sandbox: fakeSandbox({ argv: [] }).provider,
    sandboxPolicy: fakePolicyService({
      mode: "read-only",
      workspaceRoot: "/tmp",
    }).service,
  });
  apply(complete.ctx);
  assert.ok(
    !complete.logs.some((line) => line.includes("沙箱服务不完整")),
    complete.logs.join("\n"),
  );
});

test("apply：未 inject 的服务直读会抛，装配改走 ctx.get（不崩、不误判）", () => {
  const host = cordisHost();
  // 替身自身行为先钉住：与真实宿主一致，直读未 inject 的服务即抛。
  assert.throws(
    () => (host.ctx as unknown as Record<string, unknown>).sandbox,
    /without inject/,
  );
  assert.doesNotThrow(() => {
    apply(host.ctx);
  });
  assert.equal(host.defs.length, 1);
  assert.ok(
    host.logs.some((line) => line.includes("沙箱服务不完整")),
    host.logs.join("\n"),
  );
});

test("apply：经 ctx.get 取到沙箱与审批服务时按可用处理、不告警", () => {
  const host = cordisHost({
    sandbox: fakeSandbox({ argv: [] }).provider,
    sandboxPolicy: fakePolicyService({
      mode: "read-only",
      workspaceRoot: "/tmp",
    }).service,
    approval: fakeApproval("allowed-once").service,
  });
  assert.doesNotThrow(() => {
    apply(host.ctx);
  });
  assert.equal(host.defs.length, 1);
  assert.ok(
    !host.logs.some((line) => line.includes("沙箱服务不完整")),
    host.logs.join("\n"),
  );
});

test("apply：宿主没有工具面时不抛错，只告警", () => {
  const host = mockHost({ tools: false });
  assert.doesNotThrow(() => {
    apply(host.ctx);
  });
  assert.deepEqual(host.defs, []);
  assert.ok(
    host.logs.some((line) => line.includes("ctx.tools 不可用")),
    host.logs.join("\n"),
  );
});
