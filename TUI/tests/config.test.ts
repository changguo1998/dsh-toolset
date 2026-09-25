// tests/config.test.ts — tui.config.json 布局配置：归一化、载入与渲染层生效
//
// 覆盖：normalizeConfig 合法/非法/缺省回落；loadTuiConfig 读取缺省文件与缺失路径；
// metricsFor 的 footerHeight/statusDivisor、activityHeight 的 divisor 生效（默认 2≈1/2）。
// 语义「总：目标」：状态列宽 = cols/statusColumnDivisor（1/3 → 3）、活动区 = contentTopH/divisor。

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, loadTuiConfig } from "../src/app/config.ts";
import {
  metricsFor,
  activityHeight,
  activityTopRowToLine,
  topPaneHeights,
  topPaneSplit,
  GOLDEN_RATIO,
} from "../src/app/layout.ts";

test("normalizeConfig：合法整数保留，非法/越界回落缺省（undefined）", () => {
  const c = normalizeConfig({
    layout: {
      footerHeight: 6,
      activityHeightDivisor: 4,
      statusColumnDivisor: -1,
      bogus: true,
    },
  })!;
  assert.equal(c.layout?.footerHeight, 6);
  assert.equal(c.layout?.activityHeightDivisor, 4);
  assert.equal(c.layout?.statusColumnDivisor, 1, "负数 clamp 到 1");
  assert.equal(
    (c.layout as Record<string, unknown>).bogus,
    undefined,
    "未知字段忽略",
  );
  // 非法类型（字符串/NaN）回落 undefined → 渲染用默认
  const bad = normalizeConfig({
    layout: { activityHeightDivisor: "x", statusColumnDivisor: NaN },
  })!;
  assert.equal(bad.layout?.activityHeightDivisor, undefined);
  assert.equal(bad.layout?.statusColumnDivisor, undefined);
});

test("normalizeConfig：notify 声音提醒——enabled 布尔、idleThresholdMs 合法保留/非法回落", () => {
  const c = normalizeConfig({
    notify: {
      enabled: false,
      idleThresholdMs: 3000,
    },
  })!;
  assert.equal(c.notify?.enabled, false);
  assert.equal(c.notify?.idleThresholdMs, 3000);
  // 缺省：不配置 notify → 字段 undefined（App 层默认开启 + 8s）
  const def = normalizeConfig({})!;
  assert.deepEqual(def.notify, {});
  // 非法：字符串/NaN/过小 → 回落 undefined（App 用默认）
  const bad = normalizeConfig({
    notify: { enabled: "yes", idleThresholdMs: NaN },
  })!;
  assert.equal(bad.notify?.enabled, undefined);
  assert.equal(bad.notify?.idleThresholdMs, undefined);
});

test("normalizeConfig：session 会话维护——autoCleanEmpty 布尔合法保留/非法回落", () => {
  const c = normalizeConfig({
    session: { autoCleanEmpty: true },
  })!;
  assert.equal(c.session?.autoCleanEmpty, true);
  // 缺省：不配置 session → 字段 undefined（App 层默认关闭自动清理）
  const def = normalizeConfig({})!;
  assert.deepEqual(def.session, {});
  // 非法：字符串 → 回落 undefined（关闭）
  const bad = normalizeConfig({
    session: { autoCleanEmpty: "yes" },
  })!;
  assert.equal(bad.session?.autoCleanEmpty, undefined);
});

test("loadTuiConfig：缺省路径读取真实文件；缺失路径回落默认不崩溃", () => {
  const c = loadTuiConfig();
  assert.equal(c.layout?.activityHeightDivisor, 2, "默认文件 1/2");
  assert.equal(c.layout?.statusColumnDivisor, 5, "默认文件 1/5");
  assert.equal(
    c.layout?.activityPlacement,
    "auto",
    "默认文件开启黄金比自动排列",
  );
  const missing = loadTuiConfig("/nonexistent/tui.config.json");
  assert.deepEqual(missing, { layout: {} }, "缺失文件回落默认");
});

test("metricsFor：footerHeight 绝对行数生效；statusDivisor 控制状态列宽（最低 20 列、历史区保底 10）", () => {
  const def = metricsFor({ rows: 24, cols: 60 }, 1, 1);
  const cfg = metricsFor({ rows: 24, cols: 60 }, 1, 1, {
    footerHeight: 6,
    statusDivisor: 2,
  });
  assert.equal(def.footerHeight, 3, "默认输入态 交互区 4-1");
  assert.equal(cfg.footerHeight, 5, "配置 footerHeight=6 → 输入态 6-1");
  assert.equal(
    def.statusColWidth,
    Math.min(Math.max(20, 20), 50),
    "默认 cols/3=20",
  );
  assert.equal(
    cfg.statusColWidth,
    Math.min(Math.max(20, 30), 50),
    "statusDivisor=2 → cols/2=30",
  );
  // 最低 20 列：cols=40 时 1/3=13 仍被提到 20（历史区保底 10 → 历史区 20）
  const narrow = metricsFor({ rows: 24, cols: 40 }, 1, 1);
  assert.equal(narrow.statusColWidth, 20, "状态列最低 20 列");
  assert.equal(narrow.historyWidth, 20, "历史区 = 40 - 20");
});

test("activityHeight：divisor 控制活动区高（contentTopH / divisor）", () => {
  assert.equal(activityHeight(20), 10, "默认 divisor=2（1/2 比例）");
  assert.equal(activityHeight(20, 4), 5, "divisor=4 → 1/4");
  assert.equal(activityHeight(0, 2), 0, "无顶部空间时 0");
});

test("normalizeConfig：activityTopRow——half 字面量/非负整数保留，非法回落缺省", () => {
  const c = normalizeConfig({
    layout: { activityTopRow: "half" as unknown },
  })!;
  assert.equal(c.layout?.activityTopRow, "half");
  const n = normalizeConfig({ layout: { activityTopRow: 9 } })!;
  assert.equal(n.layout?.activityTopRow, 9);
  const zero = normalizeConfig({ layout: { activityTopRow: 0 } })!;
  assert.equal(zero.layout?.activityTopRow, 0, "0 行合法");
  // 非法/负数/字符串回落 undefined（走 divisor 比例）
  const bad = normalizeConfig({
    layout: { activityTopRow: -1 as unknown },
  })!;
  assert.equal(bad.layout?.activityTopRow, undefined);
  const def = normalizeConfig({})!;
  assert.equal(
    def.layout?.activityTopRow,
    undefined,
    "缺省 undefined=走 divisor",
  );
});

test("activityTopRowToLine：half → floor(rows/2)；数字按行号；未配置/非法 → undefined", () => {
  assert.equal(activityTopRowToLine(undefined, 24), undefined);
  assert.equal(activityTopRowToLine("half", 24), 12, "24 行 → 中线 12");
  assert.equal(activityTopRowToLine("half", 25), 12, "25 行 → floor(12.5)=12");
  assert.equal(activityTopRowToLine(11, 24), 11, "绝对行号直通");
  assert.equal(activityTopRowToLine(11.9, 24), 11, "小数向下取整");
  assert.equal(activityTopRowToLine(-1, 24), undefined, "负数非法 → undefined");
});

test("topPaneHeights：topRow 锚定——活动区分隔行落在指定行（优先于 divisor）", () => {
  // rows=24 → topRow=12：titleRows=2，dialogueH=12-2=10，activityH=20-12-1=7
  // diaEnd（分隔行）= titleRows+dialogueH = 12 = topRow
  const anchored = topPaneHeights(20, undefined, 12);
  assert.equal(anchored.titleRows, 2);
  assert.equal(anchored.dialogueH, 10);
  assert.equal(anchored.activityH, 7);
  assert.equal(
    anchored.titleRows + anchored.dialogueH,
    12,
    "活动区分隔行恰在 topRow",
  );
  // divisor 被忽略：同样 contentTopH=20、topRow=12，不因 divisor=4 改变
  const withDiv = topPaneHeights(20, 4, 12);
  assert.equal(withDiv.activityH, 7, "锚定优先于 divisor");
  // 小 topRow（3）：对话区 1 行、活动区 = contentTopH-3-1
  const small = topPaneHeights(20, undefined, 3);
  assert.equal(small.dialogueH, 1);
  assert.equal(small.activityH, 16);
  // 剩余不足（topRow 太靠底 / contentTopH 太小）：活动区 0 行、对话区吃满，无分隔行
  const noActivity = topPaneHeights(10, undefined, 9);
  assert.equal(noActivity.activityH, 0);
  assert.equal(noActivity.dialogueH, 8, "回退：对话区吃满剩余（10-2）");
  // 未锚定：维持 divisor 比例行为（回归）
  const legacy = topPaneHeights(20, undefined);
  assert.equal(legacy.activityH, 10, "未锚定默认 divisor=2");
  assert.equal(legacy.dialogueH, 7, "20-2-10-1");
});

test("topPaneSplit：缺省 vertical = 原 topPaneHeights 口径；两 pane 同宽", () => {
  const def = topPaneSplit(20, 60, undefined, undefined, undefined);
  const legacy = topPaneHeights(20, undefined);
  assert.equal(def.mode, "vertical");
  assert.equal(def.dialogueH, legacy.dialogueH);
  assert.equal(def.activityH, legacy.activityH);
  assert.equal(def.dialogueW, 60, "纵向：两 pane 共用左列正文宽");
  assert.equal(def.activityW, 60);
});

test("topPaneSplit：auto 以 φ 为界——区域比 φ 扁 → 左右；比 φ 瘦长 → 上下", () => {
  // 可用行数 = contentTopH - 2（标题栏）；R = 正文宽/可用行
  // R = 48/10 = 4.8 > φ → 左右（等分后 pane 宽高比 ≈ 2.3，比纵向的 16 更贴近 φ）
  const wide = topPaneSplit(12, 48, 2, undefined, "auto");
  assert.equal(wide.mode, "horizontal");
  assert.equal(wide.dialogueH, 10, "横向两 pane 等高 = 可用行数");
  assert.equal(wide.activityH, 10);
  assert.equal(wide.activityW, 24, "活动区宽 = floor(48/2)");
  assert.equal(wide.dialogueW, 23, "48 - 活动区 24 - 1 列内部分隔");
  // R = 60/58 ≈ 1.03 < φ → 上下（纵向 pane 宽高比 ≈ 2.2，比横向的 0.5 更贴近 φ）
  const tall = topPaneSplit(60, 60, 2, undefined, "auto");
  assert.equal(tall.mode, "vertical");
  // 黄金分割比常量自身检查
  assert.ok(Math.abs(GOLDEN_RATIO - 1.618) < 0.001);
});

test("topPaneSplit：固定 placement 直通；横向不可行（太窄/无行）回落上下", () => {
  assert.equal(topPaneSplit(12, 48, 2, undefined, "vertical").mode, "vertical");
  assert.equal(
    topPaneSplit(12, 48, 2, undefined, "horizontal").mode,
    "horizontal",
  );
  // 左列正文宽 < 2*20+1：横向两侧都放不下 → 回落上下
  assert.equal(
    topPaneSplit(12, 40, 2, undefined, "horizontal").mode,
    "vertical",
    "正文宽不足两个 pane",
  );
  // 正文宽 41 = 恰好放下两个 20 列 pane（divisor=2 时活动区被抬到保底宽）
  const tight = topPaneSplit(12, 41, 2, undefined, "horizontal");
  assert.equal(tight.mode, "horizontal");
  assert.equal(tight.activityW, 20, "活动区保底 20 列");
  assert.equal(tight.dialogueW, 20);
  // 无可用行（contentTopH <= 标题栏）
  assert.equal(
    topPaneSplit(2, 100, 2, undefined, "horizontal").mode,
    "vertical",
  );
});

test("topPaneSplit：divisor 同时决定纵向高与横向宽（语义一致）", () => {
  const h = topPaneSplit(20, 80, 4, undefined, "horizontal");
  assert.equal(h.activityW, 20, "活动 pane 宽 = floor(80/4)");
  assert.equal(h.dialogueW, 59, "80 - 20 - 1");
  const v = topPaneSplit(20, 60, 4, undefined, "vertical");
  assert.equal(v.activityH, 5, "活动 pane 高 = floor(20/4)");
});
