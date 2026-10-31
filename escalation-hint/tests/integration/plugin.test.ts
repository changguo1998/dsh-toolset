import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_COMMAND_TOOLS,
  DEFAULT_FILE_TOOLS,
  name,
  hintMessage,
  resolveConfig,
} from "../../src/index.ts";
import { DENIAL_MARKER_PREFIX, FS_DENIED_CODE } from "../../src/judge.ts";
import {
  POST_EXECUTE,
  assemble,
  contextsOf,
  textOf,
  type DecisionLike,
  type ExecLike,
  type ResultLike,
} from "../assemble.ts";

/** 层 2: 宿主策略拒绝标记 (命令类工具的实现结果). */
const DENIED_COMMAND_RESULT: ResultLike = {
  content: [
    { type: "text", text: `${DENIAL_MARKER_PREFIX}workspace-write mode]` },
  ],
  isError: true,
};

/** 层 2: 文件沙箱错误码 (write 一类工具的实现结果). */
const DENIED_FILE_RESULT: ResultLike = {
  content: [{ type: "text", text: "写入被拒绝" }],
  isError: true,
  error: { code: FS_DENIED_CODE },
};

/** 层 3: 真实 `tool-bash` 返回值形状 (只读文件系统 + git 写). */
const STRUCTURED_DENIAL_RESULT: ResultLike = {
  content: [{ type: "text", text: "fatal: 无法创建 index.lock: 只读文件系统" }],
  value: {
    kind: "foreground",
    cwd: "/w",
    exitCode: 128,
    signal: null,
    stdout: { text: "", truncated: false },
    stderr: { text: "只读文件系统", truncated: false },
    sandbox: { mode: "workspace-write", denied: false, enforcement: "bwrap" },
  },
};

/** 一条命令类工具调用. */
function execOf(
  tool: string,
  callId: string,
  extra: Record<string, unknown> = {},
): ExecLike {
  return {
    name: tool,
    callId,
    arguments: { command: "git commit -m x" },
    ...extra,
  };
}

test("装配: 只订阅 tools/post-execute, 带 prepend, 注销后监听器清零", () => {
  const a = assemble();
  assert.equal(name, "escalation-hint");
  assert.equal(a.handlerCount, 1);
  assert.deepEqual(a.events.subscriptions, [
    { event: POST_EXECUTE, prepend: true },
  ]);
  assert.deepEqual(a.stderr, []);
  a.dispose();
  assert.equal(a.handlerCount, 0);
});

test("事件面: 宿主 waterfall 先给下游决定, 命中后仍返回 accept", async () => {
  const a = assemble();
  let downstream = 0;
  const decision = await a.postExecute(
    execOf("bash", "c1"),
    DENIED_COMMAND_RESULT,
    () => {
      downstream += 1;
      return { kind: "accept" };
    },
  );
  assert.equal(downstream, 1, "先走下游, 再追加附加上下文");
  assert.equal((decision as DecisionLike).kind, "accept");
  assert.equal(contextsOf(decision).length, 1);
  a.dispose();
});

test("命令类: 宿主拒绝标记 → 注入一条 user 消息, 文案带升级参数", async () => {
  const a = assemble();
  const decision = await a.postExecute(
    execOf("bash", "c2"),
    DENIED_COMMAND_RESULT,
    () => ({
      kind: "accept",
    }),
  );
  const [message] = contextsOf(decision);
  assert.equal(message?.["role"], "user");
  assert.equal(typeof message?.["id"], "string");
  assert.deepEqual(message?.["source"], { kind: "escalation-hint" });
  const text = textOf(message!);
  for (const expected of [
    "命令",
    "sandbox_permissions",
    "justification",
    "danger-full-access",
  ]) {
    assert.match(text, new RegExp(expected));
  }
  a.dispose();
});

test("文件类: 沙箱错误码 → 注入文件操作族文案", async () => {
  const a = assemble();
  const decision = await a.postExecute(
    { name: "write", callId: "c3", arguments: { path: "/etc/x" } },
    DENIED_FILE_RESULT,
    () => ({ kind: "accept" }),
  );
  const [message] = contextsOf(decision);
  assert.match(textOf(message!), /文件操作/);
  assert.match(textOf(message!), /sandbox_permissions/);
  a.dispose();
});

test("覆盖的工具类: 缺省名单全线生效, 自定义名单替换缺省", async () => {
  const defaults = assemble();
  for (const tool of [...DEFAULT_COMMAND_TOOLS, ...DEFAULT_FILE_TOOLS]) {
    const exec = { name: tool, callId: `t-${tool}`, arguments: {} };
    const decision = await defaults.postExecute(
      exec,
      DENIED_FILE_RESULT,
      () => ({
        kind: "accept",
      }),
    );
    assert.equal(contextsOf(decision).length, 1, tool);
  }
  defaults.dispose();

  const narrowed = assemble({
    config: { commandTools: ["pwsh"], fileTools: ["edit"] },
  });
  // 被替换掉的缺省名不再命中
  for (const tool of ["bash", "write"]) {
    const decision = await narrowed.postExecute(
      { name: tool, callId: `n-${tool}`, arguments: {} },
      DENIED_FILE_RESULT,
      () => ({ kind: "accept" }),
    );
    assert.equal(contextsOf(decision).length, 0, tool);
  }
  // 配置里留下的名字照常命中
  for (const tool of ["pwsh", "edit"]) {
    const decision = await narrowed.postExecute(
      { name: tool, callId: `k-${tool}`, arguments: {} },
      DENIED_FILE_RESULT,
      () => ({ kind: "accept" }),
    );
    assert.equal(contextsOf(decision).length, 1, tool);
  }
  narrowed.dispose();
});

test("去重: 同 callId 只注入一次, 新 callId 再注入", async () => {
  const a = assemble();
  const bash = execOf("bash", "same");
  const first = await a.postExecute(bash, DENIED_COMMAND_RESULT, () => ({
    kind: "accept",
  }));
  assert.equal(contextsOf(first).length, 1);
  const second = await a.postExecute(bash, DENIED_COMMAND_RESULT, () => ({
    kind: "accept",
  }));
  assert.deepEqual(
    second,
    { kind: "accept" },
    "重复的 callId 原样返回下游决定",
  );
  const other = await a.postExecute(
    execOf("bash", "other"),
    DENIED_COMMAND_RESULT,
    () => ({ kind: "accept" }),
  );
  assert.equal(contextsOf(other).length, 1);
  a.dispose();
});

test("追加而非覆盖: 下游已有的附加上下文保留在前", async () => {
  const a = assemble();
  const kept = { id: "host", role: "user", content: [] };
  const decision = await a.postExecute(
    execOf("bash", "c4"),
    DENIED_COMMAND_RESULT,
    () => ({
      kind: "accept",
      additionalContexts: [kept],
    }),
  );
  const contexts = contextsOf(decision);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0], kept);
  assert.equal(contexts[1]?.["source"] !== undefined, true);
  a.dispose();
});

test("不注入: 宿主已给升级提示 / 下游 block / 无判据", async () => {
  const a = assemble();
  const hinted: ResultLike = {
    content: [
      { type: "text", text: `${DENIAL_MARKER_PREFIX}workspace-write mode]` },
      {
        type: "text",
        text: "[sandbox: escalation available — retry this command once …]",
      },
    ],
  };
  const repeated = await a.postExecute(execOf("bash", "c5"), hinted, () => ({
    kind: "accept",
  }));
  assert.deepEqual(repeated, { kind: "accept" }, "宿主已提示 → 不重复");

  const blocked = await a.postExecute(
    execOf("bash", "c6"),
    DENIED_COMMAND_RESULT,
    () => ({
      kind: "block",
      feedback: [],
    }),
  );
  assert.deepEqual(
    blocked,
    { kind: "block", feedback: [] },
    "下游 block → 不追加",
  );

  const clean = await a.postExecute(
    execOf("bash", "c7"),
    { content: [{ type: "text", text: "ok" }] },
    () => ({ kind: "accept" }),
  );
  assert.deepEqual(clean, { kind: "accept" });
  a.dispose();
});

test("时序: 宿主没给下游决定时自建 accept 承载附加上下文", async () => {
  const a = assemble();
  const decision = await a.postExecute(
    execOf("bash", "c8"),
    DENIED_COMMAND_RESULT,
  );
  assert.equal((decision as DecisionLike).kind, "accept");
  assert.equal(contextsOf(decision).length, 1);
  a.dispose();
});

test("层 3 兜底: 结构化结果命中命令类, 文件类不走该层", async () => {
  const a = assemble();
  const command = await a.postExecute(
    execOf("bash", "c9"),
    STRUCTURED_DENIAL_RESULT,
    () => ({ kind: "accept" }),
  );
  assert.equal(contextsOf(command).length, 1);

  const file = await a.postExecute(
    { name: "write", callId: "c10", arguments: { path: "/etc/x" } },
    STRUCTURED_DENIAL_RESULT,
    () => ({ kind: "accept" }),
  );
  assert.deepEqual(file, { kind: "accept" });
  a.dispose();
});

test("去重表: 超出 maxHints 淘汰最旧, 被淘汰的 callId 可再次提示", async () => {
  const a = assemble({ config: { maxHints: 2 } });
  const run = async (callId: string): Promise<number> => {
    const decision = await a.postExecute(
      execOf("bash", callId),
      DENIED_COMMAND_RESULT,
      () => ({ kind: "accept" }),
    );
    return contextsOf(decision).length;
  };
  assert.equal(await run("a"), 1);
  assert.equal(await run("b"), 1);
  assert.equal(await run("a"), 0);
  assert.equal(await run("c"), 1);
  assert.equal(await run("a"), 1);
  a.dispose();
});

test("配置面: enabled false 不订阅任何事件", () => {
  const a = assemble({ config: { enabled: false } });
  assert.equal(a.handlerCount, 0);
  assert.deepEqual(a.events.subscriptions, []);
  assert.deepEqual(a.loggerWarnings, []);
  a.dispose();
});

test("降级: ctx.on 缺失 → 经 logger 告警一次且可得空注销函数", () => {
  const a = assemble({ events: "missing" });
  assert.equal(a.handlerCount, 0);
  assert.equal(a.loggerWarnings.length, 1);
  assert.match(a.loggerWarnings[0] ?? "", /ctx\.on 不可用/);
  assert.doesNotThrow(() => a.dispose());
});

test("降级: ctx.on 缺失且无 logger → 告警落 stderr", () => {
  const a = assemble({ events: "missing", logger: false });
  assert.equal(a.loggerWarnings.length, 0);
  assert.match(a.stderr.join("\n"), /\[escalation-hint\] warn: ctx\.on 不可用/);
});

test("降级: ctx.on 不返回注销函数 → 返回空操作的注销函数", () => {
  const a = assemble({ events: "noDisposer" });
  assert.equal(a.handlerCount, 1);
  assert.equal(typeof a.dispose, "function");
  assert.doesNotThrow(() => a.dispose());
});

test("hintMessage: 每次注入的 id 不同, 正文来自入参", () => {
  const first = hintMessage({ text: "甲", summary: "s" });
  const second = hintMessage({ text: "乙", summary: "s" });
  assert.notEqual(first["id"], second["id"]);
  assert.equal(textOf(first), "甲");
  assert.equal(textOf(second), "乙");
});

test("resolveConfig: 归一结果直接喂给 apply, 非法值不抛错", () => {
  const resolved = resolveConfig({
    commandTools: ["bash", "", 7] as unknown as string[],
    fileTools: ["write"],
    maxHints: 2.9,
  });
  assert.deepEqual(resolved.commandTools, ["bash"]);
  assert.deepEqual(resolved.fileTools, ["write"]);
  assert.equal(resolved.maxHints, 2);

  const a = assemble({ config: resolved });
  return a
    .postExecute(execOf("bash", "r1"), DENIED_COMMAND_RESULT, () => ({
      kind: "accept",
    }))
    .then((decision) => {
      assert.equal(contextsOf(decision).length, 1);
      a.dispose();
    });
});
