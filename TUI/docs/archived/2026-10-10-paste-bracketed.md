# 输入区粘贴：启用 bracketed paste + 裸 CR 降级

## 条目

- 输入区粘贴多行内容被当成逐行输入并直接提交

## 计划改动文件清单

| 文件 | 改动 |
| --- | --- |
| `TUI/src/renderer/index.ts` | 启动写 `ESC[?2004h`（启用 bracketed paste）、退出/关闭写 `ESC[?2004l`（恢复终端状态） |
| `TUI/src/renderer/input.ts` | ① 粘贴载荷行尾归一（`\r\n` / `\r` → `\n`）；② 未启用协议时的裸 CR 降级（块内启发式） |
| `TUI/tests/input.test.ts` | 解码用例：CRLF / 裸 CR 多行 / 单 Enter 不变 / 粘贴载荷归一 |
| `TUI/tests/renderer.test.ts` | 启动与关闭写出 `?2004h` / `?2004l` |
| `TUI/tests/app.test.ts` | 多行粘贴 → `inputText` 含全部行、未发送、光标在末尾 |
| `TUI/docs/SPEC.md` | 输入解码一节：bracketed paste 契约与降级口径 |
| `TUI/README.md` | 键位表「终端粘贴」一行补「整段插入、不自动提交」 |
| `TUI/docs/BACKLOG.md` | 条目 11 标「进行中」→ 完成后移除 |

## 实施

### 1. 启用 bracketed paste（根因）

`renderer/index.ts` 的 raw 模式开关旁写模式序列：启动 `\x1b[?2004h`、`restore()` / `close()` 写
`\x1b[?2004l`（幂等：同一进程只写一次关闭序列）。终端此后把粘贴内容包在 `ESC[200~ … ESC[201~`
里，解码层既有的 `stepPaste()` 产出**单个** `paste` 事件，App 的 `case "paste"` 整段插入输入框、
不提交。

### 2. 载荷行尾归一

`stepPaste()` 产出的文本按 `\r\n` / 裸 `\r` → `\n` 归一：粘贴源（浏览器 / GUI 剪贴板）常带
CRLF，而输入框的行分隔符是 `\n`（与 Ctrl+J 同源）；不归一会把 `\r` 当可打印字符插进正文。

### 3. 裸 CR 降级（不支持该协议的终端）

无 bracketed paste 时粘贴内容以裸字节到达，`\r` 会被解码成 `enter` → 提交。降级口径（**块内启发式，不引入时钟**，保持解码层纯逻辑）：

| 情形 | 处置 | 依据 |
| --- | --- | --- |
| `\r` 紧跟 `\n`（同一块内） | 丢掉 `\r`，`\n` 照旧 → 换行 | CRLF 是 Windows / 网页复制的主形态；人手按 Enter 只发 `\r`，其后不会紧跟 `\n` |
| 同一块内出现 **≥2 个裸 `\r`** | 全部按换行（`ctrl+j`） | 一次 read 里两次回车只可能是粘贴；单次 Enter 恒为独立一块 |
| 其余裸 `\r`（含块尾） | 仍是 `enter` | 打字时相邻按键若被内核合并成一块（`abc\r`），Enter 不能丢 |

### 4. 文档

SPEC 补「输入解码 · bracketed paste 与降级」小节；README 键位表「终端粘贴」一行写明整段插入、
光标停末尾、不自动提交。

## 验证

- 单测：`tests/input.test.ts`（载荷归一 / CRLF 多行 / CR-only 多行 / 单 Enter 不变）、
  `tests/renderer.test.ts`（启动写 `?2004h` 且关闭只写一次 `?2004l`；`rawMode: false` 不写）、
  `tests/app.test.ts`（多行粘贴整段进输入框、未发送、光标在末尾）。
- 全量：`npm run check` / `npm run build` 干净，TUI 全量 **1423 用例全绿**（新增 7 例）。
- 真机（2026-10-10，用户复验通过）：粘贴三行 → 整段进输入框、未自动发送、光标停末尾；
  `Enter` 才发送；`/quit` 后 shell 粘贴行为正常（模式已还原）。

## 收尾

（条目 11「输入区粘贴多行内容被当成逐行输入并直接提交」已完成，2026-10-10 关闭并从 BACKLOG
移除；本文件移入 `TUI/docs/archived/`。真机复验由用户执行并通过。）
