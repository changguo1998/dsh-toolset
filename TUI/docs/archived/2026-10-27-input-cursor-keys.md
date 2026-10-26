# 翻页键只在会话 / 回合区聚焦时生效，否则在输入区移动光标

状态：完成　　开启：2026-10-27
接取条目：`TUI/docs/BACKLOG.md`「翻页键只在会话 / 回合区聚焦时生效，否则在输入区移动光标」。
本文件是本任务唯一的过程记录与文档变更落点。

## 口径（用户 2026-10-27）

- 只有**会话区（history）/ 回合区（activity）聚焦**时，`↑`/`↓`、`PgUp`/`PgDn`、`Home`/`End`
  才当翻页键（沿用现有滚动语义）。
- 否则（无面板焦点 = 正在编辑输入）这些键移动输入光标：
  - `↑`/`↓`：上下移一行，尽量落在同一**显示列**（宽字符按列宽算）；
  - `←`/`→`：一次一格（原有行为不变）；
  - `Home`/`End`：整串开头 / 结尾（原有行为不变）；
  - `PgUp`/`PgDn`：光标所在行的行首 / 行尾。
- 状态列（status）聚焦时的滚动不变。

## 实现

- `TUI/src/app/state.ts`：新增两个纯函数
  - `inputLineBounds(text, cursor)`：光标所在行起止下标（PgUp/PgDn 用）；
  - `inputLineMove(text, cursor, dir)`：上/下一行同显示列落点（`dir = -1` 上一行、`1` 下一行），
    首/末行不动。
- `TUI/src/app/index.ts`
  - `case "up" / "down"`：`focusedPanel === null` 时改走 `inputLineMove`（注意方向与翻页相反），
    其余走原滚动；补全候选打开时仍优先在候选间移动。
  - `case "pageup" / "pagedown"`：`focusedPanel === null` 时跳 `inputLineBounds` 的行首 / 行尾。

## 测试

- 新增 `TUI/tests/input-cursor-keys.test.ts`（3 例）：多行输入下 ↑/↓ 同显示列、←/→ 一格、
  Home/End 整串首尾、PgUp/PgDn 行首行尾、聚焦会话区时这些键不动输入光标。
- 旧用例按新分派口径调整（先 `Ctrl+E` 聚焦再按翻页键）：
  `tests/app.test.ts`「history 焦点空输入：↑ 上滚对话区…」「对话区滚动：上滚越顶…」
  「对话区滚动粒度…」、`tests/input-history.test.ts`「↑ 专用于历史区…」、
  `tests/pipeline-app.test.ts`「PgUp 逐条走到最旧回合…」。

## 证据

- `tsc --noEmit` 通过；TUI 全量 **1804 例全绿**（原 1801 + 新增 3）。

## 收尾

- 提交 `5109d34`（代码 + 测试 + 追踪文档 + 条目）；TUI 全量 1804 例全绿。
- 真机确认由用户择时进行；`STATUS.md` 由用户择时更新。
