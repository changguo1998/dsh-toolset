/**
 * 装配面测试：bundle 契约导出 + 配置解析（缺省 / 钳位 / 净化）+ 工具注册与降级。
 *
 * 与真实执行无关（不需要机器上有 Python）：解释器缺失时也必须照常注册工具。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTO_LANGUAGES,
  BACKENDS,
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
import { lookupSurface } from "@dsh-toolset/tool-surface";
import {
  cordisHost,
  fakeApproval,
  fakePolicyService,
  fakeSandbox,
  mockHost,
  nodeInfo,
  pythonInfo,
  shInfo,
} from "./helpers.ts";

test("bundle 契约：name 与 inject", () => {
  assert.equal(name, "script-interpreter");
  assert.deepEqual(inject, ["tools"]);
});

test("resolveSettings：缺省值（languages 缺省 = 自动探测 / 不审批 / 30s / 10 万 / dsh-script-）", () => {
  const settings = resolveSettings();
  // 未配置语言 = 自动探测（不是固定 ["python"]）。
  assert.equal(settings.languages, undefined);
  assert.equal(settings.approval, "never");
  assert.equal(settings.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(settings.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
  assert.equal(settings.spillPrefix, DEFAULT_SPILL_PREFIX);
  assert.equal(settings.pythonPath, undefined);
  assert.equal(settings.bashPath, undefined);
  assert.equal(settings.nodePath, undefined);
  assert.equal(settings.shPath, undefined);
});

test("resolveSettings：语言去重去空；空数组保留为空；未配置为 undefined", () => {
  assert.deepEqual(
    resolveSettings({ languages: ["python", "python", " "] }).languages,
    ["python"],
  );
  assert.deepEqual(resolveSettings({ languages: [] }).languages, []);
  assert.equal(resolveSettings({}).languages, undefined);
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
  assert.equal(
    resolveSettings({ nodePath: " /opt/node/bin/node " }).nodePath,
    "/opt/node/bin/node",
  );
  assert.equal(resolveSettings({ shPath: " /bin/sh " }).shPath, "/bin/sh");
  assert.equal(resolveSettings({ nodePath: "  " }).nodePath, undefined);
  assert.equal(resolveSettings({ shPath: "" }).shPath, undefined);
});

test("apply：缺省 = 自动探测，探到解释器的语言都进 enum，bash 不参与", () => {
  const host = mockHost();
  apply(host.ctx);
  assert.equal(host.defs.length, 1);
  const tool = host.tool();
  assert.equal(tool.name, TOOL_NAME);
  assert.equal(tool.name, "script_run");
  // 接入包装层后注册定义只剩宽松占位；完整参数面在 toolSurface 服务面
  assert.equal(
    (tool.parameters as Record<string, unknown>)["additionalProperties"],
    true,
  );
  const full = lookupSurface("script_run");
  assert.ok(full !== undefined, "服务面应能取到完整定义");
  const properties = full.parameters["properties"] as Record<
    string,
    Record<string, unknown>
  >;
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
  assert.deepEqual(full.parameters["required"], ["script", "description"]);
  assert.equal(full.parameters["additionalProperties"], false);
  // 探测驱动：enum = 自动集合里真正探到解释器的语言（顺序即 AUTO_LANGUAGES）。
  const probed: Record<string, boolean> = {
    python: pythonInfo() !== null,
    node: nodeInfo() !== null,
    sh: shInfo() !== null,
  };
  const expected = AUTO_LANGUAGES.filter((id) => probed[id] === true);
  const enumIds = (properties.language as { enum?: readonly string[] }).enum;
  assert.deepEqual(enumIds, expected);
  // bash 不参与自动探测：官方 bash 工具已覆盖命令执行面。
  assert.ok(!(enumIds ?? []).includes("bash"));
  assert.ok(
    Object.keys(BACKENDS).includes("bash"),
    "bash 后端仍须保留（显式配置可启用）",
  );
  // 与官方面不重叠：不注册 bash / run_code 等官方工具名。
  const names = host.defs.map((def) => def.name);
  for (const official of ["bash", "run_code", "run_script", "python_exec"]) {
    assert.ok(!names.includes(official), `不应注册官方工具名 ${official}`);
  }
  assert.ok(
    host.logs.some((line) => line.includes("script-interpreter ready")),
  );
});

test("apply：显式 languages 严格按配置（含不参与自动探测的 bash），顺序即缺省语言", () => {
  const host = mockHost();
  apply(host.ctx, { languages: ["python", "bash"] });
  const full = lookupSurface("script_run");
  assert.ok(full !== undefined);
  assert.equal(host.tool().name, "script_run");
  const language = (full.parameters["properties"] as Record<string, unknown>)[
    "language"
  ] as { enum?: readonly string[] };
  assert.deepEqual(language.enum, ["python", "bash"]);
  // 解释器缺失也照常进表（缺失不隐藏工具），故与本机是否装了 bash 无关。
  assert.ok(full.description.includes("缺省语言 = python"), full.description);
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

test("resolveSettings：languages 非数组按未配置处理，小数上限向下取整", () => {
  const settings = resolveSettings({
    languages: "python" as unknown as readonly string[],
    timeoutMs: 1_500.9,
    maxOutputChars: 5.9,
  });
  assert.equal(settings.languages, undefined);
  assert.equal(settings.timeoutMs, 1_500);
  assert.equal(settings.maxOutputChars, 5);
});

test("resolveSettings：落盘前缀的反斜杠与开头的点 / 横线都净化掉", () => {
  assert.equal(
    resolveSettings({ spillPrefix: "\\tmp\\x-" }).spillPrefix,
    "tmp-x-",
  );
  assert.equal(
    resolveSettings({ spillPrefix: "-.hidden-" }).spillPrefix,
    "hidden-",
  );
  assert.equal(
    resolveSettings({ spillPrefix: "/" }).spillPrefix,
    DEFAULT_SPILL_PREFIX,
  );
});

test("apply：显式语言的解释器缺失仍注册，日志给缺失说明与探测痕迹", () => {
  const host = mockHost();
  apply(host.ctx, { languages: ["bash"], bashPath: "/nonexistent/bash" });
  assert.equal(host.defs.length, 1, "缺失不隐藏工具");
  assert.equal(host.tool().name, "script_run");
  assert.ok(
    host.logs.some((line) =>
      line.includes("Bash: 未探测到解释器（调用时返回安装指引）"),
    ),
    host.logs.join("\n"),
  );
  assert.ok(
    host.logs.some(
      (line) =>
        line.includes("探测痕迹") && line.includes("config:/nonexistent/bash"),
    ),
    host.logs.join("\n"),
  );
});

const shApplyTest = (shInfo() === null ? test.skip : test) as (
  name: string,
  fn: () => void,
) => void;

shApplyTest("apply：sh 后端不做版本探测，装载日志不带版本号", () => {
  const host = mockHost();
  apply(host.ctx, { languages: ["sh"] });
  const line = host.logs.find((entry) => entry.includes("sh: "));
  assert.ok(line !== undefined, host.logs.join("\n"));
  assert.match(line, /sh: .+（(?:path|config|env|absolute)/);
  assert.ok(!line.includes(", "), `不应带版本号后缀：${line}`);
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
