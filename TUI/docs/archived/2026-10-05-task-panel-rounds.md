# 任务面板多轮无轮次标识（接取条目：`TUI/docs/BACKLOG.md`「任务面板多轮无轮次标识」）

状态：关闭　　开启：2026-10-05　　关闭：2026-10-05

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 计划改动文件清单（只改这些）

- `TUI/src/app/adapter/dsh.ts`（`refreshTasks` 行映射：轮根行**行首**标注轮次）
- `TUI/src/app/adapter/types.ts`（`TaskEngineTaskLike.round?`）
- `TUI/tests/adapter.dsh.test.ts`（多轮 / id 跳号 / 无 round 回落 / 空森林 / 单轮零噪声）
- `TUI/tests/command-panel.test.ts`（渲染级宽度断言：行首标注在窄面板右截断后仍可见；决策审阅补入）
- `TUI/docs/DESIGN.md`（「共享列表面板」小节补轮次标注口径）
- `TUI/docs/BACKLOG.md`（条目 1 状态、落点与验收同步、清理）
- `task-engine/docs/BACKLOG.md`（该条目按落点移出，改为空标记）
- `TUI/docs/implementation/2026-10-05-task-panel-rounds.md`（本文件）

**落点修正**：BACKLOG 原写 `TUI/src/app/dsh.ts` + `TUI/docs/SPEC.md`——实际任务面板接线在 `TUI/src/app/adapter/dsh.ts`（`dsh.ts` 不在 `src/app/` 根），且 `SPEC.md` 无 /task 面板行格式章节；面板行的活文档在 `TUI/docs/DESIGN.md`（口径落在「共享列表面板」小节，`/task` 那行是 4 命令共用、不宜承载单命令口径）。故按实际落点改这些文件（口径更正记录在此，不改 SPEC.md）。

## 调研（已核）

- 面板数据源唯一：`adapter.refreshTasks()`（`TUI/src/app/adapter/dsh.ts:3190-3215`）读 `taskEngine.query()` → `flattenTasks()` 先序展平 → `command-panel-data(kind=task)`；`kind: "task"` 的生产者仅此一处（`index.ts:3957` 是命令入口，不是行生产者）。
- `flattenTasks`（`dsh.ts:875`）只带 `id/title/status/needDecompose/depth`；`FlatTask` 无轮次概念；`findTask`（Enter 详情用）复用同一函数。
- 行结构 `CommandPanelRow`（`adapter/types.ts:1109`）：`title` / `detail?` / `status?` / `payload?` / `blockedReason?`；渲染在 `layout.ts` 共享面板（行 = 高亮前缀 + 状态符号 + 主文本，detail 为副文本）。
- TUI 侧类型 `TaskEngineTaskLike`（`types.ts:1262`）**没有 `round` 字段**（引擎 `NestedTaskItem.round?` 有）；森林顺序 = 轮次顺序（引擎 `toNested` 按 `rootIds` 顺序给 1 起 `round`）。
- `blockedReason` 的既有语义是「Enter 被禁用 + 原因提示」（agents 面板一次性条目、`index.ts:1824` 渲染），**不是**分组表头概念。
- 现有测试：`TUI/tests/adapter.dsh.test.ts:4796`（单轮快照：缩进 / status / payload / `detail = "todo · 待拆分"`）、`TUI/tests/command-panel-task.test.ts`（面板开关与键位，用 stub 行）。
- demo 的 mock 无 /task 面板数据（`TUI/demo` 无 `refreshTasks`）→ 冒烟断言不受影响。

## 决策

（2026-10-05 决策审阅后修订：标注载体由「detail 尾」改为「title 行首」，见「子代理审阅」）

- **A（选定）**：多轮（森林 > 1 棵）时给**每个轮根行**的行首加轮次标注——旧轮 `旧轮 n · `、当前轮 `当前轮 n · `；子帧行与单轮都不加（零噪声）。轮次取 `t.round ?? 轮根序号`（兼容旧版引擎无 `round` 的宽类型面；id 跳号不代表轮次，故不解析 id）。
- B：插入分组表头行（`── 第 1 轮（旧）──`）——否决：面板行都是可选列表项，无载荷行的 Enter 会**先关面板再弹 info notice**（`index.ts` handleEnter），表头还会占高亮与翻页窗口，需新增行类型才干净。
- C：旧轮整棵折叠成一行——否决：面板无折叠概念，且旧轮子帧失去 Enter 详情入口（信息损失），超出本条范围。

选 A 理由：落点最小（一处行映射 + 一个可选字段），直接用「哪棵是新轮」的判据（轮根行）解题；不与既有面板语义冲突；单轮用户无感。

**载体必须在 title 行首**（审阅实测）：行渲染是 `> ` + 符号 + `title` + ` — detail` 单行拼接后 `truncateToWidth` 右截断（`components/CommandListPanel.ts`），detail 最右 ⇒ 窄面板下 detail 尾的标注首个被丢弃 —— 实测（`renderCommandListPanel`，长标题 24 列）宽 53 时 `（旧）` 已丢、宽 40 时整段标注消失；行首载体在 28 / 40 下都完整可见。`status` 不作为载体：它只映射符号与颜色，不显示文本。

明确不做：不改 task-engine（`query()` 仍给全量森林——引擎面契约不变）；不做面板折叠；`taskDetail` 弹窗不加轮次行（本条只要列表可分辨）。

## 实现记录

- `TUI/src/app/adapter/types.ts`：`TaskEngineTaskLike.round?: number`（引擎多轮轮次，1 起；只出现在轮根上，旧版引擎无此字段）。
- `TUI/src/app/adapter/dsh.ts` `refreshTasks`：森林 → 轮根 id→轮次映射 → 末项 id = 当前轮 → 轮根行行首 `旧轮 n · ` / `当前轮 n · `；注释锁住边界（标注在行首、只在此映射加、不进 `flattenTasks`）。轮次口径为 **all-or-nothing**：引擎 `round` 全部轮根都有才用，任一缺失则整片回落轮根序号（避免同森林两种口径混用串号）。
- `TUI/tests/adapter.dsh.test.ts`：+4 例（多轮标注含子帧行不加；id 跳号 `root` / `root-3` 按 `round` 标 1/2；多根全无 `round` → 整片回落序号；空森林 → 无行不抛），并把原单轮用例补一条「单轮不加标注」断言。
- `TUI/tests/command-panel.test.ts`：+1 例渲染级宽度断言（28 = 随包 `tui.config.json` 下 80×24 的实测面板宽；40 对照）——行首标注在右截断后仍可见。
- `TUI/docs/DESIGN.md`：轮次标注口径写进「共享列表面板（`commandPanel`）」小节（审阅建议：`/task` 那行是 4 命令共用，不宜承载单命令口径）。

## 测试与证据

- `cd TUI && npm run check` → 通过。
- `cd TUI && npm run test -- tests/adapter.dsh.test.ts tests/command-panel.test.ts` → 全绿（含新增 5 例）。
- `cd TUI && npm run test` → 全包全绿（1323+）；根 `npm run check` / `build` / `test` → 21 包全 `fail 0`；`npm run demo -- --smoke` → `SMOKE_OK`（demo 无 /task 面板数据，改动不影响其断言）。
- 反向（变异）验证：去掉标注（`tag` 恒空）→ 2 个 adapter 用例红（载体位置），恢复后绿。渲染级用例守护的是另一条性质——「标注放行首则右截断后仍可见」（把标注挪回 detail 尾的对照实测见「决策」节：宽 53 丢 `（旧）`、宽 40 全丢）。

## 子代理审阅

**决策审阅**（2026-10-05，只读，结论「需修」）与处置：

1. 〔重要〕标注放 detail 尾会被右截断吃掉，且当时的计划测试看不见（只读事件里的 row 对象）→ 标注改 title 行首（`旧轮 n · ` / `当前轮 n · `，比审阅建议的 `第 n 轮（旧）` 更短），并补 `tests/command-panel.test.ts` 的**渲染级宽度断言**。
1. 〔次要〕`flattenTasks` 与 `findTask` 共用，标注写进去会连带进 `taskDetail` → 标注留在 `refreshTasks` 行映射，并在该处加注释锁边界。
1. 〔次要〕追踪文档对 B 的理由不准（不是「弹提示」）→ 已改为「无载荷行 Enter 先关面板再 info notice」。
1. 〔次要〕BACKLOG 验收文案与 DESIGN 落点 → 验收与落点已同步（行首标注 +「共享列表面板」小节）。
1. 〔提示〕`status` 不能承载轮次、与 `· 待拆分` 无冲突 → 已按此定（status 只映射符号）。
1. 另修正：调研里的行号漂移（`TaskEngineTaskLike` 实为 `types.ts:1250-1258`；行渲染在 `components/CommandListPanel.ts`，`layout.ts` 只做选型）。

**收尾审阅**（2026-10-05，只读，结论「需修：无阻断」）与处置：

1. 〔重要〕BACKLOG 验收 / 落点仍写 detail 尾与「命令实现落点」行，而追踪文档却声称已同步（说做了没做）→ 已实际同步 `TUI/docs/BACKLOG.md`（title 行首 + 共享列表面板小节 + 两个测试文件）。
1. 〔次要〕渲染级用例宽度口径错（53 是 `regionColumnWidth`，面板实际排版宽 = `activityTextW`，随包配置下 80×24 实测 28；且 53 下行未截断，该宽度零覆盖）→ 已改 28 / 40，注释写明口径来源。
1. 〔次要〕混合形态串号（逐项回落 `round ?? i+1`）→ 已改 all-or-nothing（全有才用 `round`，否则整片序号），并删掉不可达的 `?? 0`；当前轮判定改用「末项 id」而非轮次数值比较。
1. 〔次要〕`?? 轮根序号` 与空森林两条分支无用例 → 已各补一例（见实现记录）。
1. 〔次要〕格式（`dsh.ts` / 测试文件 prettier、追踪文档 mdformat）→ 提交前统一 `format`；清单漏列 `tests/command-panel.test.ts` → 已补进清单。
1. 〔提示〕`depth === 0` 判轮根在「扁平 tasks」形态下会误标 —— 真实引擎恒嵌套（`query()` → `toNested`），保留现状并在此留痕；`taskDetail` 仍只给 `id` —— 属本条明确不做项。

## 收尾

- 回写文档：`TUI/docs/DESIGN.md`（「共享列表面板」小节）；`TUI/docs/BACKLOG.md` 条目清理；`task-engine/docs/BACKLOG.md` 空标记。
- 未改：`TUI/docs/SPEC.md`（无 /task 行格式章节）、`README.md`（面板行为非命令契约面）、`TUI/demo`（无 /task 数据）。
- 遗留项：无；`tmp/` 无本次残留（调试脚本与变异备份已删）。
- 真机：面板行文案变化无需重启宿主即可见（下次 `/task` 打开即新文案）；建议实测一次多轮会话的 `/task` 面板。
