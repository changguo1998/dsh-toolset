import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  compileRules,
  GUARD_SOURCE,
  inject,
  matchRule,
  name,
  resolveConfig,
  toolText,
  type Config,
  type RuleSpec,
  type ToolGuardContext,
  type ToolGuardDecision,
} from "../src/main.ts";

/** rule-engine 消费者注册项的结构面（与 src/main.ts 的声明对齐） */
interface Registered {
  id: string;
  sources?: readonly string[];
  guard(context: ToolGuardContext): ToolGuardDecision | undefined;
}

/** 捕获 stderr 输出跑一段代码（结束后恢复，不改全局状态） */
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

/** 假的 rule-engine：记录注册项，注销时计数 */
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

/** 只取唯一注册项（没注册或多注册都直接失败） */
function onlyRegistration(registrations: Registered[]): Registered {
  assert.equal(registrations.length, 1, "应当恰好注册一个消费者");
  const [registration] = registrations;
  assert.ok(registration !== undefined);
  return registration;
}

/** 用 `ctx.get` 提供假引擎（结构面驱动，不需要真的 cordis 注入） */
function contextWith(
  engine: { registerConsumer(input: Registered): () => void },
  on?: (event: string, listener: () => void) => unknown,
): Record<string, unknown> {
  return {
    get: (service: string) => (service === "ruleEngine" ? engine : undefined),
    ...(on === undefined ? {} : { on }),
  };
}

/** 跑 apply（缺省配置）并取回注册项 */
function registerDefault(config?: Config): Registered {
  const fake = makeEngine();
  apply(contextWith(fake.engine), config);
  return onlyRegistration(fake.registrations);
}

/** 构造 guard 上下文 */
function guardContext(toolName: string, args: unknown): ToolGuardContext {
  return { name: toolName, arguments: args };
}

test("契约符号：name / inject / GUARD_SOURCE", () => {
  assert.equal(name, "behavior-correction");
  // 2026-10-22 真机修正：ruleEngine 升为硬依赖（apply 早于 provide 会拿不到服务）
  assert.deepEqual(inject, ["ruleEngine"]);
  assert.equal(GUARD_SOURCE, "tools/pre-execute");
});

test("resolveConfig：缺省开启 + 内置规则；rules 给即整体替换；空数组保留", () => {
  const defaults = resolveConfig();
  assert.equal(defaults.enabled, true);
  assert.deepEqual(
    defaults.rules.map((rule) => rule.id),
    ["no-herdr-in-bash", "no-python-in-bash"],
  );
  assert.equal(resolveConfig({ enabled: false }).enabled, false);

  const custom: RuleSpec[] = [
    { id: "custom", tool: "read", match: { keywords: ["x"] }, reason: "r" },
  ];
  assert.deepEqual(
    resolveConfig({ rules: custom }).rules.map((rule) => rule.id),
    ["custom"],
  );
  assert.deepEqual(resolveConfig({ rules: [] }).rules, []);
});

test("缺省规则：bash 里跑 herdr → 拒绝并指向 herdr_pane", () => {
  const registration = registerDefault();
  assert.equal(registration.id, "behavior-correction");
  assert.deepEqual(registration.sources, ["tools/pre-execute"]);

  const decision = registration.guard(
    guardContext("bash", { command: "herdr pane list" }),
  );
  assert.equal(decision?.kind, "deny");
  assert.match(
    (decision as { reason: string }).reason,
    /herdr_pane/,
    "拒绝理由要指向专用工具",
  );
});

test("缺省规则：bash 里的普通命令放行（返回 undefined，不是 allow）", () => {
  const registration = registerDefault();
  const decision = registration.guard(
    guardContext("bash", { command: "ls -la src" }),
  );
  assert.equal(decision, undefined);
});

test("缺省规则只看命令位：正文里提到该词不拦", () => {
  const registration = registerDefault();
  for (const command of [
    "echo herdr",
    'git commit -m "docs: herdr CLI 迁移"',
    "grep herdr src/*.ts",
    "printf 'herdr\n' >> notes.txt",
  ]) {
    assert.equal(
      registration.guard(guardContext("bash", { command })),
      undefined,
      command,
    );
  }
});

test("缺省规则认命令位变体：链式 / 前置赋值 / 绝对路径 / 子 shell", () => {
  const registration = registerDefault();
  for (const command of [
    "herdr",
    "herdr pane list",
    "ls && herdr pane list",
    "FOO=1 PATH=/usr/bin herdr pane list",
    "/usr/bin/herdr pane list",
    "x=$(herdr pane list)",
  ]) {
    assert.equal(
      registration.guard(guardContext("bash", { command }))?.kind,
      "deny",
      command,
    );
  }
});

test("缺省规则：bash 命令位跑 python → 拒绝并指向 script_run", () => {
  const registration = registerDefault();
  for (const command of [
    "python x.py",
    "python3 -c 'print(1)'",
    "python3.12 tools/gen.py",
    "ls && python3 -V",
    "FOO=1 /usr/bin/python3 -m http.server",
  ]) {
    const decision = registration.guard(guardContext("bash", { command }));
    assert.equal(decision?.kind, "deny", command);
    assert.match(
      (decision as { reason: string }).reason,
      /script_run/,
      "拒绝理由要指向 script_run",
    );
  }
});

test("缺省规则：正文提到 python / .py 扩展名 / pip 不拦", () => {
  const registration = registerDefault();
  for (const command of [
    "echo python",
    "grep -rn python3 src/",
    "ls scripts/run.py",
    "pip install requests",
    "git commit -m 'docs: python -> script_run'",
  ]) {
    assert.equal(
      registration.guard(guardContext("bash", { command })),
      undefined,
      command,
    );
  }
});

test("缺省规则只限定 bash：read 参数里带 herdr 不命中", () => {
  const registration = registerDefault();
  assert.equal(
    registration.guard(guardContext("read", { path: "herdr/README.md" })),
    undefined,
  );
});

test("关键词大小写不敏感", () => {
  const registration = registerDefault();
  const decision = registration.guard(
    guardContext("bash", { command: "HERDR pane list" }),
  );
  assert.equal(decision?.kind, "deny");
});

test("配置替换：自定义规则生效，内置规则不再生效", () => {
  const registration = registerDefault({
    rules: [
      {
        id: "no-secret-read",
        tool: "read",
        match: { keywords: ["secret"] },
        reason: "敏感文件请走 fs_digest 以外的专用流程",
      },
    ],
  });
  assert.equal(
    registration.guard(guardContext("bash", { command: "herdr pane list" })),
    undefined,
    "内置 herdr 规则已被整体替换",
  );
  const decision = registration.guard(
    guardContext("read", { path: "/tmp/secret.txt" }),
  );
  assert.equal(decision?.kind, "deny");
  assert.match((decision as { reason: string }).reason, /专用流程/);
});

test("rules: [] 不拦任何东西", () => {
  const registration = registerDefault({ rules: [] });
  assert.equal(
    registration.guard(guardContext("bash", { command: "herdr pane list" })),
    undefined,
  );
});

test("enabled: false 不注册消费者，返回幂等的注销函数", () => {
  const fake = makeEngine();
  let dispose: (() => void) | undefined;
  const warnings = captureStderr(() => {
    dispose = apply(contextWith(fake.engine), { enabled: false });
  });
  assert.equal(fake.registrations.length, 0);
  assert.deepEqual(warnings, []);
  assert.equal(typeof dispose, "function");
  dispose?.();
  dispose?.();
  assert.equal(fake.disposed(), 0);
});

test("非法正则：告警 + 该条跳过，其余规则照常", () => {
  const fake = makeEngine();
  const warnings = captureStderr(() => {
    apply(contextWith(fake.engine), {
      rules: [
        {
          id: "bad-regex",
          tool: "bash",
          match: { regex: ["("] },
          reason: "坏正则",
        },
        {
          id: "good-regex",
          tool: "bash",
          match: { regex: ["^herdr\\b"] },
          reason: "该改用 herdr_pane",
        },
      ],
    });
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /bad-regex/);
  assert.match(warnings[0] ?? "", /整条规则跳过/);

  const registration = onlyRegistration(fake.registrations);
  const decision = registration.guard(
    guardContext("bash", { command: "herdr pane list" }),
  );
  assert.equal(decision?.kind, "deny");
  assert.equal((decision as { reason: string }).reason, "该改用 herdr_pane");
});

test("正则缺省大小写不敏感；显式 flags 覆盖缺省", () => {
  const insensitive = registerDefault({
    rules: [
      {
        id: "import-os",
        tool: "script_run",
        match: { regex: ["import\\s+os"] },
        reason: "脚本里不要 import os",
      },
    ],
  });
  assert.equal(
    insensitive.guard(guardContext("script_run", { script: "Import OS" }))
      ?.kind,
    "deny",
  );

  const sensitive = registerDefault({
    rules: [
      {
        id: "lower-only",
        tool: "script_run",
        match: { regex: ["import\\s+os"], flags: "" },
        reason: "脚本里不要 import os",
      },
    ],
  });
  assert.equal(
    sensitive.guard(guardContext("script_run", { script: "Import OS" })),
    undefined,
  );
});

test("tool 数组限定：只对列出的工具判定", () => {
  const registration = registerDefault({
    rules: [
      {
        id: "no-ls",
        tool: ["bash", "pwsh"],
        match: { keywords: ["ls"] },
        reason: "用专用列表工具",
      },
    ],
  });
  assert.equal(
    registration.guard(guardContext("bash", { command: "ls" }))?.kind,
    "deny",
  );
  assert.equal(
    registration.guard(guardContext("read", { command: "ls" })),
    undefined,
  );
});

test("没有任何匹配条件的规则永不命中（不会变成全拦）", () => {
  const registration = registerDefault({
    rules: [{ id: "empty-match", match: {}, reason: "不该命中" }],
  });
  assert.equal(
    registration.guard(guardContext("bash", { command: "herdr pane list" })),
    undefined,
  );
});

test("规则按声明顺序取第一条命中", () => {
  const rules = compileRules(
    {
      rules: [
        {
          id: "first",
          tool: "bash",
          match: { keywords: ["herdr"] },
          reason: "第一条",
        },
        {
          id: "second",
          tool: "bash",
          match: { keywords: ["herdr"] },
          reason: "第二条",
        },
      ],
    },
    () => {},
  ).rules;
  const hit = matchRule(rules, guardContext("bash", { command: "herdr" }));
  assert.equal(hit?.reason, "第一条");
});

test("非法规则条目：告警并跳过，其余照常注册", () => {
  const fake = makeEngine();
  const warnings = captureStderr(() => {
    apply(contextWith(fake.engine), {
      rules: [
        { id: "no-reason", tool: "bash" } as unknown as RuleSpec,
        "junk" as unknown as RuleSpec,
        { id: "ok", tool: "bash", match: { keywords: ["herdr"] }, reason: "r" },
      ],
    });
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /缺少 reason/);
  assert.match(warnings[1] ?? "", /不是对象/);
  const registration = onlyRegistration(fake.registrations);
  assert.equal(
    registration.guard(guardContext("bash", { command: "herdr" }))?.kind,
    "deny",
  );
});

test("config.rules 不是数组：告警并回退内置规则表", () => {
  const fake = makeEngine();
  const warnings = captureStderr(() => {
    apply(contextWith(fake.engine), {
      rules: "oops" as unknown as RuleSpec[],
    });
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /不是数组/);
  const registration = onlyRegistration(fake.registrations);
  assert.equal(
    registration.guard(guardContext("bash", { command: "herdr pane list" }))
      ?.kind,
    "deny",
  );
});

test("缺 ruleEngine 服务：告警一次、不抛错、返回可调用注销函数", () => {
  let dispose: (() => void) | undefined;
  const warnings = captureStderr(() => {
    dispose = apply({});
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /ruleEngine 不可用/);
  assert.equal(typeof dispose, "function");
  dispose?.();
});

test("ctx.get 抛错（严格模式下服务缺席）：按缺席降级", () => {
  const warnings = captureStderr(() => {
    apply({
      get: () => {
        throw new Error("cannot get property");
      },
    });
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /ruleEngine 不可用/);
});

test("直接属性 ctx.ruleEngine 可用时不走 ctx.get", () => {
  const fake = makeEngine();
  apply({ ruleEngine: fake.engine });
  onlyRegistration(fake.registrations);
});

test("注册被拒（registerConsumer 抛错）：告警降级，不抛给宿主", () => {
  const warnings = captureStderr(() => {
    apply({
      ruleEngine: {
        registerConsumer: () => {
          throw new Error("注册被拒绝");
        },
      },
    });
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /注册 guard 消费者失败/);
  assert.match(warnings[0] ?? "", /注册被拒绝/);
});

test("dispose 事件注销一次；返回值幂等（不重复注销）", () => {
  const fake = makeEngine();
  const listeners: Array<{ event: string; listener: () => void }> = [];
  const dispose = apply(
    contextWith(fake.engine, (event, listener) => {
      listeners.push({ event, listener });
      return () => {};
    }),
  );
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0]?.event, "dispose");

  listeners[0]?.listener();
  assert.equal(fake.disposed(), 1);
  dispose();
  assert.equal(fake.disposed(), 1, "返回值与 dispose 事件不重复注销");
});

test("ctx.on 抛错：只告警，仍返回注销函数", () => {
  const fake = makeEngine();
  let dispose: (() => void) | undefined;
  const warnings = captureStderr(() => {
    dispose = apply(
      contextWith(fake.engine, () => {
        throw new Error("无该事件");
      }),
    );
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /ctx\.on\("dispose"\) 订阅失败/);
  dispose?.();
  assert.equal(fake.disposed(), 1);
});

test("toolText：shell 工具取 command，其余工具序列化参数", () => {
  assert.equal(
    toolText(guardContext("bash", { command: "herdr pane list", extra: 1 })),
    "herdr pane list",
  );
  assert.equal(
    toolText(guardContext("read", { path: "a.md" })),
    'read {"path":"a.md"}',
  );
  assert.equal(toolText(guardContext("read", undefined)), "read ");
  assert.equal(
    toolText(guardContext("pwsh", { command: "Get-ChildItem" })),
    "Get-ChildItem",
  );
});

test("toolText：参数无法序列化（循环引用 / 非字符串 command）不抛错", () => {
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.equal(toolText(guardContext("read", circular)), "read ");
  assert.equal(
    toolText(guardContext("bash", { command: 42 })),
    'bash {"command":42}',
  );
  assert.equal(
    toolText({ name: undefined as unknown as string, arguments: "x" }),
    ' "x"',
  );
});
