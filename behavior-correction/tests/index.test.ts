import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  compileRules,
  matchRule,
  resolveConfig,
  toolText,
  type CompiledRule,
  type RuleSpec,
  type ToolGuardContext,
  type ToolGuardDecision,
} from "../src/index.ts";

/** rule-engine 消费者注册项的结构面. */
interface Registered {
  id: string;
  sources?: readonly string[];
  guard(context: ToolGuardContext): ToolGuardDecision | undefined;
}

/** 捕获 stderr 输出跑一段代码 (结束后恢复, 不改全局状态). */
function captureStderr(run: () => void): string[] {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes;
}

/** 假的 rule-engine: 记录注册项, 注销时计数. */
function makeEngine(): {
  engine: { registerConsumer(input: Registered): () => void };
  registrations: Registered[];
  disposed: () => number;
} {
  const registrations: Registered[] = [];
  let disposedCount = 0;
  return {
    registrations,
    disposed: () => disposedCount,
    engine: {
      registerConsumer(input: Registered): () => void {
        registrations.push(input);
        return () => {
          disposedCount += 1;
        };
      },
    },
  };
}

/** 用 `ctx.get` 提供假引擎. */
function contextWith(engine: {
  registerConsumer(input: Registered): () => void;
}): Record<string, unknown> {
  return {
    get: (service: string) => (service === "ruleEngine" ? engine : undefined),
  };
}

/** 编译一段规则表并返回编译结果与告警. */
function compile(rules: readonly unknown[]): {
  rules: CompiledRule[];
  warnings: string[];
} {
  let result: CompiledRule[] = [];
  const warnings = captureStderr(() => {
    result = compileRules(
      { rules: rules as readonly RuleSpec[] },
      (message) => {
        process.stderr.write(`${message}\n`);
      },
    ).rules;
  });
  return { rules: result, warnings: warnings.map((line) => line.trim()) };
}

/** 跑 apply (给定配置) 并取回唯一注册项. */
function onlyRegistration(registrations: Registered[]): Registered {
  assert.equal(registrations.length, 1, "应当恰好注册一个消费者");
  const [registration] = registrations;
  assert.ok(registration !== undefined);
  return registration;
}

/** 构造 guard 上下文. */
function guardContext(toolName: string, args: unknown): ToolGuardContext {
  return { name: toolName, arguments: args };
}

test("resolveConfig: rules 缺席或 undefined 都回退内置规则表", () => {
  assert.equal(resolveConfig({}).rules.length, 3);
  assert.equal(resolveConfig({ rules: undefined }).rules.length, 3);
  assert.equal(resolveConfig({ enabled: true }).enabled, true);
  // 非法形状按内置规则表兜底 (告警由 compileRules 负责)
  const raw = resolveConfig({ rules: "oops" as unknown as RuleSpec[] });
  assert.equal(raw.rules.length, 3);
  assert.equal(resolveConfig({ rules: [] }).rules.length, 0);
});

test("compileRules: tool 非法 (数字 / 空数组 / 全非法项) → 告警并整条跳过", () => {
  const { rules, warnings } = compile([
    { id: "num", tool: 42, match: { keywords: ["x"] }, reason: "r" },
    { id: "empty", tool: [], match: { keywords: ["x"] }, reason: "r" },
    { id: "junk", tool: [3, ""], match: { keywords: ["x"] }, reason: "r" },
    { id: "ok", tool: "bash", match: { keywords: ["x"] }, reason: "r" },
  ]);
  assert.deepEqual(
    rules.map((rule) => rule.reason),
    ["r"],
  );
  assert.equal(warnings.length, 3);
  for (const expected of ["num", "empty", "junk"]) {
    assert.ok(
      warnings.some(
        (line) =>
          line.includes(expected) &&
          line.includes("tool 不是字符串或字符串数组"),
      ),
      `应当告警规则 ${expected} 的 tool 非法`,
    );
  }
});

test("compileRules: match 非对象 / keywords 与 regex 非字符串数组 → 告警并跳过", () => {
  const { rules, warnings } = compile([
    { id: "bad-match", match: "x", reason: "r1" },
    { id: "kw", match: { keywords: "x" }, reason: "r2" },
    { id: "re", match: { regex: "x" }, reason: "r3" },
    { id: "all-junk", match: { keywords: [3] }, reason: "r4" },
    { id: "ok", match: { keywords: ["x"] }, reason: "ok" },
  ]);
  assert.deepEqual(
    rules.map((rule) => rule.reason),
    ["ok"],
  );
  assert.equal(warnings.length, 4);
  assert.match(warnings[0] ?? "", /bad-match 的 match 不是对象/);
  assert.match(warnings[1] ?? "", /kw 的 match\.keywords 不是字符串数组/);
  assert.match(warnings[2] ?? "", /re 的 match\.regex 不是字符串数组/);
  assert.match(warnings[3] ?? "", /all-junk 的 match\.keywords 不是字符串数组/);
});

test("compileRules: exclude 非对象 / 子项非法 / 正则无效 → 告警并跳过", () => {
  const { rules, warnings } = compile([
    {
      id: "bad-exclude",
      match: { keywords: ["x"] },
      exclude: "x",
      reason: "r1",
    },
    {
      id: "kw",
      match: { keywords: ["x"] },
      exclude: { keywords: "x" },
      reason: "r2",
    },
    {
      id: "re",
      match: { keywords: ["x"] },
      exclude: { regex: "x" },
      reason: "r3",
    },
    {
      id: "bad-re",
      match: { keywords: ["x"] },
      exclude: { regex: ["("] },
      reason: "r4",
    },
    {
      id: "ok",
      match: { keywords: ["x"] },
      exclude: { keywords: ["safe"] },
      reason: "ok",
    },
  ]);
  assert.deepEqual(
    rules.map((rule) => rule.reason),
    ["ok"],
  );
  assert.equal(warnings.length, 4);
  assert.match(warnings[0] ?? "", /bad-exclude 的 exclude 不是对象/);
  assert.match(warnings[1] ?? "", /kw 的 exclude\.keywords 不是字符串数组/);
  assert.match(warnings[2] ?? "", /re 的 exclude\.regex 不是字符串数组/);
  assert.match(warnings[3] ?? "", /bad-re 的 exclude 正则 .* 无效/);
});

test("compileRules: 列表里混入非字符串时只留合法项, 关键词统一转小写", () => {
  const { rules, warnings } = compile([
    {
      id: "mixed",
      tool: ["bash", 7, "pwsh"],
      match: { keywords: ["HerDR", 9], commandNames: ["Node", 3] },
      exclude: { keywords: ["Safe", 5] },
      reason: "r",
    },
    {
      id: "empty-lists",
      match: { keywords: [], regex: [], commandNames: [] },
      exclude: { keywords: [] },
      reason: "永不命中",
    },
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(rules.length, 2);
  const [mixed] = rules;
  assert.deepEqual(mixed?.tools, ["bash", "pwsh"]);
  assert.deepEqual(mixed?.keywords, ["herdr"]);
  // 命令名大小写敏感 (Rscript / node 是不同名字), 不做小写归一
  assert.deepEqual(mixed?.commandNames, ["Node"]);
  assert.deepEqual(mixed?.excludeKeywords, ["safe"]);
  const empty = rules[1];
  assert.deepEqual(empty?.keywords, []);
  assert.deepEqual(empty?.regexes, []);
});

test("compileRules: g / y 从 flags 中去掉, 正则不带状态污染", () => {
  const { rules } = compile([
    {
      id: "no-state",
      tool: "bash",
      match: { regex: ["herdr"], flags: "gi" },
      reason: "r",
    },
    {
      id: "case-sensitive",
      tool: "bash",
      match: { regex: ["herdr"], flags: "g" },
      reason: "s",
    },
  ]);
  const [noState, caseSensitive] = rules;
  assert.equal(noState?.regexes[0]?.flags.includes("g"), false);
  assert.equal(noState?.regexes[0]?.flags.includes("i"), true);
  // 连续判定两次: 若未去掉 g, 第二次会因 lastIndex 归零而漏判
  for (let round = 0; round < 2; round += 1) {
    assert.equal(
      matchRule(rules, guardContext("bash", { command: "HERDR" }))?.reason,
      "r",
      `第 ${round + 1} 次判定`,
    );
  }
  // 显式不带 i 时大小写敏感
  assert.equal(
    matchRule(
      [caseSensitive as CompiledRule],
      guardContext("bash", { command: "HERDR" }),
    ),
    undefined,
  );
});

test("compileRules: match.commandNames 非数组 → 告警并整条跳过", () => {
  const { rules, warnings } = compile([
    { id: "cmds", match: { commandNames: "python" }, reason: "r1" },
    { id: "cmds-junk", match: { commandNames: [3] }, reason: "r2" },
    { id: "ok", match: { commandNames: ["python"] }, reason: "ok" },
  ]);
  assert.deepEqual(
    rules.map((rule) => rule.reason),
    ["ok"],
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /cmds 的 match\.commandNames 不是字符串数组/);
  assert.match(
    warnings[1] ?? "",
    /cmds-junk 的 match\.commandNames 不是字符串数组/,
  );
  assert.deepEqual(rules[0]?.commandNames, ["python"]);
});

test("matchRule: commandNames 与 keywords / regex 取并集, exclude 仍优先弃权", () => {
  const { rules } = compile([
    {
      id: "union",
      tool: "bash",
      match: { commandNames: ["python", "python3"], keywords: ["danger"] },
      exclude: { keywords: ["--safe"] },
      reason: "union",
    },
  ]);
  assert.equal(
    matchRule(rules, guardContext("bash", { command: "python x.py" }))?.reason,
    "union",
    "命令名命中",
  );
  assert.equal(
    matchRule(rules, guardContext("bash", { command: "echo danger" }))?.reason,
    "union",
    "关键词命中",
  );
  assert.equal(
    matchRule(rules, guardContext("bash", { command: "python x.py --safe" })),
    undefined,
    "exclude 命中即弃权",
  );
  assert.equal(
    matchRule(rules, guardContext("bash", { command: "python3.12 x.py" }))
      ?.reason,
    "union",
    "版本后缀算同一命令",
  );
});

test("compileRules: 规则无 id 时告警用序号标签", () => {
  const { warnings } = compile([
    { match: { keywords: ["x"] }, tool: 42, reason: "" },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /规则 #1 缺少 reason/);
});

test("matchRule: tool 限定不匹配直接跳过; 排除关键词命中即弃权", () => {
  const { rules } = compile([
    {
      id: "bash-only",
      tool: "bash",
      match: { keywords: ["danger"] },
      reason: "bash",
    },
    {
      id: "any-tool",
      match: { keywords: ["danger"] },
      exclude: { keywords: ["--safe"] },
      reason: "any",
    },
  ]);
  assert.equal(
    matchRule(rules, guardContext("bash", { command: "danger" }))?.reason,
    "bash",
    "第一条命中胜出",
  );
  assert.equal(
    matchRule(rules, guardContext("read", { path: "danger" }))?.reason,
    "any",
    "read 不在 bash-only 的 tool 限定里, 由第二条接手",
  );
  assert.equal(
    matchRule(rules, guardContext("read", { path: "danger --safe" })),
    undefined,
    "第二条被 exclude 命中即弃权, 后面没有规则",
  );
});

test("matchRule: 空上下文不抛错, 按空工具名与空文本判定", () => {
  const { rules } = compile([
    { id: "any", match: { keywords: ["x"] }, reason: "r" },
  ]);
  assert.equal(
    matchRule(rules, undefined as unknown as ToolGuardContext),
    undefined,
  );
  assert.equal(
    matchRule(rules, null as unknown as ToolGuardContext),
    undefined,
  );
  assert.equal(toolText(undefined as unknown as ToolGuardContext), " ");
  assert.equal(
    toolText(guardContext("bash", { command: null })),
    'bash {"command":null}',
  );
});

test("apply: ctx 为 null / undefined 时告警降级, 不抛给宿主", () => {
  for (const ctx of [null, undefined]) {
    let dispose: (() => void) | undefined;
    const warnings = captureStderr(() => {
      dispose = apply(ctx);
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /ruleEngine 不可用/);
    assert.equal(typeof dispose, "function");
    dispose?.();
  }
});

test("apply: 严格模式直读 ctx.ruleEngine 抛错时回退 ctx.get", () => {
  const fake = makeEngine();
  const warnings = captureStderr(() => {
    apply({
      get: (service: string) =>
        service === "ruleEngine" ? fake.engine : undefined,
      get ruleEngine(): never {
        throw new Error("cannot get property");
      },
    });
  });
  assert.deepEqual(warnings, []);
  onlyRegistration(fake.registrations);
});

test("apply: 直接属性不是注册面时回退 ctx.get; get 返回非注册面则告警", () => {
  const fake = makeEngine();
  const warnings = captureStderr(() => {
    apply({
      ruleEngine: {},
      get: (service: string) =>
        service === "ruleEngine" ? fake.engine : undefined,
    });
  });
  assert.deepEqual(warnings, []);
  onlyRegistration(fake.registrations);

  const missing = captureStderr(() => {
    apply({
      get: (service: string) =>
        service === "ruleEngine" ? { notRegistrar: true } : undefined,
    });
  });
  assert.equal(missing.length, 1);
  assert.match(missing[0] ?? "", /ruleEngine 不可用/);
});

test("apply: registerConsumer 不返回注销函数时, 返回值是可调用的空操作", () => {
  let calls = 0;
  const warnings = captureStderr(() => {
    const dispose = apply({
      ruleEngine: {
        registerConsumer: () => {
          calls += 1;
          return undefined;
        },
      },
    });
    dispose();
    dispose();
  });
  assert.deepEqual(warnings, []);
  assert.equal(calls, 1);
});

test("apply: 宿主不给 ctx.on 时不起订阅, 返回值仍能注销", () => {
  const fake = makeEngine();
  const dispose = apply(contextWith(fake.engine));
  dispose();
  assert.equal(fake.disposed(), 1);
});
