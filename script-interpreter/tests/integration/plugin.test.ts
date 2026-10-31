/**
 * 集成层: 本包 `apply` 与宿主接线 (假工具面 + 假事件面 + 假服务面).
 *
 * 与单元层 (`tests/index.test.ts` / `tests/tool.test.ts`) 的分工: 单元层直接构造 runtime 与
 * 替身; 这里从 `apply` 出发, 经 `ctx.get` 注入沙箱 / 审批服务, 断言工具注册、canonical 值、
 * `output.render` 投影、路径守卫与失败路径。脚本落 `os.tmpdir()` 下的临时工作区, 用后删除。
 *
 * 需要真实解释器 (sh) 的用例按 4.4 条件式 skip: 缺 `sh` 时 skip 并注明缺什么。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import type { ScriptRunResult } from "../../src/types.ts";
import { assemble, defaultServices, type FakeServices } from "../assemble.ts";
import { shInfo } from "../helpers.ts";

const SH = shInfo();
type SimpleTest = (name: string, fn: () => void | Promise<void>) => void;
/** 缺 sh 解释器时整条 skip (条件式 skip, 原因见 4.4). */
const shTest = (SH === null ? test.skip : test) as SimpleTest;

/** 本机 sh 路径 (无解释器时不应触达; 用例已条件式 skip). */
function shPath(): string {
  if (SH === null) throw new Error("需要本机 sh 解释器");
  return SH.path;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null,
    `值应为对象: ${JSON.stringify(value)}`,
  );
  return value as Record<string, unknown>;
}

/** 断言值为预期失败值, 返回 code / error. */
function failure(value: unknown): { code: string; error: string } {
  const record = asRecord(value);
  assert.equal(
    typeof record["error"],
    "string",
    `应为失败值: ${JSON.stringify(value)}`,
  );
  return {
    code: String(record["code"] ?? ""),
    error: String(record["error"]),
  };
}

/** 断言值为成功结果. */
function result(value: unknown): ScriptRunResult {
  const record = asRecord(value);
  assert.equal(
    record["error"],
    undefined,
    `应为成功结果: ${JSON.stringify(value)}`,
  );
  return value as ScriptRunResult;
}

test("apply 接线: 只注册 script_run, 参数面与语言枚举按已启用语言", () => {
  const assembly = assemble({ languages: ["sh"] });
  try {
    assert.equal(assembly.tools.defs.length, 1, "只注册一个工具");
    const tool = assembly.tool();
    assert.equal(tool.name, "script_run");
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
    assert.deepEqual(properties["language"]?.enum, ["sh"]);
    assert.ok(tool.description.includes("缺省语言 = sh"), tool.description);
    // 本包无事件消费者: apply 不订阅任何事件.
    assert.deepEqual(assembly.events.listeners, []);
    assert.ok(
      assembly.logs.some((line) => line.includes("script-interpreter ready")),
      assembly.logs.join("\n"),
    );
    assert.ok(
      assembly.logs.some((line) => line.includes("languages=sh")),
      assembly.logs.join("\n"),
    );
    assert.ok(
      !assembly.logs.some((line) => line.includes("沙箱服务不完整")),
      "服务齐全时不应告警",
    );
    assert.deepEqual(assembly.stderr, []);
  } finally {
    assembly.cleanup();
  }
});

test("apply 接线: 可选服务经受保护读取, 直读未 inject 的服务即抛", () => {
  const assembly = assemble({ languages: ["sh"] });
  try {
    assert.throws(
      () => asRecord(assembly.ctx)["sandbox"],
      /without inject/,
      "假宿主与 cordis 同形: 直读可选服务即抛",
    );
    assert.equal(assembly.tools.defs.length, 1, "装配不崩且照常注册");
    assert.deepEqual(assembly.stderr, []);
  } finally {
    assembly.cleanup();
  }
});

shTest("apply 接线: 没有 ctx.get 的极简宿主按属性回落读取服务", async () => {
  const assembly = assemble({ languages: ["sh"] }, { expose: "property" });
  try {
    const value = result(
      await assembly.call({ script: "printf ok", description: "属性回落" }),
    );
    assert.equal(value.sandbox.confined, true);
    assert.equal(value.sandbox.mode, "workspace-write");
  } finally {
    assembly.cleanup();
  }
});

shTest(
  "execute 接线: 成功执行的 canonical 值与 output.render 投影",
  async () => {
    const assembly = assemble({ languages: ["sh"] });
    try {
      const value = result(
        await assembly.call({
          script: "printf out; printf err >&2",
          description: "两路输出",
        }),
      );
      assert.equal(value.language, "sh");
      assert.equal(value.interpreter, shPath());
      assert.equal(value.exitCode, 0);
      assert.equal(value.signal, null);
      assert.equal(value.timedOut, false);
      assert.equal(value.timeoutMs, 30_000);
      assert.deepEqual(value.stdout, { text: "out", truncated: false });
      assert.deepEqual(value.stderr, { text: "err", truncated: false });
      assert.deepEqual(value.sandbox, {
        confined: true,
        mode: "workspace-write",
        enforcement: "full",
        denied: false,
      });
      assert.equal(assembly.render(value), "out\n[stderr]\nerr");
    } finally {
      assembly.cleanup();
    }
  },
);

shTest("execute 接线: 非零退出码与超时都是脚本结果, 渲染成标记行", async () => {
  const assembly = assemble({ languages: ["sh"] });
  try {
    const failed = result(
      await assembly.call({
        script: "printf boom >&2; exit 7",
        description: "非零退出",
      }),
    );
    assert.equal(failed.exitCode, 7);
    assert.equal(failed.signal, null);
    assert.equal(failed.sandbox.denied, false);
    assert.equal(assembly.render(failed), "[stderr]\nboom\n[exit code: 7]");

    const timed = result(
      await assembly.call({
        script: "sleep 5",
        description: "超时",
        timeoutMs: 100,
      }),
    );
    assert.equal(timed.timedOut, true);
    assert.notEqual(timed.signal, null);
    assert.equal(timed.timeoutMs, 100);
    assert.match(assembly.render(timed), /\[timed out after 100ms\]/);
  } finally {
    assembly.cleanup();
  }
});

test("失败路径: 参数校验 / 未启用语言 / 解释器缺失都返回带 code 的失败值", async () => {
  const assembly = assemble({ languages: ["sh"] });
  try {
    assert.equal(failure(await assembly.call({})).code, "BAD_ARGUMENT");
    assert.equal(
      failure(await assembly.call({ script: "printf x" })).code,
      "BAD_ARGUMENT",
    );
    assert.equal(
      failure(
        await assembly.call({
          script: "printf x",
          description: "d",
          timeoutMs: 0,
        }),
      ).code,
      "BAD_ARGUMENT",
    );
    const notEnabled = failure(
      await assembly.call({
        script: "printf x",
        description: "d",
        language: "python",
      }),
    );
    assert.equal(notEnabled.code, "LANGUAGE_NOT_ENABLED");
    assert.match(notEnabled.error, /可用语言 = sh/);
  } finally {
    assembly.cleanup();
  }

  const missing = assemble({
    languages: ["sh"],
    shPath: "/nonexistent/sh",
  });
  try {
    assert.equal(missing.tools.defs.length, 1, "显式语言的解释器缺失仍注册");
    const value = failure(
      await missing.call({ script: "printf x", description: "缺解释器" }),
    );
    assert.equal(value.code, "INTERPRETER_MISSING");
    assert.match(value.error, /shPath|SCRIPT_SH_INTERPRETER/);
    assert.match(
      missing.render(value),
      /script_run 失败（INTERPRETER_MISSING）/,
    );
  } finally {
    missing.cleanup();
  }
});

shTest(
  "路径守卫: 相对 workdir 按策略根解析, 缺目录 / 非目录给 BAD_ARGUMENT",
  async () => {
    const assembly = assemble({ languages: ["sh"] });
    try {
      mkdirSync(join(assembly.workspace, "sub"), { recursive: true });
      const inside = result(
        await assembly.call({
          script: "pwd",
          description: "相对目录",
          workdir: "sub",
        }),
      );
      assert.equal(
        realpathSync(inside.stdout.text.trim()),
        realpathSync(join(assembly.workspace, "sub")),
      );

      const missing = failure(
        await assembly.call({
          script: "pwd",
          description: "缺目录",
          workdir: "missing",
        }),
      );
      assert.equal(missing.code, "BAD_ARGUMENT");
      assert.match(missing.error, /工作目录不存在/);
      assert.ok(
        missing.error.includes(join(assembly.workspace, "missing")),
        missing.error,
      );

      writeFileSync(join(assembly.workspace, "plain.txt"), "x", "utf8");
      const notDir = failure(
        await assembly.call({
          script: "pwd",
          description: "非目录",
          workdir: "plain.txt",
        }),
      );
      assert.equal(notDir.code, "BAD_ARGUMENT");
      assert.match(notDir.error, /工作目录不是目录/);
    } finally {
      assembly.cleanup();
    }
  },
);

shTest(
  "路径守卫: spillPrefix 净化后只在临时根下建目录, 回执带落盘路径",
  async () => {
    const assembly = assemble({
      languages: ["sh"],
      spillPrefix: "../evil/",
      maxOutputChars: 8,
    });
    try {
      const value = result(
        await assembly.call({
          script: "printf 0123456789abcdef",
          description: "超限落盘",
        }),
      );
      assert.equal(value.stdout.truncated, true);
      const spillPath = value.stdout.spillPath;
      assert.ok(spillPath !== undefined, "截断时应给出落盘路径");
      assert.ok(spillPath.startsWith(tmpdir()), spillPath);
      assert.ok(
        basename(dirname(dirname(spillPath))).startsWith("evil-"),
        `落盘根前缀应被净化为 evil-: ${spillPath}`,
      );
      assert.match(assembly.render(value), /\[output truncated; full output: /);
      // 落盘不自动删 (可审计): 用例结束时收掉本次产生的根.
      rmSync(dirname(dirname(spillPath)), { recursive: true, force: true });
    } finally {
      assembly.cleanup();
    }
  },
);

shTest(
  "沙箱接线: 策略解析失败降级标注, confine 失败 fail-closed 且不执行",
  async () => {
    const degraded = assemble(
      { languages: ["sh"] },
      {
        services: {
          sandboxPolicy: {
            resolve() {
              throw new Error("policy boom");
            },
          },
        },
      },
    );
    try {
      const value = result(
        await degraded.call({ script: "printf ok", description: "策略失败" }),
      );
      assert.equal(value.sandbox.confined, false);
      assert.equal(value.sandbox.denied, false);
      assert.match(value.sandbox.unavailable ?? "", /沙箱策略解析失败/);
      assert.equal(degraded.render(value), "ok", "能力缺失不进回执正文");
    } finally {
      degraded.cleanup();
    }

    const blocker = assemble(
      { languages: ["sh"] },
      {
        services: (workspace): FakeServices => ({
          sandboxPolicy: {
            resolve: () => ({ mode: "read-only", workspaceRoot: workspace }),
          },
          sandbox: {
            async confine() {
              throw new Error("no usable runner");
            },
          },
        }),
      },
    );
    try {
      const value = failure(
        await blocker.call({
          script: "printf x > blocked.txt",
          description: "围栏失败",
        }),
      );
      assert.equal(value.code, "SANDBOX_UNAVAILABLE");
      assert.match(value.error, /no usable runner/);
      assert.equal(
        existsSync(join(blocker.workspace, "blocked.txt")),
        false,
        "围栏失败时脚本未执行",
      );
    } finally {
      blocker.cleanup();
    }
  },
);

shTest("沙箱接线: 服务全缺时装载日志告警, 结果值标注未围栏", async () => {
  const assembly = assemble({ languages: ["sh"] }, { services: "none" });
  try {
    assert.ok(
      assembly.logs.some((line) => line.includes("沙箱服务不完整")),
      assembly.logs.join("\n"),
    );
    const value = result(
      await assembly.call({ script: "printf ok", description: "无服务" }),
    );
    assert.equal(value.sandbox.confined, false);
    assert.match(value.sandbox.unavailable ?? "", /ctx.sandboxPolicy/);
    assert.equal(assembly.render(value), "ok");
  } finally {
    assembly.cleanup();
  }
});

shTest("审批接线: approval ask 经宿主服务放行, 拒绝即不执行", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const allowed = assemble(
    { languages: ["sh"], approval: "ask" },
    {
      services: (workspace): FakeServices => ({
        ...defaultServices(workspace),
        approval: {
          async request(req) {
            calls.push({ ...req });
            return "allowed-once";
          },
        },
      }),
    },
  );
  try {
    const value = result(
      await allowed.call(
        { script: "printf ok", description: "审批放行" },
        {
          agent: {
            session: { id: "s-int", header: { cwd: allowed.workspace } },
          },
          callId: "call-int",
        },
      ),
    );
    assert.equal(value.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.["toolName"], "script_run");
    assert.equal(calls[0]?.["callId"], "call-int");
    assert.match(String(calls[0]?.["reason"]), /执行 sh 脚本：审批放行/);
  } finally {
    allowed.cleanup();
  }

  const denied = assemble(
    { languages: ["sh"], approval: "ask" },
    {
      services: (workspace): FakeServices => ({
        ...defaultServices(workspace),
        approval: {
          async request() {
            return "rejected";
          },
        },
      }),
    },
  );
  try {
    const value = failure(
      await denied.call(
        { script: "printf no", description: "审批拒绝" },
        { agent: { session: { id: "s-int" } } },
      ),
    );
    assert.equal(value.code, "APPROVAL_DENIED");
  } finally {
    denied.cleanup();
  }
});

test("装配降级: 空语言表 / 未知语言 / 无工具面都不注册工具并告警", () => {
  const empty = assemble({ languages: [] });
  try {
    assert.equal(empty.tools.defs.length, 0);
    assert.ok(
      empty.logs.some((line) => line.includes("不注册 script_run")),
      empty.logs.join("\n"),
    );
  } finally {
    empty.cleanup();
  }

  const unknown = assemble({ languages: ["ruby"] });
  try {
    assert.equal(unknown.tools.defs.length, 0, "全部未识别时不注册");
    assert.ok(
      unknown.logs.some((line) => line.includes("未知语言 ruby")),
      unknown.logs.join("\n"),
    );
  } finally {
    unknown.cleanup();
  }

  const noTools = assemble({ languages: ["sh"] }, { tools: false });
  try {
    assert.equal(noTools.tools.defs.length, 0);
    assert.ok(
      noTools.logs.some((line) => line.includes("ctx.tools 不可用")),
      noTools.logs.join("\n"),
    );
  } finally {
    noTools.cleanup();
  }
});

test("日志回落: logger 缺 warn 时时钟告警写 stderr", () => {
  const assembly = assemble(
    { languages: ["sh"] },
    { logger: "without-warn", services: "none" },
  );
  try {
    assert.ok(
      assembly.logs.some((line) => line.includes("script-interpreter ready")),
      assembly.logs.join("\n"),
    );
    // 沙箱告警走 logger?.warn?.(...)（缺 warn 即静默）；只有 resolveClock 的告警
    // 走本地 warn 兜底，落到 stderr。
    assert.ok(
      assembly.stderr.some((line) => line.includes("clock 服务不可用")),
      assembly.stderr.join(""),
    );
    assert.ok(
      !assembly.stderr.some((line) => line.includes("沙箱服务不完整")),
      "沙箱告警不写 stderr（logger 存在但缺 warn）",
    );
  } finally {
    assembly.cleanup();
  }
});

test("apply 接线: 配置的 maxOutputChars 与 timeoutMs 进入 schema 描述", () => {
  const assembly = assemble({
    languages: ["sh"],
    timeoutMs: 1_000,
    maxOutputChars: 500,
  });
  try {
    const tool = assembly.tool();
    const properties = tool.parameters.properties as Record<
      string,
      { description?: string }
    >;
    assert.match(
      properties["timeoutMs"]?.description ?? "",
      /缺省 1000，上限 600000/,
    );
  } finally {
    assembly.cleanup();
  }
});
