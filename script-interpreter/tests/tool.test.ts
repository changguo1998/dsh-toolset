/**
 * 工具面测试：schema 与硬拒层对拍、参数校验顺序、语言与解释器降级、审批、
 * 沙箱围栏（拒绝 / 运行器失败 / 能力缺失 / danger-full-access / fail-closed）、回执渲染。
 *
 * 需要真实解释器的用例走 `pyTest`（无 Python 时 skip）；纯逻辑用例恒跑。
 */

import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { apply } from "../src/index.ts";
import { pythonBackend } from "../src/langs/python.ts";
import { NO_OUTPUT, renderFailure, renderScriptValue } from "../src/render.ts";
import { createScriptRunTool, TOOL_NAME } from "../src/tools.ts";
import type { ToolDef } from "../src/tools.ts";
import type { ScriptRunResult } from "../src/types.ts";
import {
  cordisHost,
  explodingApproval,
  fakeApproval,
  fakePolicyService,
  fakeSandbox,
  makeRuntime,
  pythonInfo,
  withTempDir,
} from "./helpers.ts";

const PY = pythonInfo();
type SimpleTest = (name: string, fn: () => void | Promise<void>) => void;
const pyTest = (PY === null ? test.skip : test) as SimpleTest;

/** 本机 Python 路径（无解释器时直接失败，用于 skip 不该触达的分支）。 */
function pythonPath(): string {
  if (PY === null) throw new Error("需要本机 Python 解释器");
  return PY.path;
}

/** 本工具与后端同口径的 argv。 */
function pythonArgv(): string[] {
  return [pythonPath(), "-u", "-"];
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null,
    `值应为对象：${JSON.stringify(value)}`,
  );
  return value as Record<string, unknown>;
}

/** 断言值为预期失败值，返回 code / error。 */
function failure(value: unknown): { code: string; error: string } {
  const record = asRecord(value);
  assert.equal(
    typeof record.error,
    "string",
    `应为失败值：${JSON.stringify(value)}`,
  );
  return { code: String(record.code ?? ""), error: String(record.error) };
}

/** 断言值为成功结果。 */
function result(value: unknown): ScriptRunResult {
  const record = asRecord(value);
  assert.equal(
    record.error,
    undefined,
    `应为成功结果：${JSON.stringify(value)}`,
  );
  return value as ScriptRunResult;
}

/** 取工具回执文本。 */
function renderText(tool: ToolDef, value: unknown): string {
  return tool.output
    .render({}, value)
    .map((block) => block.text)
    .join("\n");
}

/** 只有「没有解释器」的最小 runtime（参数校验用例不触达进程）。 */
function noInterpreterRuntime() {
  return makeRuntime({
    languages: [{ backend: pythonBackend, interpreter: null }],
  });
}

test("schema：参数面与硬拒层登记的 script 键对拍，语言枚举只含已启用项", () => {
  const tool = createScriptRunTool(makeRuntime());
  assert.equal(tool.name, "script_run");
  assert.equal(TOOL_NAME, "script_run");
  assert.deepEqual(tool.parameters.required, ["script", "description"]);
  assert.equal(tool.parameters.additionalProperties, false);
  const properties = tool.parameters.properties as Record<
    string,
    { enum?: readonly string[] }
  >;
  assert.deepEqual(Object.keys(properties).sort(), [
    "description",
    "language",
    "script",
    "timeoutMs",
    "workdir",
  ]);
  assert.deepEqual(properties.language?.enum, ["python"]);
  // 不暴露提权与后台作业参数（决策 7 / 首期不做后台作业）。
  assert.ok(!("sandbox_permissions" in properties));
  assert.ok(!("justification" in properties));
  assert.ok(!("run_in_background" in properties));
  // 描述里写清脚本入口（stdin）与回执口径（模型可见）。
  assert.ok(tool.description.includes("stdin"), tool.description);
  assert.ok(tool.description.includes("[exit code: N]"), tool.description);
});

test("参数校验：script / description 空串即报错，不触达进程", async () => {
  const tool = createScriptRunTool(noInterpreterRuntime());
  const noScript = failure(await tool.execute({}));
  assert.equal(noScript.code, "BAD_ARGUMENT");
  assert.ok(noScript.error.includes("script"), noScript.error);
  const noDescription = failure(await tool.execute({ script: "print(1)" }));
  assert.equal(noDescription.code, "BAD_ARGUMENT");
  assert.ok(noDescription.error.includes("description"));
  const blankScript = failure(
    await tool.execute({ script: "   ", description: "x" }),
  );
  assert.equal(blankScript.code, "BAD_ARGUMENT");
  const blankDescription = failure(
    await tool.execute({ script: "print(1)", description: "  " }),
  );
  assert.equal(blankDescription.code, "BAD_ARGUMENT");
});

test("语言：传未启用的 bash 明确报错并列出可用语言，不静默回落", async () => {
  const tool = createScriptRunTool(noInterpreterRuntime());
  const value = failure(
    await tool.execute({
      script: "echo hi",
      description: "试 bash",
      language: "bash",
    }),
  );
  assert.equal(value.code, "LANGUAGE_NOT_ENABLED");
  assert.ok(value.error.includes("bash"), value.error);
  assert.ok(value.error.includes("python"), value.error);
});

test("超时：非正数报错（参数校验先于能力检查）", async () => {
  const tool = createScriptRunTool(noInterpreterRuntime());
  const value = failure(
    await tool.execute({ script: "print(1)", description: "x", timeoutMs: 0 }),
  );
  assert.equal(value.code, "BAD_ARGUMENT");
  assert.ok(value.error.includes("timeoutMs"), value.error);
});

test("工作目录：不存在时明确报错", async () => {
  const tool = createScriptRunTool(noInterpreterRuntime());
  const value = failure(
    await tool.execute({
      script: "print(1)",
      description: "x",
      workdir: "no-such-dir",
    }),
  );
  assert.equal(value.code, "BAD_ARGUMENT");
  assert.ok(value.error.includes("工作目录不存在"), value.error);
});

test("解释器缺失：返回含安装指引的错误（工具仍可用）", async () => {
  const tool = createScriptRunTool(noInterpreterRuntime());
  const value = failure(
    await tool.execute({ script: "print(1)", description: "缺解释器" }),
  );
  assert.equal(value.code, "INTERPRETER_MISSING");
  assert.ok(value.error.includes("python3"), value.error);
  assert.ok(value.error.includes("SCRIPT_PY_INTERPRETER"), value.error);
});

pyTest(
  "执行：非零退出码如实回传，回执带 [exit code: N]，不是工具错误",
  async () => {
    const tool = createScriptRunTool(makeRuntime());
    const value = result(
      await tool.execute({
        script: "import sys\nsys.exit(3)\n",
        description: "退出码三",
      }),
    );
    assert.equal(value.exitCode, 3);
    assert.equal(value.signal, null);
    assert.equal(value.language, "python");
    assert.equal(value.interpreter, pythonPath());
    const text = renderText(tool, value);
    assert.ok(text.includes("[exit code: 3]"), text);
  },
);

pyTest("执行：stderr 独立成段，无输出给占位", async () => {
  const tool = createScriptRunTool(makeRuntime());
  const withErr = result(
    await tool.execute({
      script: "import sys\nprint('err', file=sys.stderr)\n",
      description: "只有 stderr",
    }),
  );
  const text = renderText(tool, withErr);
  assert.ok(text.startsWith("[stderr]\n"), text);
  const empty = result(
    await tool.execute({ script: "pass", description: "空输出" }),
  );
  assert.equal(renderText(tool, empty), NO_OUTPUT);
});

pyTest("执行：workdir 相对路径按策略根解析", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const policy = fakePolicyService({
      mode: "danger-full-access",
      workspaceRoot: dir,
    });
    const tool = createScriptRunTool(
      makeRuntime({ host: { sandboxPolicy: policy.service } }),
    );
    const value = result(
      await tool.execute({
        script: "import os\nprint(os.getcwd())\n",
        description: "打印 cwd",
        workdir: ".",
      }),
    );
    assert.equal(value.stdout.text.trim(), realpathSync(dir));
  } finally {
    cleanup();
  }
});

pyTest("执行：超时回执带 [timed out after Nms]", async () => {
  const tool = createScriptRunTool(
    makeRuntime({ settings: { timeoutMs: 300 } }),
  );
  const value = result(
    await tool.execute({
      script: "import time\ntime.sleep(30)\n",
      description: "超时",
    }),
  );
  assert.equal(value.timedOut, true);
  assert.equal(value.timeoutMs, 300);
  assert.ok(renderText(tool, value).includes("[timed out after 300ms]"));
});

pyTest("执行：超限保留尾部，回执给落盘路径", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const tool = createScriptRunTool(
      makeRuntime({ settings: { maxOutputChars: 40 }, spillRoot: dir }),
    );
    const value = result(
      await tool.execute({
        script: 'print("x" * 500)',
        description: "大输出",
      }),
    );
    assert.equal(value.stdout.truncated, true);
    const spillPath = value.stdout.spillPath;
    assert.ok(spillPath !== undefined);
    assert.ok(existsSync(spillPath));
    assert.ok(
      renderText(tool, value).includes("[output truncated; full output: "),
    );
  } finally {
    cleanup();
  }
});

pyTest("执行：timeoutMs 超过上限按上限执行", async () => {
  const tool = createScriptRunTool(makeRuntime());
  const value = result(
    await tool.execute({
      script: "print(1)",
      description: "上限钳位",
      timeoutMs: 10_000_000,
    }),
  );
  assert.equal(value.timeoutMs, 600_000);
});

pyTest("沙箱：拒绝方言命中时标 denied 并给围栏模式", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const policy = fakePolicyService({ mode: "read-only", workspaceRoot: dir });
    const sandbox = fakeSandbox({
      argv: pythonArgv(),
      enforcement: "full",
      denialSignatures: ["read-only file system"],
      runnerFailureRules: [],
    });
    const tool = createScriptRunTool(
      makeRuntime({
        host: { sandbox: sandbox.provider, sandboxPolicy: policy.service },
      }),
    );
    const value = result(
      await tool.execute({
        script:
          "import sys\nprint('read-only file system', file=sys.stderr)\nsys.exit(1)\n",
        description: "造一次拒绝",
      }),
    );
    assert.equal(value.sandbox.confined, true);
    assert.equal(value.sandbox.denied, true);
    assert.equal(value.sandbox.mode, "read-only");
    assert.equal(value.sandbox.enforcement, "full");
    assert.equal(value.sandbox.unavailable, undefined);
    assert.ok(
      renderText(tool, value).includes(
        "[sandbox: file access denied under read-only mode]",
      ),
    );
  } finally {
    cleanup();
  }
});

pyTest("沙箱：运行器自身失败 fail-closed，不当成脚本错误", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const policy = fakePolicyService({
      mode: "workspace-write",
      workspaceRoot: dir,
    });
    const sandbox = fakeSandbox({
      argv: pythonArgv(),
      enforcement: "full",
      denialSignatures: [],
      runnerFailureRules: [{ fatalSignatures: ["sandbox runner failed"] }],
    });
    const tool = createScriptRunTool(
      makeRuntime({
        host: { sandbox: sandbox.provider, sandboxPolicy: policy.service },
      }),
    );
    const value = failure(
      await tool.execute({
        script:
          "import sys\nprint('sandbox runner failed', file=sys.stderr)\nsys.exit(1)\n",
        description: "造运行器失败",
      }),
    );
    assert.equal(value.code, "SANDBOX_UNAVAILABLE");
    assert.ok(value.error.includes("沙箱运行器自身失败"), value.error);
  } finally {
    cleanup();
  }
});

pyTest("沙箱：confine 抛错时 fail-closed 且脚本未执行", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const policy = fakePolicyService({ mode: "read-only", workspaceRoot: dir });
    const sandbox = fakeSandbox(new Error("no usable runner"));
    const tool = createScriptRunTool(
      makeRuntime({
        host: { sandbox: sandbox.provider, sandboxPolicy: policy.service },
      }),
    );
    const marker = join(dir, "ran.txt");
    const value = failure(
      await tool.execute({
        script: `open(${JSON.stringify(marker)}, "w").write("x")`,
        description: "不应执行",
      }),
    );
    assert.equal(value.code, "SANDBOX_UNAVAILABLE");
    assert.ok(value.error.includes("no usable runner"), value.error);
    assert.equal(existsSync(marker), false);
  } finally {
    cleanup();
  }
});

pyTest(
  "沙箱：缺服务时在结果值里标注 unconfined，回执正文不加提示行",
  async () => {
    const tool = createScriptRunTool(makeRuntime());
    const value = result(
      await tool.execute({ script: "print(1)", description: "无沙箱" }),
    );
    // 事实进结构化结果（决策 4 的「在结果里标」），不静默。
    assert.equal(value.sandbox.confined, false);
    assert.equal(value.sandbox.denied, false);
    assert.equal(typeof value.sandbox.unavailable, "string");
    assert.ok(value.sandbox.unavailable?.includes("ctx.sandboxPolicy"));
    // 回执正文只列决策 6 的标记与围栏拒绝提示，能力缺失不占行。
    const text = renderText(tool, value);
    assert.equal(text, "1\n");
    assert.ok(!text.includes("[sandbox:"), text);
  },
);

pyTest("沙箱：danger-full-access 不围栏、不标缺失", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const policy = fakePolicyService({
      mode: "danger-full-access",
      workspaceRoot: dir,
    });
    const sandbox = fakeSandbox({ argv: ["/nonexistent"] });
    const tool = createScriptRunTool(
      makeRuntime({
        host: { sandbox: sandbox.provider, sandboxPolicy: policy.service },
      }),
    );
    const value = result(
      await tool.execute({ script: "print(1)", description: "全权" }),
    );
    assert.equal(value.sandbox.confined, false);
    assert.equal(value.sandbox.mode, "danger-full-access");
    assert.equal(value.sandbox.unavailable, undefined);
    assert.equal(sandbox.calls.length, 0);
  } finally {
    cleanup();
  }
});

pyTest(
  "装配：cordis 直读会抛的宿主下也能执行，且围栏事实经 ctx.get 传入",
  async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const host = cordisHost({
        sandbox: fakeSandbox({ argv: [] }).provider,
        sandboxPolicy: fakePolicyService({
          mode: "danger-full-access",
          workspaceRoot: dir,
        }).service,
      });
      apply(host.ctx);
      const value = result(
        await host
          .tool()
          .execute({ script: "print(1)", description: "守卫下的装配" }),
      );
      assert.equal(value.sandbox.mode, "danger-full-access");
      assert.equal(value.sandbox.unavailable, undefined);
    } finally {
      cleanup();
    }
  },
);

pyTest("审批：缺省 never 不请求审批", async () => {
  const approval = explodingApproval();
  const tool = createScriptRunTool(
    makeRuntime({ host: { approval: approval.service } }),
  );
  const value = result(
    await tool.execute({ script: "print(1)", description: "不审批" }),
  );
  assert.equal(value.exitCode, 0);
  assert.equal(approval.calls.length, 0);
});

pyTest("审批：ask 被拒即不执行", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const approval = fakeApproval("rejected");
    const tool = createScriptRunTool(
      makeRuntime({
        settings: { approval: "ask" },
        host: { approval: approval.service },
      }),
    );
    const marker = join(dir, "ran.txt");
    const value = failure(
      await tool.execute(
        {
          script: `open(${JSON.stringify(marker)}, "w").write("x")`,
          description: "被拒",
        },
        {
          agent: { session: { id: "s1", header: { cwd: dir } } },
          callId: "call-1",
        },
      ),
    );
    assert.equal(value.code, "APPROVAL_DENIED");
    assert.equal(approval.calls.length, 1);
    assert.equal(approval.calls[0]?.toolName, "script_run");
    assert.equal(approval.calls[0]?.callId, "call-1");
    assert.equal(existsSync(marker), false);
  } finally {
    cleanup();
  }
});

pyTest("审批：ask 且 allowed-once 才执行", async () => {
  const approval = fakeApproval("allowed-once");
  const tool = createScriptRunTool(
    makeRuntime({
      settings: { approval: "ask" },
      host: { approval: approval.service },
    }),
  );
  const value = result(
    await tool.execute(
      { script: "print(1)", description: "放行" },
      { agent: { session: { id: "s1" } } },
    ),
  );
  assert.equal(value.exitCode, 0);
  assert.equal(approval.calls.length, 1);
});

pyTest("审批：ask 但没有 ctx.approval 时 fail-closed", async () => {
  const tool = createScriptRunTool(
    makeRuntime({ settings: { approval: "ask" } }),
  );
  const value = failure(
    await tool.execute(
      { script: "print(1)", description: "缺审批服务" },
      { agent: { session: { id: "s1" } } },
    ),
  );
  assert.equal(value.code, "APPROVAL_UNAVAILABLE");
});

test("渲染：失败值带 code，畸形值退化为占位（全函数）", () => {
  assert.ok(renderFailure({ error: "boom", code: "C1" }).includes("C1"));
  assert.deepEqual(renderScriptValue({}, null), [
    { type: "text", text: NO_OUTPUT },
  ]);
  const rendered = renderScriptValue({}, { error: "boom" });
  assert.ok(rendered[0]?.text.includes("boom"), JSON.stringify(rendered));
});
