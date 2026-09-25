// tests/footer-notice.test.ts — 问题交互态底部输入区显示 notice（BACKLOG 3.1.1）
//
// 覆盖：审批 / 问答面板打开时底部输入区显示最近 notice（含面板打开前的）；
// tone 着色保留；超长 notice 折行后只取末尾若干行（最新可见、更早的被裁）；
// 其它模态面板（jobs / 会话）仍空白占位；面板关闭后切回输入视图且排队中的
// inputText 不丢。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame, frameGeometry, rowText } from "../src/app/layout.ts";
import { initialState, reduceState, type AppState } from "../src/app/state.ts";

const SIZE = { rows: 24, cols: 80 };

/** 帧里底部输入区（footer）的行文本：按几何从整帧切出 */
function footerRows(state: AppState, size = SIZE): string[] {
  const geom = frameGeometry(state, size);
  const rows = buildFrame(state, size);
  const start = geom.contentTopH + 1 + geom.statusHeight + 1;
  return rows.slice(start, start + geom.footerHeight).map(rowText);
}

/** 审批面板态 */
function approvalState(): AppState {
  return reduceState(initialState(), {
    type: "approval",
    approval: { id: "a1", prompt: "允许执行?" },
  });
}

test("3.1.1 审批面板打开时底部显示最近 notice（含面板打开前的）", () => {
  let s = initialState();
  s = reduceState(s, { type: "notice", text: "面板打开前的提示" });
  s = reduceState(s, {
    type: "approval",
    approval: { id: "a1", prompt: "允许执行?" },
  });
  s = reduceState(s, { type: "notice", text: "面板期的新提示" });
  const footer = footerRows(s).join("\n");
  assert.ok(
    footer.includes("面板期的新提示"),
    "应显示面板期 notice: " + footer,
  );
  assert.ok(
    footer.includes("面板打开前的提示"),
    "同屏可显示面板打开前的最近 notice: " + footer,
  );
});

test("3.1.1 tone 着色在底部 notice 视图保留", () => {
  let s = approvalState();
  s = reduceState(s, { type: "notice", text: "写入失败", tone: "error" });
  const geom = frameGeometry(s, SIZE);
  const rows = buildFrame(s, SIZE);
  const start = geom.contentTopH + 1 + geom.statusHeight + 1;
  const seg = rows
    .slice(start, start + geom.footerHeight)
    .flatMap((r) => r.segments)
    .find((x) => x.text.includes("写入失败"));
  assert.ok(seg, "底部应含 notice 文本");
  assert.equal(seg!.style?.fg, "red", "error tone 应着 red");
});

test("3.1.1 超长 notice：折行后取末尾若干行（最新可见、更早的被裁）", () => {
  let s = approvalState();
  for (const t of [
    "第一一条",
    "第二二条",
    "第三三条",
    "第四四条",
    "第五五条",
  ]) {
    s = reduceState(s, { type: "notice", text: "长文本占位 ".repeat(6) + t });
  }
  const footer = footerRows(s).join("\n");
  assert.ok(footer.includes("第五五条"), "最新一条应可见: " + footer);
  assert.ok(!footer.includes("第一一条"), "更早的应被裁掉: " + footer);
});

test("3.1.1 其它模态面板（jobs / 会话）仍空白占位，不显 notice", () => {
  for (const action of [
    { type: "jobs-panel-open" } as const,
    { type: "history-open" } as const,
  ]) {
    let s = reduceState(initialState(), {
      type: "notice",
      text: "不应出现在底部",
    });
    s = reduceState(s, action);
    const footer = footerRows(s).join("\n");
    assert.ok(
      footer.trim() === "",
      `${action.type} 面板态底部应为空白占位: ` + JSON.stringify(footer),
    );
  }
});

test("3.1.1 面板关闭后切回输入视图，排队 inputText 不丢", () => {
  let s = approvalState();
  s = reduceState(s, { type: "notice", text: "面板期提示" });
  const sPanel = reduceState(s, { type: "input", text: "排队消息", cursor: 4 });
  assert.ok(
    footerRows(sPanel).join("\n").includes("面板期提示"),
    "面板态应显示 notice",
  );
  const back = reduceState(sPanel, { type: "approval", approval: null });
  const footer = footerRows(back).join("\n");
  assert.ok(footer.includes("排队消息"), "关闭后应回到输入视图: " + footer);
  assert.ok(!footer.includes("面板期提示"), "关闭后底部不再显示 notice");
});
