# 宽度表改为「符号列表落盘 + 宽度只存内存」（接取条目：`TUI/docs/BACKLOG.md` 的〈宽度表改为「符号列表落盘 + 宽度只存内存」：启动预探测 + 中途按需补测〉）

状态：进行中　　开启：2026-10-12
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

- 落盘只存**不确定符号列表**（`<profile>/tui-width-symbols.json`：码点 hex 数组，去重、按最近出现排序；**不存宽度、不存终端标识**；不设上限不淘汰）。
- **宽度只存内存**：`WIDTH_OVERRIDES`（每进程一张表）+ `WIDTH_PROBE_ATTEMPTED`（同一码点每进程只发起一次实测）。
- 启动时读列表 → 按最近出现优先批量预探测（复用 `probeSymbolWidths` 的 CPR 列差；**探测前 `?25l` 隐藏光标、探测结束恢复**，复用 `renderer/screen.ts` 的 `CURSOR_HIDE` / `CURSOR_SHOW`；不设严格时间限制）。
- 中途遇到不确定字符仍按需实测，并把码点**追加进列表**；会话结束时**原子写一次**。
- `TUI_WIDTH_PROBE=0` 时**不读也不写**；旧 `tui-width-table.json` **不读、不写、不删**。

## 讨论定稿（2026-10-12，用户裁定）

- 原方案（终端探测 + 按终端分文件 + 文件名 key + 旧表迁移 + tmux 透传 + 字体 / 字号签名）**整体撤销** —— 宽度不跨会话复用后，这五件事失去意义。
- 讨论过程要点：整池预探测不可行（242 区段 / 139,522 码点，按 80 列每批 39 个 ≈ 3,578 批 + 3,578 次写屏）；现状本就是「按需实测 + 内存覆盖」，落盘只是跨会话预置；用户提出「落盘存符号列表、宽度只存内存、每进程每符号只测一次」= 本方案。
- 已知取舍（不做事前防御）：启动探测会在空白屏闪现探测字符几毫秒；未进列表的符号首现仍有一帧抖动；列表随时间单调增长，靠「最近优先」保体验。
- 用户原话口径：「闪烁现在可以接受，等待时间也是，不用给太严格的限制。有问题后面再说。」

## 计划改动文件清单

- 删 `TUI/src/app/layout/width-table.ts`（IO 模块整体换成符号列表模块）。
- 新增 `TUI/src/app/layout/width-symbols.ts`：列表读（缺失 / 损坏 / 空 → 空列表）、原子写（临时文件 + rename）、去重追加、「最近出现优先」顺序。
- `TUI/src/app/index.ts`：删 `loadWidthTable` / `saveWidthTable` 与相关 import；启动时读列表并在**首帧之前**预探测（探测期间隐藏光标）。
- `TUI/src/app/layout/markdown.ts`：确保能取出「本次会话实测到的码点」用于追加（若 `widthOverrideEntries()` 不够则补出口）。
- `TUI/tests/width-table.test.ts` → 改写为 `TUI/tests/width-symbols.test.ts`（列表读写用例）+ 预探测接线用例。
- 文档：`TUI/docs/SPEC.md`（若记有宽度表落盘口径则同步）+ 本文件 + `TUI/docs/BACKLOG.md`。

## 实现记录

1. 新增 `layout/width-symbols.ts`：符号列表读 / 原子写（版本 1、去重、非法码点丢弃、权限 0600、临时文件 + rename）。
1. `index.ts`：删 `loadWidthTable` / `saveWidthTable`（连带 `readWidthTable` / `writeWidthTable` / `terminalKey` / `widthOverrideEntries` 的 import）；改为 `loadWidthSymbols`（`TUI_WIDTH_PROBE=0` 时**不读**）+ `recordWidthSymbols` / `rememberWidthSymbols`；新增 `probeSymbolsAtStartup`（首帧前按列表整批实测，`STARTUP_PROBE_TIMEOUT_MS = 1200`；**有列表则首帧等探测完再出**）；`probeThenRender` 里实测成功改为「码点并入列表 + 原子落盘」，不再写宽度。
1. `renderer/screen.ts` + `renderer/index.ts`：`CURSOR_HIDE` / `CURSOR_SHOW` 改为导出；`probeSymbolWidths` 探测前隐藏光标、结束恢复（用户要求）。
1. 删 `layout/width-table.ts` 与 `tests/width-table.test.ts`；新增 `tests/width-symbols.test.ts`；`tests/width-probe.test.ts` 的落盘用例改写成「启动按符号列表预探测」，并断言探测期间隐藏 / 结束恢复光标。
1. 文档：`docs/SPEC.md` §宽度表（「落盘复用」→「符号列表落盘 + 启动预探测」）；`main.ts` / `markdown.ts` / `eaw-table.ts` 注释里的旧模块引用；顺带删掉失去消费者的 `widthOverrideEntries`（无引用）。
1. **与定稿的一处偏离（待你确认）**：落盘时机不是「会话结束时写一次」，而是**每次实测成功即原子写一次**（文件很小、幂等）——进程被 kill 也不丢新增，且不必依赖 dispose 路径。

## 真机回归与修正（2026-10-12）

- **现象**（用户真机反馈）：有的符号宽度判断不对；边框某一行消失。
- **原因判断**：启动预探测原先安排在**首帧之前**（`paintNow()` 之前）——那一刻 alt screen / 尺寸尚未落定，CPR 列差不是在应用画布上量的（会实测出错的宽度），探测残留也没有帧去覆盖。
- **修法**：预探测改到**首帧之后**发起（`this.paintNow(); this.probeSymbolsAtStartup();`），并改走既有 `probeThenRender` 路径（实测 → 重排 → 整帧重绘覆盖残留）；该批用 `STARTUP_PROBE_TIMEOUT_MS`（1200 ms，只有启动这一批用它，中途仍 150 ms）。
- **验证**：`tests/width-probe.test.ts` 启动用例仍绿（首帧先出、探测随后发起、回包后按实测宽度重排）；TUI 全量 **1470 / 1470**；`check` / `build` 0 错；已重新 build —— **待用户再真机复核**。

## 测试与证据

- 单测：`tests/width-symbols.test.ts` **3 / 3**（往返 + 无 .tmp 残留 / 缺失损坏版本与非数组回落 / 1000 条不设上限）；`tests/width-probe.test.ts` **13 / 13**（新增「探测前隐藏、结束恢复光标」断言 + 启动预探测接线改写）。
- 全量：TUI `npm test` **1470 / 1470**；全仓 `npm test` 退出码 0（21 包全 OK）；`npm run check` / `npm run build` 各 0 条 TS 错；冒烟见下。
- 冒烟（回归证据）：`npm run demo -- --smoke` = **42 PASS / 0 FAIL**（demo 走 mock renderer，无探测，路径不受影响）。
- 真机复核：**待用户确认** —— ① 首帧不再对常见符号抖动；② profile 目录里不再更新 `tui-width-table.json`，改为出现/更新 `tui-width-symbols.json`；③ 启动多等的时间可接受。

## 审阅记录

（待补）

## 收尾

（待补）
