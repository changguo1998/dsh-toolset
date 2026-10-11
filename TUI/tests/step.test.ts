// tests/step.test.ts — step 分步分割线（#7 起：step/start 即画）
//
// 条目 16 段 C2：step 头不再是缓冲行（reducer 的 `step` / `tool-call` / `tool-result` 内容
// 写缓冲路径删除）——头由 `step-start` **交付**声明、第 3 步**内容驱动**画：该 step 的
// 首条**回合区**内容之前产线，声明过但回合区无内容的不画（避免孤儿头），每 (turn, step)
// 只画一条。故本文件改走交付构造 + 帧断言。覆盖四类语义：
//   1. 时机：step 声明后其首条回合区内容（工具行 / 思考…）之前产线
//   2. 同一步不重复：头只随声明出，组内后续工具行不再插头
//   3. 新 step 声明另起分组头（新口径无 `step/end` 概念：线随声明出，不由结束关闭）
//   4. 无 step 声明 / 落在未声明 step 上的工具行不产线（append-only 兼容）
//
// 「声明过但无内容 → 孤儿头」的口径差异由 `tests/pipeline-equivalence.test.ts`
// 「已裁定差异二」钉住；纯文本函数（`stepHeaderLine` / `isStepHeader` / `stepOf`）仍由本文件覆盖。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFrame } from "../src/app/layout.ts";
import { pipelineContent } from "../src/app/layout/pipeline/frame.ts";
import { initialState, type AppState } from "../src/app/state.ts";
import { stepHeaderLine } from "../src/app/layout/tool-line.ts";
import { isStepHeader } from "../src/app/layout/content-rules.ts";
import { stepOf } from "../src/app/layout/pipeline/replay.ts";
import { rowText } from "./helpers/rowText.ts";
import {
  withDelivery,
  withStep,
  withText,
  withToolCall,
  withToolResult,
  withUser,
} from "./helpers/pipelineContent.ts";

/** 一条交付构造器（串起来用，形如旧 `StateAction[]` 的用法） */
type Step = (s: AppState) => AppState;

/** 依次投交付，返回最终状态 */
const apply = (steps: readonly Step[]): AppState =>
  steps.reduce((s, next) => next(s), initialState());

/** 固定时间戳（本地时间 03:04:05）——分组头文本可精确断言 */
const T0 = new Date(2026, 0, 2, 3, 4, 5).getTime();

/**
 * 回合区（活动区）渲染行文本——step 头与工具行都在这里。
 * 走 `pipelineContent`（第 ⑤ 步出口：与 `buildFrame` 同一份内容行，但不含状态列 / 边框），
 * 逐行剥掉行首竖线装饰：竖线由区块宽度门限决定，本文件断言的是文本与顺序。
 */
function activity(s: AppState): string[] {
  return pipelineContent(s.pipeline!, {
    dialogueTextW: 60,
    activityTextW: 60,
    windowGroups: 10,
    render: { width: 60 },
  }).activity.map((row) => rowText(row).replace(/^┃+/, ""));
}

/** 依次投交付 → 回合区渲染行文本 */
const run = (steps: readonly Step[]): string[] => activity(apply(steps));

/** 断言口径：头行尾部 `╌` 铺满随宽度变化，截到最后一个非 `╌` 片段 */
const plain = (text: string): string =>
  text.includes("╌") ? text.replace(/╌+$/, "").trimEnd() : text;

/** 期望的 step 头文本（`╌╌ hh:mm:ss ⇆N #M`；后随尾部 ╌ 铺满，见 `plain`） */
const head = (step: number, turn = 1): string =>
  "╌╌ " + stepHeaderLine(step, T0, turn);

/** 期望的 step 头文本（缺时间：按「缺项省略」只出回合号与步号） */
const headNoTime = (step: number, turn = 1): string =>
  "╌╌ " + stepHeaderLine(step, undefined, turn);

test("B3 分组头插入：step 内首条工具行前插 `hh:mm:ss ⇆N #M`，同组不重复", () => {
  const rows = run([
    (s) => withStep(s, 1, T0),
    (s) => withToolCall(s, "bash", "ls -la src/app", "c1"),
    (s) => withToolResult(s, true, "总用量 3 目录", "c1"),
    (s) => withToolCall(s, "bash", "pwd", "c2"),
  ]);
  assert.deepEqual(rows.map(plain), [
    head(1),
    "bash ls -la src/app",
    "✓ 总用量 3 目录",
    "bash pwd",
  ]);
});

test("B3 头随内容出：声明过但回合区无内容不产头；有内容即产线", () => {
  assert.deepEqual(
    run([(s) => withStep(s, 5, T0)]),
    [],
    "只声明、尚无内容 → 不产头（孤儿头口径）",
  );
  assert.deepEqual(
    run([
      (s) => withStep(s, 5, T0),
      (s) => withText(s, "想一下", "reasoning"),
    ]).map(plain),
    [head(5), "想一下"],
    "该 step 的首条回合区内容（思考）之前产线——每步有内容就画",
  );
  assert.deepEqual(
    run([(s) => withStep(s, 6, T0), (s) => withUser(s, "问题")]),
    [],
    "内容落在会话区（用户块）→ 回合区无头（用户块渲染由会话区用例覆盖）",
  );
});

test("B3 头只随声明出：组内后续工具行（含迟到结果）不再插头", () => {
  const rows = run([
    (s) => withStep(s, 1, T0),
    (s) => withToolCall(s, "bash", "ls", "c1"),
    (s) => withToolResult(s, true, "ok", "c1"),
    (s) => withToolCall(s, "bash", "pwd", "c2"),
    (s) => withToolResult(s, false, "EACCES: 13", "c2"),
  ]);
  assert.deepEqual(rows.map(plain), [
    head(1),
    "bash ls",
    "✓ ok",
    "bash pwd",
    "✗ EACCES: 13",
  ]);
});

test("B3 新 step 声明另起分组头：前一 step 未显式结束也一样", () => {
  const rows = run([
    (s) => withStep(s, 1, T0),
    (s) => withToolCall(s, "bash", "ls", "c1"),
    (s) => withStep(s, 2, T0), // 前一 step 未发 step/end（旧口径的防御分支）
    (s) => withToolCall(s, "bash", "rm -rf /tmp/tui-demo", "c2"),
  ]);
  assert.deepEqual(rows.map(plain), [
    head(1),
    "bash ls",
    head(2),
    "bash rm -rf /tmp/tui-demo",
  ]);
});

test("B3 向后兼容：无 step 声明（旧会话/mock）工具行不产线", () => {
  const rows = run([
    (s) => withToolCall(s, "bash", "ls", "c1"),
    (s) => withToolResult(s, true, "d", "c1"),
  ]);
  assert.deepEqual(rows.map(plain), ["bash ls", "✓ d"]);
});

test("B3 失败工具结果也参与分组：分组头先行", () => {
  const rows = run([
    (s) => withStep(s, 2, T0),
    (s) => withToolResult(s, false, "EACCES: 13", "c1"),
  ]);
  assert.deepEqual(rows.map(plain), [head(2), "✗ EACCES: 13"]);
});

test("B3 每步一条线：线随 step 声明出，落在未声明 step 上的工具行不产线", () => {
  // 工具行报的 step 2 没有 step/start 声明 → 不额外产线（旧口径「别的会话的工具行」同效：
  // 交付本身不带会话号，非活跃会话的交付由适配器/App 端就不产）
  const bare = run([
    (s) => withStep(s, 1, T0),
    (s) => withToolCall(s, "bash", "ls", "c1"),
    (s) =>
      withDelivery(s, {
        kind: "tool-call",
        turn: 1,
        step: 2,
        callId: "c2",
        name: "bash",
        args: "whoami",
      }),
  ]);
  assert.deepEqual(bare.map(plain), [head(1), "bash ls", "bash whoami"]);

  // 两个声明 step 各有内容 → 各产一条线（线与 step 一一对应，按声明顺序）
  const two = run([
    (s) => withStep(s, 1, T0),
    (s) => withToolCall(s, "bash", "ls", "c1"),
    (s) => withStep(s, 3, T0),
    (s) => withToolCall(s, "bash", "pwd", "c2"),
  ]);
  assert.deepEqual(two.map(plain), [head(1), "bash ls", head(3), "bash pwd"]);
});

test("B3 思考流式增量：同 block 续写按 `\\n` 断行，行尾空行不渲染", () => {
  // 增量以 \n 结尾：同 block（同 index）的下一增量接在其后 → 换行处断行、不粘成一行
  const streamed = run([
    (s) => withText(s, "第一段\n", "reasoning", 0),
    (s) => withText(s, "第二段\n", "reasoning", 0),
  ]);
  assert.deepEqual(
    streamed.map(plain),
    ["第一段", "第二段"],
    "两次增量各占一行；尾部的换行锚点（空行）不渲染",
  );

  // 思考在工具行之后另起一行，不留空行占位
  const mixed = run([
    (s) => withStep(s, 1, T0),
    (s) => withToolCall(s, "bash", "ls", "c1"),
    (s) => withToolResult(s, true, "ok", "c1"),
    (s) => withText(s, "好的，下一步执行\n", "reasoning"),
  ]);
  assert.deepEqual(mixed.map(plain), [
    head(1),
    "bash ls",
    "✓ ok",
    "好的，下一步执行",
  ]);
});

test("分组头文本：`hh:mm:ss ⇆N #M`（时间 → 回合号 → 步号；24 小时制、号不补零、缺项省略）", () => {
  assert.equal(stepHeaderLine(3, T0, 2), "03:04:05 ⇆2 #3");
  assert.equal(stepHeaderLine(123, T0, 45), "03:04:05 ⇆45 #123");
  // 下午时间用 24 小时制（本地时区 15:04:05）
  const pm = new Date(2026, 0, 2, 15, 4, 5).getTime();
  assert.equal(stepHeaderLine(1, pm, 1), "15:04:05 ⇆1 #1");
  // 缺项省略（顺序固定：时间 → 回合号 → 步号）
  assert.equal(stepHeaderLine(7, undefined, 3), "⇆3 #7", "缺时间");
  assert.equal(stepHeaderLine(3, T0), "03:04:05 #3", "缺回合号");
  assert.equal(stepHeaderLine(7, undefined), "#7", "两项都缺，不设占位");
  assert.equal(stepHeaderLine(7, T0, 0), "03:04:05 #7", "回合号 0 按缺项省略");
  assert.equal(stepHeaderLine(7, undefined, -1), "#7", "回合号负数同样省略");
  // 形制识别与回解（恢复路径依赖 `stepOf`）：新形制、缺项省略形、以及本改动前落进缓冲的
  // 历史旧形制都要认得出步号（交付路径的头文本由 `rows.ts` 同一个 `stepHeaderLine` 产出）
  assert.ok(isStepHeader("03:04:05 ⇆1 #3"), "新形制是分组头");
  assert.ok(isStepHeader("03:04:05 #3"), "旧形制（历史缓冲行）仍是分组头");
  assert.equal(stepOf("03:04:05 ⇆2 #3"), 3, "新形制可回解步号");
  assert.equal(stepOf("⇆3 #7"), 7, "缺时间的新形制可回解");
  assert.equal(stepOf("03:04:05 #3"), 3, "旧形制仍可回解步号");
  assert.equal(stepOf("#9"), 9, "两项都缺仍可回解");
});

test("P6 step-start 缺 time：头只出回合号与步号（不再回退当前时刻）", () => {
  // 条目 16 段 C2：时间真源是交付（`adapter/dsh.ts` 转发事件信封时间）。旧路径「缺 time
  // 回退 `Date.now()`」长在 reducer 的落行点（随内容写缓冲一起删除）；缺时间即按
  // `stepHeaderLine` 的「缺项省略」降级——与适配器恢复路径同口径（见
  // tests/adapter.dsh.test.ts「恢复：每个 step 起点出一条 step 头；缺 time 时头为 `⇆N #M`」）。
  const rows = run([
    (s) => withStep(s, 7),
    (s) => withToolCall(s, "bash", "ls", "c1"),
  ]);
  assert.deepEqual(rows.map(plain), [headNoTime(7), "bash ls"]);
  assert.doesNotMatch(
    rows[0]!,
    /\d{2}:\d{2}:\d{2}/,
    "缺时间不写 hh:mm:ss 片段",
  );
  assert.match(rows[0]!, /╌╌ ⇆1 #7 /);
});

test("B3 帧层：回合区渲染出 step 头与工具行（帧行含状态列前缀，不锚定行首）", () => {
  const s = apply([
    (x) => withStep(x, 1, T0),
    (x) => withToolCall(x, "bash", "ls -la src/app", "c1"),
    (x) => withToolResult(x, true, "总用量 3 目录", "c1"),
  ]);
  const rows = buildFrame(s, { rows: 24, cols: 100 }).map((row) =>
    rowText(row),
  );
  const at = (needle: string): number =>
    rows.findIndex((row) => row.includes(needle));
  const headAt = at("╌╌ 03:04:05 ⇆1 #1 ");
  assert.ok(headAt >= 0, `帧内应有 step 头：${JSON.stringify(rows)}`);
  assert.match(
    rows[headAt]!,
    /╌╌ 03:04:05 ⇆1 #1 ╌+$/,
    "头行由 `╌╌ … ` 前缀 + 尾部 ╌ 铺满整行",
  );
  const callAt = at("bash ls -la src/app");
  const resultAt = at("✓ 总用量 3 目录");
  assert.ok(callAt >= 0 && resultAt >= 0, "工具调用与结果在帧内");
  assert.ok(headAt < callAt && callAt < resultAt, "帧内顺序：头 → 调用 → 结果");
});
