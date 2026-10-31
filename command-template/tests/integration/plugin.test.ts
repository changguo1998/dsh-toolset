import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENTRY_COMMAND,
  ENTRY_SUBCOMMANDS,
  inject,
  name,
  provide,
  SERVICE_FACE_METHODS,
} from "../../src/index.ts";
import { assemble } from "../assemble.ts";

/** 单 prompt 步骤的模板文本. */
function promptTemplate(desc = "打招呼"): string {
  return `---\nname: hello\ndescription: ${desc}\ninput: 名字\n---\n你好 $ARGUMENTS`;
}

test("装配: 契约符号与入口命令注册的 canonical 值", () => {
  const a = assemble({ templates: { "hello.md": promptTemplate() } });
  try {
    assert.equal(name, "command-template");
    assert.deepEqual(inject, ["commands"]);
    assert.deepEqual(provide, ["commandTemplate"]);
    assert.equal(ENTRY_COMMAND, "playbook");
    assert.deepEqual([...ENTRY_SUBCOMMANDS], ["list", "show", "reload"]);

    assert.equal(a.commands.definitions.length, 1, "模板不占独立命令名");
    const definition = a.definition();
    assert.equal(definition.definitionId, "command-template:playbook");
    assert.equal(definition.name, "playbook");
    assert.equal(
      definition.description,
      "预案（可复用提示词流程）：playbook <模板> [参数]；管理：playbook list | show <模板> | reload",
    );
    assert.deepEqual(definition.input, {
      hint: "list | show <模板> | reload | <模板> [参数]",
    });

    // 服务面: 键清单与 SERVICE_FACE_METHODS 一致, 行为转发到服务实现
    const face = a.provided.get("commandTemplate") as Record<string, unknown>;
    assert.ok(face !== undefined, "apply 应 provide commandTemplate");
    assert.deepEqual(
      Object.keys(face).sort(),
      [...SERVICE_FACE_METHODS].sort(),
    );
    assert.deepEqual(
      (face["list"] as () => { name: string }[])().map((item) => item.name),
      ["hello"],
    );
    assert.equal(
      (face["get"] as (n: string) => { description: string } | undefined)(
        "hello",
      )?.description,
      "打招呼",
    );
    assert.deepEqual((face["errors"] as () => unknown[])(), []);
    const reloaded = (
      face["reload"] as () => { templates: { name: string }[] }
    )();
    assert.deepEqual(
      reloaded.templates.map((item) => item.name),
      ["hello"],
      "服务面 reload 返回重新扫描结果",
    );

    // 装配日志与告警: 假 clock 在场, 不应有回落告警
    assert.deepEqual(a.warns, []);
    assert.ok(
      a.logs.some((line) =>
        line.includes("已注册入口 /playbook（模板 1 个，坏模板 0 个）"),
      ),
      a.logs.join("\n"),
    );
    assert.deepEqual(a.stderr, []);
  } finally {
    a.cleanup();
  }
});

test("模板加载: list 与 show 的投影文本（含坏模板清单）", async () => {
  const review = [
    "---",
    "name: review",
    "description: 评审",
    "model:",
    "  provider: deepseek",
    "  model: deepseek-v4-pro",
    "steps:",
    "  - id: gather",
    "    type: agent",
    "    prompt: 收集 $1",
    "  - id: verify",
    "    type: agent",
    '    prompt: "评审 {{gather}}"',
    "    model: deepseek-flash",
    "    bestOf: 2",
    "    judge:",
    "      prompt: 选最佳",
    "      model: judge-model",
    "---",
    "",
  ].join("\n");
  const broken = "---\nname: broken\n---\n缺 description";
  const a = assemble({
    templates: {
      "hello.md": promptTemplate(),
      "review.md": review,
      "broken.md": broken,
    },
  });
  try {
    const source = (file: string) => `${a.dir}/${file}`;
    const list = await a.invoke("list");
    assert.deepEqual(list, {
      kind: "success",
      text: [
        "模板 2 个：",
        "- playbook hello <名字> — 打招呼",
        "- playbook review — 评审",
        "",
        "坏模板：",
        `- ${source("broken.md")}：${source("broken.md")}: description 不能为空`,
      ].join("\n"),
    });

    // 空输入 = list
    assert.deepEqual(await a.invoke(""), list);

    const showHello = await a.invoke("show hello");
    assert.deepEqual(showHello, {
      kind: "success",
      text: [
        "# hello",
        "打招呼",
        `source: ${source("hello.md")}`,
        "model: (会话默认)",
        "budget: 7200000 ms（缺省 = maxSteps × stepTimeoutMs）",
        "steps:",
        "- step1 [prompt]",
      ].join("\n"),
    });

    const showReview = await a.invoke("show review");
    assert.equal(
      showReview.text,
      [
        "# review",
        "评审",
        `source: ${source("review.md")}`,
        "model: deepseek-v4-pro",
        "budget: 7200000 ms（缺省 = maxSteps × stepTimeoutMs）",
        "steps:",
        "- gather [agent] model=deepseek-v4-pro",
        "- verify [agent] model=deepseek-flash bestOf=2 +judge",
      ].join("\n"),
      "模板级模型继承到 agent 步并显示在 show 里",
    );

    assert.deepEqual(await a.invoke("show nope"), {
      kind: "error",
      text: "模板不存在：nope",
    });
  } finally {
    a.cleanup();
  }
});

test("执行: prompt 步骤注入当前会话, 消息形状与结果文本固定", async () => {
  const a = assemble({ templates: { "hello.md": promptTemplate() } });
  try {
    const result = await a.invoke("hello 世界");
    assert.deepEqual(result, { kind: "success", text: "已完成\n\n你好 世界" });
    assert.equal(a.followups.length, 1);
    const message = a.followups[0] as {
      id: string;
      role: string;
      content: { type: string; text: string }[];
      source: { kind: string; summary: string };
    };
    assert.match(message.id, /^[0-9a-f-]{36}$/, "消息带 uuid");
    assert.equal(message.role, "user");
    assert.deepEqual(message.content, [{ type: "text", text: "你好 世界" }]);
    assert.deepEqual(message.source, {
      kind: "command-template",
      summary: "command-template 模板步骤",
    });
  } finally {
    a.cleanup();
  }
});

test("执行: 多步模板串链并给出步骤摘要", async () => {
  const a = assemble({
    templates: {
      "two.md": [
        "---",
        "name: two",
        "description: d",
        "steps:",
        "  - id: a",
        "    type: prompt",
        "    prompt: 甲",
        "  - id: b",
        "    type: prompt",
        "    prompt: 基于 {{a}}",
        "---",
        "",
      ].join("\n"),
    },
  });
  try {
    assert.deepEqual(await a.invoke("two"), {
      kind: "success",
      text: "已完成 2 步（a → b）\n\n基于 甲",
    });
    assert.deepEqual(
      a.followups.map(
        (message) =>
          (message as { content: { text: string }[] }).content[0]?.text,
      ),
      ["甲", "基于 甲"],
    );
  } finally {
    a.cleanup();
  }
});

test("执行: agent 步骤经宿主服务面 start, 模型继承与请求形状固定", async () => {
  const a = assemble({
    templates: {
      "review.md": [
        "---",
        "name: review",
        "description: 评审",
        "model:",
        "  provider: deepseek",
        "  model: deepseek-v4-pro",
        "steps:",
        "  - id: gather",
        "    type: agent",
        "    prompt: 收集 $1",
        "---",
        "",
      ].join("\n"),
    },
  });
  try {
    const result = await a.invoke("review 主题");
    assert.deepEqual(result, {
      kind: "success",
      text: "已完成\n\n回答(收集 主题)",
    });
    assert.equal(a.subagentCalls.length, 1);
    const [call] = a.subagentCalls;
    assert.equal(call?.name, "spawn", "provider 选 spawn 优先");
    const request = call?.request ?? {};
    assert.equal(request["label"], "command-template");
    assert.deepEqual(request["prompt"], [{ type: "text", text: "收集 主题" }]);
    assert.ok(request["signal"] instanceof AbortSignal, "携带合并后的取消信号");
    assert.deepEqual(
      request["agentOptions"],
      { provider: "deepseek", model: "deepseek-v4-pro" },
      "模板级模型覆盖透传到本次子代理运行",
    );
    assert.deepEqual(
      (request["parent"] as { session?: { id?: string } }).session,
      { id: "session-1" },
      "父 agent 透传（宿主据此写父会话 catalog）",
    );
    assert.ok(
      a.clock?.scheduled.includes(600000),
      `单步超时排期应走 clock: ${a.clock?.scheduled}`,
    );
  } finally {
    a.cleanup();
  }
});

test("执行: spawn 缺席时退到 fork", async () => {
  const a = assemble({
    subagents: "fork",
    templates: {
      "review.md": [
        "---",
        "name: review",
        "description: 评审",
        "steps:",
        "  - id: gather",
        "    type: agent",
        "    prompt: p",
        "---",
        "",
      ].join("\n"),
    },
  });
  try {
    assert.equal((await a.invoke("review")).kind, "success");
    assert.equal(a.subagentCalls[0]?.name, "fork");
  } finally {
    a.cleanup();
  }
});

test("执行: bestOf + 裁判 → 候选数与裁判提示词 canonical 值", async () => {
  const a = assemble({
    templates: {
      "best.md": [
        "---",
        "name: best",
        "description: d",
        "steps:",
        "  - id: verify",
        "    type: agent",
        "    prompt: 评审",
        "    model: deepseek-flash",
        "    bestOf: 2",
        "    judge:",
        "      prompt: 选最佳",
        "      model: judge-model",
        "---",
        "",
      ].join("\n"),
    },
  });
  try {
    const result = await a.invoke("best");
    assert.equal(result.kind, "success");
    assert.equal(a.subagentCalls.length, 3, "两个候选 + 一次裁判");
    assert.deepEqual(
      a.subagentCalls.map((call) => call.request["prompt"]),
      [
        [{ type: "text", text: "评审" }],
        [{ type: "text", text: "评审" }],
        [
          {
            type: "text",
            text: [
              "选最佳",
              "",
              "### 候选 1",
              "回答(评审)",
              "",
              "### 候选 2",
              "回答(评审)",
              "",
              "先给出选择（候选编号），再给出最终答案。",
            ].join("\n"),
          },
        ],
      ],
    );
    assert.deepEqual(
      a.subagentCalls.map((call) => call.request["agentOptions"]),
      [
        { model: "deepseek-flash" },
        { model: "deepseek-flash" },
        { model: "judge-model" },
      ],
      "候选与裁判各自的模型覆盖",
    );
    assert.match(result.text ?? "", /已完成\n\n回答\(选最佳/);
  } finally {
    a.cleanup();
  }
});

test("管理面: reload 重新扫描目录并替换已注册命令", async () => {
  const a = assemble({ templates: { "hello.md": promptTemplate() } });
  try {
    assert.equal(a.commands.definitions.length, 1);
    a.writeTemplate(
      "extra.md",
      "---\nname: extra\ndescription: 后加的\n---\nx",
    );
    const reloaded = await a.invoke("reload");
    assert.deepEqual(reloaded, {
      kind: "success",
      text: "已重载：模板 2 个，坏模板 0 个\n- extra\n- hello",
    });
    assert.equal(a.commands.definitions.length, 2, "reload 重新注册入口命令");
    assert.equal(a.commands.disposed, 1, "旧入口命令先被撤销");
    assert.match(
      (await a.invoke("list")).text ?? "",
      /- playbook extra — 后加的/,
    );
  } finally {
    a.cleanup();
  }
});

test("装配: 命令面 / 服务面缺席与 disabled 的降级", async () => {
  const noCommands = assemble({
    commands: "none",
    templates: { "hello.md": promptTemplate() },
  });
  try {
    assert.equal(noCommands.commands.definitions.length, 0);
    assert.ok(
      noCommands.logs.some((line) => line.includes("commands 未挂载")),
      noCommands.logs.join("\n"),
    );
    assert.ok(
      noCommands.provided.has("commandTemplate"),
      "命令面缺席时仍提供只读服务面",
    );
  } finally {
    noCommands.cleanup();
  }

  const viaGet = assemble({
    commands: "get",
    templates: { "hello.md": promptTemplate() },
  });
  try {
    assert.equal(
      viaGet.commands.definitions.length,
      1,
      "经 ctx.get 也能拿到命令面",
    );
  } finally {
    viaGet.cleanup();
  }

  const noProvide = assemble({
    provide: "none",
    templates: { "hello.md": promptTemplate() },
  });
  try {
    assert.equal(noProvide.provided.size, 0);
    assert.equal(
      noProvide.commands.definitions.length,
      1,
      "命令注册不依赖 provide",
    );
  } finally {
    noProvide.cleanup();
  }

  const disabled = assemble({
    config: { disabled: true },
    templates: { "hello.md": promptTemplate() },
  });
  try {
    assert.equal(disabled.commands.definitions.length, 0);
    assert.equal(disabled.provided.size, 0);
    assert.equal(
      disabled.stderr.join(""),
      "[command-template] 已禁用（config.disabled）\n",
    );
  } finally {
    disabled.cleanup();
  }
});

test("定时器统一面: clock 缺席回落进程内定时器, 每个实例只告警一次", async () => {
  const a = assemble({
    clock: false,
    templates: { "hello.md": promptTemplate() },
  });
  try {
    assert.deepEqual(a.warns, [
      "clock 服务不可用，回落进程内定时器（排期不随插件卸载撤销；本条每个插件实例只告警一次）",
    ]);
    assert.equal((await a.invoke("hello 世界")).kind, "success");
    assert.equal(a.warns.length, 1, "运行期不重复告警");
  } finally {
    a.cleanup();
  }

  // logger 缺席: 告警落 stderr（宿主极简 ctx 形态）
  const noLogger = assemble({
    clock: false,
    logger: "none",
    templates: { "hello.md": promptTemplate() },
  });
  try {
    assert.equal(noLogger.warns.length, 0);
    assert.match(
      noLogger.stderr.join(""),
      /\[command-template\] warn: clock 服务不可用/,
    );
  } finally {
    noLogger.cleanup();
  }
});

test("执行: 子代理服务或宿主模块缺席时给出 canonical 错误", async () => {
  const template = [
    "---",
    "name: agent-only",
    "description: d",
    "steps:",
    "  - id: a",
    "    type: agent",
    "    prompt: p",
    "---",
    "",
  ].join("\n");

  const noService = assemble({
    subagents: "none",
    templates: { "agent-only.md": template },
  });
  try {
    assert.deepEqual(await noService.invoke("agent-only"), {
      kind: "error",
      text: "模板 agent-only 执行失败（step_failed）：步骤 a 失败：subagents 服务不可用（宿主未挂载 subagent 面）",
    });
  } finally {
    noService.cleanup();
  }

  const noHost = assemble({
    host: "missing",
    templates: { "agent-only.md": template },
  });
  try {
    const result = await noHost.invoke("agent-only");
    assert.equal(result.kind, "error");
    assert.match(
      result.text ?? "",
      /模板 agent-only 执行失败（step_failed）：步骤 a 失败：宿主未导出 settleRun/,
    );
  } finally {
    noHost.cleanup();
  }
});

test("配置: reservedNames 收窄后同名模板不可调用, 但仍可 show", async () => {
  const a = assemble({
    config: { reservedNames: ["show", "notes"] },
    templates: {
      "notes.md": "---\nname: notes\ndescription: 笔记\n---\n写入笔记",
    },
  });
  try {
    assert.ok(
      a.logs.some((line) =>
        line.includes("模板名与入口 / 子命令名冲突（无法调用）：notes"),
      ),
      a.logs.join("\n"),
    );
    const management = await a.invoke("notes");
    assert.match(
      management.text ?? "",
      /^- playbook notes — 笔记/m,
      "保留名当第一段 → 走管理面",
    );
    assert.match(
      (await a.invoke("show notes")).text ?? "",
      /^# notes\n笔记/,
      "show 仍可查看",
    );
  } finally {
    a.cleanup();
  }
});
