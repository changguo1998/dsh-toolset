// tests/config.test.ts — tui.config.json 布局配置：归一化、载入与渲染层生效
//
// 覆盖：normalizeConfig 合法/非法/缺省回落；loadTuiConfig 读取缺省文件与缺失路径；
// metricsFor 的 footerHeight/statusDivisor、activityHeight 的 divisor 生效（默认 2≈1/2）。
// 语义「总：目标」：状态列宽 = cols/statusColumnDivisor（1/3 → 3）、活动区 = contentTopH/divisor。

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, loadTuiConfig } from "../src/app/config.ts";
import { metricsFor, activityHeight } from "../src/app/layout.ts";

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

test("loadTuiConfig：缺省路径读取真实文件；缺失路径回落默认不崩溃", () => {
  const c = loadTuiConfig();
  assert.equal(c.layout?.activityHeightDivisor, 2, "默认文件 1/2");
  assert.equal(c.layout?.statusColumnDivisor, 3, "默认文件 1/3");
  const missing = loadTuiConfig("/nonexistent/tui.config.json");
  assert.deepEqual(missing, { layout: {} }, "缺失文件回落默认");
});

test("metricsFor：footerHeight 绝对行数生效；statusDivisor 控制状态列宽（历史区保底 10 列）", () => {
  const def = metricsFor({ rows: 24, cols: 60 }, false, 1, 1);
  const cfg = metricsFor({ rows: 24, cols: 60 }, false, 1, 1, {
    footerHeight: 6,
    statusDivisor: 2,
  });
  assert.equal(def.footerHeight, 3, "默认输入态 交互区 4-1");
  assert.equal(cfg.footerHeight, 5, "配置 footerHeight=6 → 输入态 6-1");
  assert.equal(def.statusColWidth, Math.min(20, 50), "默认 cols/3=20");
  assert.equal(
    cfg.statusColWidth,
    Math.min(30, 50),
    "statusDivisor=2 → cols/2=30",
  );
});

test("activityHeight：divisor 控制活动区高（contentTopH / divisor）", () => {
  assert.equal(activityHeight(20), 10, "默认 divisor=2（1/2 比例）");
  assert.equal(activityHeight(20, 4), 5, "divisor=4 → 1/4");
  assert.equal(activityHeight(0, 2), 0, "无顶部空间时 0");
});
