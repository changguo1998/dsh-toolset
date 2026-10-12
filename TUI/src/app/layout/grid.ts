// TUI/src/app/layout/grid.ts — 框线网格（行角色 → 框线字形）
//
// 分区层的框线字形**逐行不同**：分隔竖线列（状态列右缘/历史区左缘）在内容行是
// `│`（竖线贯穿）、在横线行是 `├`（横线自右接入）；右缘框列在横线行是 `─`、
// 在回合分隔行是 `╌`、在活动区行**不落字形**（内容到正文右缘为止）、其余行是空白
// 占位（供 focusFrame 覆写）。Box 库的 `separator` / `suffix` 只能挂**单个固定字符**，
// 故字形由本模块按**行角色**统一给出，拼帧层在行内取字形（不做事后整帧扫描）。
//
// 只做**焦点中性基线**：亮角字/亮边仍由 focusFrame 按焦点态覆写（DESIGN §8）。
// 交点字（`┬` / `┴` / `┼`）的判定在 `content-rules.ts` 的 `teeGlyph`（既有唯一来源）。
//
// 口径依据（2026-10-13 决策 4b/10 + bench）：曾试过「事后整帧基线 pass」（复用
// focus-frame 的 setCell 逐格改写），一行一列各一次改写即让 buildFrame 的 cache off
// 档从 0.47ms 涨到 1.90ms（4×）——故改为纯映射函数，行内取字形，零额外遍历。

import { ACTIVITY_SEPARATOR, TURN_SEPARATOR_CHAR } from "./content-rules.ts";

/**
 * 顶部区域行角色（决策 10：先 4 类，阶段 2 按需追加状态栏 / 输入区 / 提示区角色）。
 * - `border`：横线行——标题栏下划线、活动区分隔行（横线铺满，竖线列出 `├`）
 * - `rule`：回合分隔行（内容层 kind=separator；右缘补 `╌` 使横线连到框列）
 * - `activity`：活动区行（纵向活动 pane / 横向右 pane）——不补白、右缘不落字形
 * - `body`：普通内容行
 */
export type GridRole = "border" | "rule" | "activity" | "body";

/** 行角色判定：横线行 > 活动区行 > 回合分隔行 > 普通行（判据由拼帧层按行给出） */
export function gridRole(row: {
  borderRow: boolean;
  actRow: boolean;
  ruleRow: boolean;
}): GridRole {
  if (row.borderRow) return "border";
  if (row.actRow) return "activity";
  if (row.ruleRow) return "rule";
  return "body";
}

/** 分隔竖线列字形：横线行用连接字 `├`（竖线贯穿 + 横线右接入），其余 `│` */
export function dividerGlyph(role: GridRole): string {
  return role === "border" ? "├" : "│";
}

/**
 * 右缘框列字形：`null` = 该行**不落字形**（活动区行内容到正文右缘为止）；
 * `" "` = 空白占位（等宽占位列，供 focusFrame 覆写角字/竖线）。
 */
export function rightEdgeGlyph(role: GridRole): string | null {
  if (role === "activity") return null;
  if (role === "border") return ACTIVITY_SEPARATOR;
  if (role === "rule") return TURN_SEPARATOR_CHAR;
  return " ";
}
