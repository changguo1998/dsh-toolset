// e2e/plan-mode-restore.test.ts — plan 只读预设恢复闭环（真宿主）。
//
// 覆盖: plan_start 切只读成功 → pre-step 轮询 provider（经 pin-note hold）注入阶段文案;
// 切走（flow_select 取消选中）后, provider 经「切走」分支恢复原预设。
// 背景: plan-mode 的 pinNotes.hold 补登记机制（plan-mode/src/index.ts ensurePlanHold）,
// 确保装配顺序使 pin-note 晚就绪时轮询也最终挂载。

import { test } from "node:test";
import assert from "node:assert/strict";

import { bootPackage, textOf } from "./harness.ts";

/** decision.messages 的全部文本（便于断言注入文案）。 */
function decisionTexts(decision: unknown): string {
  const messages = (decision as { messages?: unknown[] })?.messages ?? [];
  return messages
    .map((message) => {
      const content = (message as { content?: unknown[] })?.content ?? [];
      return content
        .map((block) => (block as { text?: string })?.text ?? "")
        .join(" ");
    })
    .join("\n");
}

test("plan_start 切只读后, pre-step 注入段位文案, 切走恢复原预设", async (t) => {
  const host = await bootPackage("plan-mode", {
    extraPackages: [
      "task-engine",
      "clock-base",
      "tool-surface",
      "pin-note",
      "memory-base",
      "session-paths",
      "flow-arbiter",
    ],
  });
  t.after(async () => host.dispose());

  const ctx = host.ctx as Record<string, any>;
  const pp = ctx.get("permissionPresets");
  const arbiter = ctx.get("flowArbiter");
  assert.ok(pp, "permissionPresets 应在装配里");
  assert.ok(arbiter, "flowArbiter 应在装配里");

  const agent = await host.createAgent("e2e-plan-restore");
  t.after(async () => agent.dispose());
  const sess = (agent.agent as any).session;

  // 进入 plan 模式
  const selected = await host.callTool(
    "flow_select",
    { flow: "plan" },
    { agent: agent.agent },
  );
  assert.equal(selected.isError, false);
  const started = await host.callTool("plan_start", {}, { agent: agent.agent });
  assert.equal(started.value?.ok, true);
  assert.equal(started.value?.presetSwitched, true);
  assert.equal(pp.current(sess), "read-only", "进入后应切到只读");

  // plan_start 本身是工具调用, 触发 pre-execute → ensurePlanHold 补登记;
  // 再保证一次订阅驱动（pin-note 的 agent/pre-step 订阅在 hold 时建立）。
  const hooks = (ctx.events as any)?._hooks?.["agent/pre-step"] ?? [];
  assert.ok(hooks.length > 0, "应有 agent/pre-step 监听者");

  // 诊断: host 内 plan-mode 服务面的 record 状态（验证 sessionId 命中与帧匹配）
  const planStage = ctx.get("planStage");
  console.log(
    "DBG planStage.current:",
    JSON.stringify(planStage?.current?.(sess.id)),
  );
  console.log("DBG pinNotes service:", typeof ctx.get("pinNotes"));

  // 调一次 task-engine 工具 → 触发其 beforeExecute(ensureTaskHold) 补登记 task hold
  const status = await host.callTool("task_status", {}, { agent: agent.agent });
  console.log("DBG task_status ok:", status.isError === false);

  // 再调一次 write（探索段应被 plan-mode 拦截 → 证明 pre-execute 链 + plan-mode listener 在跑）
  const denied = await host.callTool(
    "write",
    { file_path: "tmp-plan-restore.txt", content: "x" },
    { agent: agent.agent },
  );
  console.log("DBG write denied:", denied.isError, textOf(denied).slice(0, 60));

  const signal = new AbortController().signal;
  const inner = async () => ({ kind: "enter", messages: [] });
  const payload = {
    agent: agent.agent,
    messages: [],
    turn: 1,
    step: 1,
    signal,
    modelSelection: {},
  };

  // 直接对 pin-note 的 pre-step handler 调用, 聚焦「provider 是否被调并注入」
  const pinHandler = hooks.find((h: any) => h.callback?.name === "handler");
  assert.ok(pinHandler, "应找到 pin-note 的 pre-step handler");
  const direct: any = await pinHandler.callback.call(null, payload, inner);
  const directTexts = decisionTexts(direct);
  console.log("DBG direct has 探索:", directTexts.includes("当前段: 探索"));
  console.log("DBG direct has task:", directTexts.includes("[task]"));
  console.log("DBG direct head:", directTexts.slice(0, 200));
  assert.match(directTexts, /当前段: 探索/, "探索段应注入只读段位文案");

  // 整链广播触发一次（宿主真实派发形态）
  const step1: any = await ctx.events.waterfall(
    null,
    "agent/pre-step",
    payload,
    inner,
  );
  assert.match(
    decisionTexts(step1),
    /当前段: 探索/,
    "探索段应注入只读段位文案",
  );
  assert.equal(pp.current(sess), "read-only", "探索段不应恢复预设");

  // 切走: 取消选中 plan
  const off = await host.callTool(
    "flow_select",
    { flow: "" },
    { agent: agent.agent },
  );
  assert.equal(off.isError, false);
  assert.equal(arbiter.current(sess.id), null, "切走后不再选中 plan");

  // 触发下一次 pre-step → 切走分支恢复预设
  const step2: any = await ctx.events.waterfall(
    null,
    "agent/pre-step",
    {
      agent: agent.agent,
      messages: [],
      turn: 1,
      step: 1,
      signal,
      modelSelection: {},
    },
    inner,
  );
  assert.doesNotMatch(decisionTexts(step2), /当前段/, "恢复后不再注入段位文案");
  assert.equal(pp.current(sess), "workspace-write", "切走应恢复原预设");
});
