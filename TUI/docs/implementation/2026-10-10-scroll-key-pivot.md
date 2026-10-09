# ↑/↓ 键位重分配：↑/↓ 专用于历史区翻页，输入历史改 Ctrl+P / Ctrl+N

接取条目：**↑/↓ 键位重分配：↑/↓ 专用于历史区翻页，输入历史改 Ctrl+P / Ctrl+N**（BACKLOG TUI 条目 8）

## 计划改动文件清单

| 文件 | 改动 |
| --- | --- |
| `TUI/src/app/index.ts` | ↑/↓ 分支删「输入历史接管」（含 `browseNext` 条件）；新增 `Ctrl+P` / `Ctrl+N` 分派；清理两个不再使用的 import |
| `TUI/tests/input-history.test.ts` | 用例按键改 `Ctrl+P` / `Ctrl+N`（`key()` 助手支持 ctrl 修饰）；新增「↑ 专用于历史区」回归用例；文件头与用例名同步 |
| `TUI/docs/DESIGN.md` | §182 输入历史条：键位改 Ctrl+P / Ctrl+N，记录 ↑/↓ 不再接管 |
| `TUI/README.md` | 键位表：`↑` / `↓` 补「到顶加载更旧」；新增 `Ctrl+P` / `Ctrl+N` 行 |
| `TUI/docs/BACKLOG.md` | 新增条目 8（进行中） |

## 现象与根因

真机报告（用户 2026-10-10）：「上箭头翻页有问题，似乎出现了循环」——按 ↑ 时**输入框**在旧输入之间循环，历史区纹丝不动；既到不了「到顶加载更旧」，也停不下来。

同构探针（30 回合带用户块 + 输入历史，`App` 真装配）在修复前的轨迹：

```
#0 input=""         hist=30   ← 按 ↑ 前
#1 input="第 30 问"  hist=30   ← ↑ 变成召回上一条输入
#2 input="第 29 问"  hist=30
#3 input="第 28 问"  hist=30
```

根因在 `index.ts` 的 ↑/↓ 分派：输入历史接管条件为
`inputText !== "" || isInputHistoryBrowse(state) || browseNext`，其中
`browseNext = isInputHistoryBrowseAt(state, cursor + 1)` = 「历史非空且 `cursor + 1 > 0`」——
游标 0（未在翻看态）时恒为真 → **空输入也接管**，与 `DESIGN.md` §182 原口径「输入区非空或已在翻看态才接管」不符。

滚动 / 扩窗机制本身无问题（同探针去掉输入历史后）：

```
#0 groups=3  top="...(更早回复已折叠)"
#1 groups=6  top="第 25 回合甲"     ← 到顶后自动加载更旧
...
#12 groups=30 top="第 3 回合甲"
#13 groups=30 top="第 1 回合甲"     ← 到最旧，再按无反应 ✓
```

## 裁定

用户 2026-10-10 二选一：**A. ↑/↓ 归历史区翻页；输入历史改 readline 惯例的 `Ctrl+P` / `Ctrl+N`**（另一选项是按「对话区有无可滚内容」分流）。

## 实现

1. `index.ts`：`Ctrl+P` / `Ctrl+N` 在 `switch` 之前分派（与 `Ctrl+J` / `Ctrl+S` 同位置），无面板焦点时 `input-history` `prev` / `next`；有面板焦点不接管（面板自有键位）。
1. `index.ts`：↑/↓ 分支删掉输入历史接管，只保留「补全候选 → 焦点面板滚动 / 对话区半屏滚动」。
1. `input-history.test.ts`：App 级用例按键改 `Ctrl+P` / `Ctrl+N`（`key()` 助手加 `ctrl` 修饰参数）；新增回归用例「↑ 专用于历史区：历史非空、输入为空时 ↑ 不再回溯输入」（断言 ↑ 后 `inputText` 仍为空、`dialogueTop` 移动，`Ctrl+P` 仍能取回最近一次提交）。

## 追加裁定（同日）：滚动粒度

用户 2026-10-10 追加：**裸 `↑` / `↓` = 一行（默认滚动粒度）、`Ctrl+↑` / `Ctrl+↓` = 半屏**（原先裸箭头即半屏）。

按键可达性实测（`TUI/tmp/key-probe.mjs`，临时探针）——终端对四种发**不同**序列：

| 按键 | 字节 | 解析 |
| --- | --- | --- |
| `↑` | `1b5b41` | `{up}` |
| `Shift+↑` | `1b5b313b3241` | `{up, shift}` |
| `Ctrl+↑` | `1b5b313b3541` | `{up, ctrl}` |
| `Alt+↑` | `1b5b313b3341` | `{up, meta}` |

解析层无需改动（`renderer/input.ts` 的 `stepCsi` 已按 shift=1 / meta=2 / ctrl=4 解析 `ESC [ 1 ; m A`）。

实现：`index.ts` 的 ↑/↓ 分支位移量改 `dir * (ctrl ? dialogueHalfPage(vh) : 1)`（两条路径都走同一套「先扩窗、再按扩窗后的段表施加位移」，故 1 行步进撞窗口顶时同样只多物化、不多滚）。焦点在活动区 / 状态列时仍是一行（未改）。

测试：`app.test.ts` 的半屏回归改用 `Ctrl+↑`（并保留「撞窗口顶不多滚」断言），另加「裸 ↑ = 一行」断言。文档：`README.md` 键位表拆两行、`docs/SPEC.md` §15.2 重写（段键位置模型 + 滚动粒度 + 陈旧锚点段清理）、`docs/DESIGN.md`「历史区」滚动条语义。

## 验证

- 同构探针（修复后）：↑ 期间 `input=""` 恒定、`windowGroups` 3→36 递增、视口顶内容单调上移（第 28 → 13 回合）✓
- `npm run check` 全绿；`npm run build` 通过；TUI 全量 **1410 用例全绿**（`input-history.test.ts` 8/8）
- 按键可达性核实：`Ctrl+P` = 控制字节 `0x10` / `Ctrl+N` = `0x0e`，`renderer/input.ts` 的 `decodeControl` 解出 `{name, ctrl: true}` ✓；现有绑定无 `Ctrl+P` / `Ctrl+N` 冲突（审批面板的 `n` 是无修饰键）
- **真机目视（用户 2026-10-10）**：① ↑/↓ 到顶加载更旧、到最旧停住 —— 「箭头正常了」✓；② `Ctrl+P` / `Ctrl+N` 回溯输入 —— 「输入历史也正常」✓
- 滚动粒度（追加裁定）实现后：`npm run check` 全绿、TUI 全量 1410 用例全绿；真机目视待确认（裸 ↑ 一行 / `Ctrl+↑` 半屏）

## 途中发现的新问题（已记入 BACKLOG，交后续条目）

1. 回合区没有清理「全空的正文」→ 条目 9。
1. 回合区不显示警告→ 条目 10（根因与条目 7 的「本地写入双写未闭合」同源：事件驱动的 notice 只入 reducer、不投块）。
1. 输入区粘贴多行内容被逐行输入并直接提交 → 条目 11（根因：`ESC[?2004h` 从未启用，bracketed paste 解析已就绪）。

## 收尾

条目 8 关闭：BACKLOG 移除该条；本追踪文档移入 `docs/archived/`。`docs/STATUS.md` 未改（用户择时更新）。
