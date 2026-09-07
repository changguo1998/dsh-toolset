// src/app/components/JobsPanel.ts — /jobs 后台任务面板渲染（纯函数）
//
// 输出恰 height 行（占满固定交互区，与 /goal、/history 等面板同一区域）。
// 数据源为 ctx.jobs 快照（adapter 经 onJobsChanged 增量推送 + 打开时 refreshJobs 拉全量）：
//   - 首行标题 + 任务计数；每任务一行：`>` 高亮标记 + 状态符号 + label（detail 作后缀）
//   - 状态着色：running/stopping 黄、failed/error 红、cancelled 灰、其余默认
//   - 底部按键提示行：↑/↓ 选择 · Enter 取消 · Esc 关闭
// 高亮行恒在可见窗口内（窗口随 index 平移），列表放不下时截断显示。
// 无 ANSI 之外的着色；显示宽度截断（与 HistoryPanel 同风格）。

import type { RenderLine } from "../../renderer/index.ts";
import type { ThemeId } from "../../renderer/theme.ts";
import { colorFor } from "../../renderer/theme.ts";
import type { JobInfo } from "../adapter/dsh.ts";
import { truncateToWidth } from "../layout.ts";

export interface JobsPanelView {
  /** adapter 推送的最新 jobs 快照 */
  jobs: JobInfo[];
  /** 高亮任务在 jobs 中的索引（Enter 取消它）；空/越界时 clamp */
  index: number;
  /** 面板可用行数（footer 高度） */
  height: number;
  /** 面板可用列宽 */
  width: number;
  themeId: ThemeId;
}

/** 状态 → 符号 + 着色（运行中黄 / 失败红 / 取消灰 / 其余默认） */
export function statusMark(
  themeId: ThemeId,
  status: string,
): { symbol: string; color: (s: string) => string } {
  const gray = colorFor(themeId, "gray");
  if (status === "running" || status === "stopping") {
    return { symbol: "●", color: colorFor(themeId, "yellow") };
  }
  if (status === "failed" || status === "error") {
    return { symbol: "✗", color: colorFor(themeId, "red") };
  }
  if (status === "cancelled" || status === "canceled") {
    return { symbol: "○", color: gray };
  }
  return { symbol: "✓", color: (s: string) => s };
}

export function renderJobsPanel(view: JobsPanelView): RenderLine[] {
  const { jobs, index, height, width, themeId } = view;
  const out: RenderLine[] = [];
  const rows = Math.max(1, height);

  // 首行：标题 + 运行中计数（只对运行中/停止中任务计数）
  const activeCount = jobs.filter(
    (j) => j.status === "running" || j.status === "stopping",
  ).length;
  const header =
    "后台任务 (" +
    jobs.length +
    (activeCount > 0 ? "，运行中 " + activeCount + "）" : "）");
  out.push({
    text:
      colorFor(themeId, "cyan")(truncateToWidth(header, width)) +
      "  " +
      colorFor(themeId, "gray")("↑/↓ 选择 · Enter 取消 · Esc 关闭"),
  });

  // 空列表占位；否则从高亮行反向确定窗口，保证 index 恒可见
  if (jobs.length === 0) {
    out.push({ text: colorFor(themeId, "gray")("（无后台任务）") });
    while (out.length < rows) out.push({ text: "" });
    return out;
  }
  const taskRows = Math.max(1, rows - out.length); // 剩余行填任务
  const clamped = Math.max(0, Math.min(index, jobs.length - 1));
  const windowStart = Math.max(0, Math.min(clamped, jobs.length - taskRows));
  for (let i = windowStart; i < jobs.length && out.length < rows; i++) {
    const job = jobs[i]!;
    const mark = statusMark(themeId, job.status);
    const label =
      job.label + (job.detail && job.detail !== "" ? " " + job.detail : "");
    const line =
      (i === clamped ? "> " : "  ") +
      mark.symbol +
      " " +
      job.status +
      " " +
      label;
    out.push({ text: mark.color(truncateToWidth(line, width)) });
  }
  while (out.length < rows) out.push({ text: "" });
  return out;
}
