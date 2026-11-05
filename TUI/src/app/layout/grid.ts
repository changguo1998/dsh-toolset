// TUI/src/app/layout/grid.ts — 框线网格（行角色 → 框线字形）
//
// 分区层的框线字形**逐行不同**：分隔竖线列（状态列右缘/会话区左缘）在内容行是
// `│`（竖线贯穿）、在横线行是 `├`（横线自右接入）；右缘框列只在横线行是 `─`
// （铺满到最右列），其余行（回合区、会话区内容行、回合分隔线）**一律不落字形**
// （内容到正文右缘为止；2026-11-05 起不再用空白占位列，避免上下排列时会话区右侧
// 多出一列空白，且该占位非框线字形、聚焦时本就无法被 focusFrame 变亮）。
// Box 库的 `separator` / `suffix` 只能挂**单个固定字符**，
// 故字形由本模块按**行角色**统一给出，拼帧层在行内取字形（不做事后整帧扫描）。
//
// 只做**焦点中性基线**：亮角字/亮边仍由 focusFrame 按焦点态覆写（DESIGN §8）。
// 交点字（`┬` / `┴` / `┼`）的判定在 `content-rules.ts` 的 `teeGlyph`（既有唯一来源）。
//
// 口径依据（2026-10-13 决策 4b/10 + bench）：曾试过「事后整帧基线 pass」（复用
// focus-frame 的 setCell 逐格改写），一行一列各一次改写即让 buildFrame 的 cache off
// 档从 0.47ms 涨到 1.90ms（4×）——故改为纯映射函数，行内取字形，零额外遍历。

// 本模块右缘恒 null（2026-11-05 起 FRAME_RIGHT_COLS=0），不再依赖 ACTIVITY_SEPARATOR

/**
 * 顶部区域行角色（决策 10：先 4 类，阶段 2 按需追加状态行 / 输入区 / 提示行角色）。
 * - `border`：横线行——标题栏下划线、回合区分隔行（横线铺满，竖线列出 `├`）
 * - `rule`：回合分隔行（内容层 kind=separator）——只铺到**正文文字宽**，右缘框列留空
 * - `activity`：回合区行（纵向回合区 / 横向右 pane）——不补白、右缘不落字形
 * - `body`：普通内容行
 */
export type GridRole = "border" | "rule" | "activity" | "body";

/** 行角色判定：横线行 > 回合区行 > 回合分隔行 > 普通行（判据由拼帧层按行给出） */
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
 * 右缘框列字形：恒返回 `null`（不落字形）。
 * 2026-11-05 起 `FRAME_RIGHT_COLS = 0`（区域右缘不再保留列，`contentW = historyWidth`），
 * 内容文字可铺到屏幕最右列；横线行（border）的满宽由 `contentSegs`（下划线铺到 contentW）
 * 保证，不再需要右缘补 `─`。故所有角色右缘一律不落字形，`rightFrame` 判定随
 * `FRAME_RIGHT_COLS > 0` 恒为 false，`top-region` 不再拼右缘字形。
 */
export function rightEdgeGlyph(_role: GridRole): string | null {
  return null;
}
