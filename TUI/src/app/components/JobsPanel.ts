// src/app/components/JobsPanel.ts — /jobs 后台任务面板渲染（纯函数）
//
// 输出恰 height 行（渲染在活动区窗口并占满可视行；底部交互区以空白占位）。
// 数据源为 ctx.jobs 快照（adapter 经 onJobsChanged 增量推送 + 打开时 refreshJobs 拉全量）：
//   - 首行标题 + 任务计数；每任务一行：`>` 高亮标记 + 状态符号 + label（detail 作后缀）
//   - 状态着色：running/stopping 黄、failed/error 红、cancelled 灰、其余默认
//   - 底部按键提示行：↑/↓ 选择 · PgUp/PgDn 翻页 · Enter 取消 · Esc 关闭
// 高亮行恒在可见窗口内（窗口随 index 平移），列表放不下时截断显示。
// 无 ANSI 之外的着色；显示宽度截断（与 HistoryPanel 同风格）。

import type { FrameRow } from "../../renderer/index.ts";
import { fillBoxTree } from "../layout/fill.ts";
import type { ColorName } from "../../renderer/theme.ts";
import type { JobInfo } from "../adapter/dsh.ts";
import { truncateToWidth, displayWidth } from "../layout.ts";
import type { Box } from "../layout/box.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";

/**
 * 后台任务面板 Box 生成器（TUI/docs/design/DESIGN.md §7 / SPEC.md §7）：标题 + 运行中
 * 计数（青）+ 按键提示（灰）头部行、任务行（高亮`>` + 状态符号着色）、
 * 空列表占位。滚动窗口与截断算法保留在 build 内；叶子 styled wrap:false。
 */
export function buildJobsPanelBox(
  jobs: JobInfo[],
  index: number,
  height: number,
  width: number,
): Box {
  const rows = Math.max(1, height);
  const leaves = [];

  // 首行：标题 + 提示（双段：标题青、提示灰）
  const activeCount = jobs.filter(
    (j) => j.status === "running" || j.status === "stopping",
  ).length;
  const header =
    activeCount > 0
      ? `后台任务 (${jobs.length}，运行中 ${activeCount}）`
      : `后台任务 (${jobs.length}）`;
  const headerVisible = truncateToWidth(header, width);
  const hintText = "↑/↓ 选择 · PgUp/PgDn 翻页 · Enter 取消 · Esc 关闭";
  const hintVisible = truncateToWidth(
    hintText,
    Math.max(0, width - displayWidth(headerVisible) - 2),
  );
  const headSegs: {
    text: string;
    style?: import("../../renderer/screen.ts").FrameStyle;
  }[] = [
    { text: headerVisible, style: { fg: "cyan" as ColorName } },
    ...(hintVisible
      ? [{ text: `  ${hintVisible}`, style: { fg: "gray" as ColorName } }]
      : []),
  ];
  leaves.push(styled(headSegs, { wrap: false }));

  // 空列表占位
  if (jobs.length === 0) {
    leaves.push(
      styled([seg("（无后台任务）", { fg: "gray" as ColorName })], {
        wrap: false,
      }),
    );
    while (leaves.length < rows) leaves.push(styled([seg("")]));
    return v(leaves);
  }

  const taskRows = Math.max(1, rows - leaves.length);
  const clamped = Math.max(0, Math.min(index, jobs.length - 1));
  const windowStart = Math.max(0, Math.min(clamped, jobs.length - taskRows));
  for (let i = windowStart; i < jobs.length && leaves.length < rows; i++) {
    const job = jobs[i]!;
    const mark = statusMark(job.status);
    const label =
      job.label + (job.detail && job.detail !== "" ? ` ${job.detail}` : "");
    const line = `${i === clamped ? "> " : "  "}${mark.symbol} ${job.status} ${label}`;
    const text = truncateToWidth(line, width);
    leaves.push(
      mark.color
        ? styled([seg(text, { fg: mark.color })], { wrap: false })
        : styled([seg(text)], { wrap: false }),
    );
  }
  while (leaves.length < rows) leaves.push(styled([seg("")]));
  return v(leaves);
}

export interface JobsPanelView {
  /** adapter 推送的最新 jobs 快照 */
  jobs: JobInfo[];
  /** 高亮任务在 jobs 中的索引（Enter 取消它）；空/越界时 clamp */
  index: number;
  /** 面板可用行数（footer 高度） */
  height: number;
  /** 面板可用列宽 */
  width: number;
}

/** 状态 → 符号 + 语义色名（运行中黄 / 失败红 / 取消灰 / 成功默认前景） */
export function statusMark(status: string): {
  symbol: string;
  color: "yellow" | "red" | "gray" | undefined;
} {
  if (status === "running" || status === "stopping") {
    return { symbol: "●", color: "yellow" };
  }
  if (status === "failed" || status === "error") {
    return { symbol: "✗", color: "red" };
  }
  if (status === "cancelled" || status === "canceled") {
    return { symbol: "○", color: "gray" };
  }
  // 共享面板（/agents）的冷条目与诊断条目：统一灰显（jobs 无此状态值，向后兼容）
  if (status === "inactive" || status === "diagnostic") {
    return { symbol: "○", color: "gray" };
  }
  return { symbol: "✓", color: undefined };
}

/** 一行（首行或任务行） → FrameRow[]；把超宽文本截断后按需着色 */
export function renderJobsPanel(view: JobsPanelView): FrameRow[] {
  // 薄包装：单一数据源 buildJobsPanelBox → fillBoxTree
  return fillBoxTree(
    buildJobsPanelBox(view.jobs, view.index, view.height, view.width),
    view.height,
    view.width,
    "dark" as never,
  );
}
