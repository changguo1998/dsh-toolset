/**
 * demo：mock 会话事件流跑通「规则命中 → 注入」，不依赖 DSH 宿主。
 *
 * 演示四条路径：
 * 1. assistant-text：回合结束时对整回合正文判定（符号规范先例）；
 * 2. tool-call：工具调用到达即判定（破坏性命令约束）；
 * 3. turn-end：无条件边界规则（回合收尾提醒）；
 * 4. rule_test 干跑 + 工具族增删改（运行时层落临时状态目录，跑完清理）。
 *
 * 运行：npm run demo（先 build）。状态目录用临时目录，不触碰 ~/.dsh。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RuleEngine } from "../src/engine.ts";
import { buildInjectionMessage } from "../src/inject.ts";
import { toToolDefs } from "../src/tools.ts";
import type {
  Config,
  InjectionRequest,
  Rule,
  SessionEventLike,
} from "../src/types.ts";

const SESSION = { id: "demo-session" };

/** 配置基线规则（等价于 profile cordis.patch.yml 的 config.rules）。 */
const config: Config = {
  rules: [
    {
      id: "ascii-symbols",
      source: "assistant-text",
      match: { regex: ["[（）【】“”]"] },
      action: {
        type: "inject",
        text: "[符号规范] 回复里出现了非推荐符号，请改用 ASCII 半角符号重述要点。",
        summary: "符号规范提醒",
      },
      cooldownTurns: 1,
    },
    {
      id: "no-destructive-shell",
      source: "tool-call",
      match: { regex: ["rm\\s+-rf", "git\\s+push\\s+--force"] },
      action: {
        type: "inject",
        text: "[约束] 不要执行破坏性命令；如确需执行，先说明影响并取得确认。",
        summary: "破坏性命令约束",
      },
    },
    {
      id: "turn-wrapup",
      source: "turn-end",
      action: { type: "inject", text: "[收尾] 别忘了更新追踪文档。" },
      cooldownTurns: 1,
    },
  ] as Rule[],
  maxInjectionsPerTurn: 2,
};

/** 假注入器：把注入消息按宿主形态打印出来（真实注入器见 src/inject.ts）。 */
function createPrintInjector(): {
  injector: { inject(request: InjectionRequest): void };
  count: () => number;
} {
  let fired = 0;
  return {
    count: () => fired,
    injector: {
      inject(request: InjectionRequest): void {
        fired += 1;
        const message = buildInjectionMessage(
          request.text,
          request.summary,
        ) as {
          source: { kind: string; form: string; summary: string };
          content: Array<{ text: string }>;
        };
        console.log(
          `  → 注入[${request.ruleId}] source=${message.source.kind}/${message.source.form} ` +
            `summary=${JSON.stringify(message.source.summary)}\n` +
            `    ${message.content[0]?.text ?? ""}`,
        );
      },
    },
  };
}

/** 事件构造小工具（形状与宿主 session 事件一致）。 */
const assistantMessage = (turn: number, text: string): SessionEventLike => ({
  type: "assistant/message",
  data: {
    turn,
    step: 0,
    message: { role: "assistant", content: [{ type: "text", text }] },
  },
});
const toolCall = (
  turn: number,
  name: string,
  args: string,
): SessionEventLike => ({
  type: "tool/call",
  data: { turn, step: 0, callId: "c1", name, arguments: args },
});
const turnEnd = (turn: number, reason = "completed"): SessionEventLike => ({
  type: "turn/end",
  data: { turn, reason },
});

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-engine-demo-"));
  try {
    const { injector, count } = createPrintInjector();
    const engine = new RuleEngine({
      baseline: config.rules ?? [],
      stateDir: dir,
      injector,
      maxInjectionsPerTurn: config.maxInjectionsPerTurn,
      warn: (message) => console.warn(message),
    });
    console.log(`生效规则 ${engine.status().rules} 条，stateDir=${dir}\n`);

    console.log("回合 1：正文含全角符号（回合结束时判定）");
    engine.handle(
      SESSION,
      assistantMessage(1, "第一段：结论如下（已按规范处理）。"),
    );
    engine.handle(SESSION, assistantMessage(1, "第二段：无关键词。"));
    engine.handle(SESSION, turnEnd(1));

    console.log("\n回合 2：工具调用命中破坏性命令（事件到达即判定）");
    engine.handle(SESSION, toolCall(2, "shell", '{"cmd":"rm -rf /tmp/build"}'));
    engine.handle(SESSION, assistantMessage(2, "已清理临时目录。"));
    engine.handle(SESSION, turnEnd(2));

    console.log("\n回合 3：无命中（aborted 回合不注入）");
    engine.handle(SESSION, assistantMessage(3, "（用户中断）"));
    engine.handle(SESSION, turnEnd(3, "aborted"));

    console.log("\nrule_test 干跑（不注入）");
    const tools = toToolDefs(engine);
    const testTool = tools.find((tool) => tool.name === "rule_test");
    console.log(
      `  ${JSON.stringify(
        await testTool?.execute({ text: "这段里有（全角括号）" }),
      )}`,
    );

    console.log("\n工具族：rule_add → rule_list → rule_remove");
    const addTool = tools.find((tool) => tool.name === "rule_add");
    const listTool = tools.find((tool) => tool.name === "rule_list");
    const removeTool = tools.find((tool) => tool.name === "rule_remove");
    console.log(
      `  add: ${JSON.stringify(
        await addTool?.execute({
          id: "demo-runtime",
          source: "tool-result",
          match: { predicates: ["has-code-block"], keywords: ["stack trace"] },
          text: "[排查] 先读报错原文，再改代码。",
          cooldownTurns: 1,
        }),
      ).slice(0, 120)}...`,
    );
    const listed = (await listTool?.execute({})) as {
      rules: Array<{ id: string; origin: string }>;
    };
    console.log(
      `  list: ${listed.rules.map((rule) => `${rule.id}(${rule.origin})`).join(", ")}`,
    );
    console.log(
      `  remove: ${JSON.stringify(await removeTool?.execute({ id: "demo-runtime" }))}`,
    );

    console.log(
      `\n本次演示共注入 ${count()} 条（每回合上限 ${config.maxInjectionsPerTurn ?? 3}）。`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
