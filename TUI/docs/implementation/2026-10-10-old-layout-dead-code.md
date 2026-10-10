# 旧排版遗留死代码清理（接取条目：`TUI/docs/BACKLOG.md`「旧排版遗留死代码清理」）

状态：进行中（2026-10-10 接取）

## 目标

- 删掉六步流水线切换后遗留的、**已无生产引用**的旧排版代码与符号，做到「不留只被测试吊着的生产代码」。
- 顺带把编译器已判定「声明但从未读取」的死引用清零，给「零死代码」一个可复跑的判据：`tsc --noUnusedLocals` 零报错。

## 调研

条目点名三组 + 两套判据（2026-10-10 实测，`grep -rn` 与 `npx tsc --noEmit --noUnusedLocals`）：

| 候选 | 全仓引用 | 结论 |
| --- | --- | --- |
| `ViewportInput` / `Viewport` | 只在本文件（`layout.ts`，二者互相引用） | 死集群 |
| `computeViewport` | 定义 + `tests/layout.test.ts` 7 处 | 只被测试吊着 → 删码 + 删用例 |
| `renderStatusPanel` / `renderJobsPanel` / `renderHistoryPanel` | 各自定义文件内（`components/StatusPanel.ts` / `JobsPanel.ts` / `HistoryPanel.ts`） | 无调用方 → 删函数（模块本身仍活：`build*PanelBox` 在用） |
| `frameFocus` / `statusBarSeamCols` / `DIALOGUE_MORE` / `FrameMetrics` / `TopPaneHeights` / `TopPaneSplit` | 定义文件外零引用 | 候选（逐个删后由 `tsc` 复核） |
| `RUN_TOGGLE_TOKENS` / `RUN_TOGGLE_FREQ_MIN` / `RUN_TOGGLE_FREQ_MAX` / `RUN_SPEED_RAMP_SECS` / `VIRT_RATE_TAU` / `VIRT_DECAY_TAU` | 定义文件外零引用 | 候选 |
| `VIRT_SPEED_MIN` / `VIRT_SPEED_MAX` / `VIRT_SLEW_RATE` | `src/app/state.ts` + `tests/layout4.test.ts` | **活代码**（虚拟步进速率），保留 |
| 编译器判死引用（`--noUnusedLocals`，共 53 条） | 分布在 `src/app/layout.ts`（`permColor` / `normalInput` / `wrapSegs` / `historyWidth` ×2）、`components/ModelPicker.ts`（`seg` / `provW` / `modelW` / `thinkW`）、`components/QuestionPrompt.ts`（`OPTION_CONT_INDENT` / `OPTION_DESC_INDENT`）、`layout/build-box.ts`、`layout/panel.ts`、`layout/pipeline/sections.ts`、`src/app/index.ts`、`src/main.ts`、`adapter/dsh.ts`、`demo/main.ts` 与 12 个测试文件 | 全部「声明但从未读取」 → 逐个删（删「读」不可能改变行为；被删的计算式均为纯求值） |

## 决策

- **D1 范围**：条目点名的三组为必做；**额外纳入** `--noUnusedLocals` 的 53 条（理由：它们与三组同属「声明后无人读」的死代码，且编译器判据比人工 grep 更硬；不纳入则本条目完工后 `--noUnusedLocals` 仍有 53 条噪声，下一次无人再查）。落点相应扩到 `src/main.ts` / `adapter/dsh.ts` / `demo/main.ts`。
- **D2 判据**：每个符号的删除都必须满足「删后 `tsc` 干净」+「全仓（含 tests）零引用」；`--noUnusedLocals` 归零作为可复跑验收。
- **D3 明确保留**：`VIRT_SPEED_MIN` / `VIRT_SPEED_MAX` / `VIRT_SLEW_RATE`（`state.ts` 的虚拟速率活代码）、`RunVirtState` 与 `virt-tick` 全链（下一步条目「状态列 Agents 闪烁」可能复用）、`build-box` / `fill` / `measure` / `markdown` / `table` / `primitives` / `content-rules` 等六步流水线在用的共享库、`layout.ts` 的组装与状态列/几何（活）。
- **D4 只被测试引用者一律删**（`computeViewport` 及其用例），不保留「测试专用生产 API」。
- **D5 文档**：被删符号若在 `SPEC.md` / `DESIGN.md` / `README.md` 有描述，同步删除或改口径（不新增描述）。
- **D6 不做**：不重构活代码、不动 `layout.ts` 的组装逻辑、不动主题与状态列行为（行为零变化：本条目只删无人读的声明）。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout.ts`（视口集群 / 自引用类型与常量 / 死局部）、`TUI/src/app/components/StatusPanel.ts`、`JobsPanel.ts`、`HistoryPanel.ts`（三个 `render*` 与仅其使用的辅助）、`components/ModelPicker.ts`、`components/QuestionPrompt.ts`、`layout/build-box.ts`、`layout/panel.ts`、`layout/pipeline/sections.ts`、`src/app/index.ts`、`src/app/adapter/dsh.ts`、`src/main.ts`、必要时 `demo/main.ts`。
- tests：`tests/layout.test.ts`（`computeViewport` 用例）、`tests/app.test.ts`、`tests/layout4.test.ts`、`tests/adapter.dsh.test.ts`、`tests/approval-panel.test.ts`、`tests/exit-confirm.test.ts`、`tests/policy.test.ts`、`tests/status-column.test.ts`、`tests/table.test.ts`。
- 文档：`TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`、`TUI/README.md`（如被删符号在文中出现）。

## 实现记录

- 2026-10-10：
  - **① 旧视口模型**：删 `ViewportInput` 与 `computeViewport`（`layout.ts`）；`tests/layout.test.ts` 的 `computeViewport` 用例段（5 例）与 import 一并删。**修正调研**：`Viewport` 不是死的——`buildTopRegion` 的局部 `vp`（回填 `FrameScrollReport` + pane 取行）用它做类型注解，故保留接口并改写注释（原按条目猜测「三个符号都删」会在 `tsc` 立刻报 `Cannot find name 'Viewport'`）。
  - **② 三个旧面板整屏渲染函数**：删 `renderStatusPanel` / `renderJobsPanel` / `renderHistoryPanel` 与仅其使用的 `StatusPanelView` / `JobsPanelView` 两个 interface 及随之无用的 `FrameRow` / `fillBoxTree` import（`build*PanelBox` 与 `statusMark` 保留，模块仍活）。
  - **③ 自引用符号逐个复核结论：全部在用，无删除项**——`frameFocus`（`buildFrame` 内调用）、`statusBarSeamCols`（上下分隔行两处）、`DIALOGUE_MORE`（折叠占位行）、`FrameMetrics` / `TopPaneHeights` / `TopPaneSplit`（活函数的返回类型）、`RUN_TOGGLE_*` / `RUN_SPEED_RAMP_SECS` / `VIRT_RATE_TAU` / `VIRT_DECAY_TAU`（虚拟速率数学）。条目原文把「只在本文件自引用」当成死代码，实际是「**本文件内被活函数读取**」→ 不动（`--noUnusedLocals` 也不报导出符号，可作交叉判据）。
  - **编译器判死的 53 条全部清掉**（`--noUnusedLocals` 归零）：`layout.ts`（`permColor` 函数、`wrapSegs` 函数、`normalInput`、两处 `historyWidth` 解构项）、`components/ModelPicker.ts`（`seg` import、`provW` / `modelW` / `thinkW`）、`components/QuestionPrompt.ts`（两个 `OPTION_*_INDENT` 常量；其两段 JSDoc 也一并删除，见审阅项）、`layout/build-box.ts`（`BufferKind`、`FrameSegment`）、`layout/panel.ts`（`Paragraph`、`text`）、`layout/pipeline/sections.ts`（`ToolResult`）、`index.ts`（`TURN_SEPARATOR`、`DIALOGUE_KEEP_REPLIES`）、`main.ts`（5 个未用 import + 死局部 `pipelineSink`）、`adapter/dsh.ts`（两个未用类型 import、`join`）、`demo/main.ts`（`policyPlain`）与 **9 个**测试文件的未用 import / 局部（实测本提交触及 `TUI/tests/*` 9 个；另 3 个的未用声明在此前两次清理中已删，53 条基线 = `035d7ac` 工作树 A/B 实测）。
  - 文档：`SPEC.md:412` 去掉 `computeViewport` 提及（改为「段表算定后的窗口，`Viewport` 结构」）。
  - **审阅（两份子代理，2026-10-10）**：决策审阅与完成审阅结论一致——**代码层无必改**（逐块核 `git show 33b5153 -- TUI/tests`：删的全是 import / 未读局部；顶层用例数 1383 → 1378 恰 −5 = `layout.test.ts` 删的 5 例；`exit-confirm.test.ts` 与 `a57125c` 差异恰 2 行；`--noUnusedLocals` 实测 0；③ 组 13 个符号逐个给出活读者行号）。折叠项：① `DESIGN.md:373` / `COMMANDS-SPEC.md:46` 的 `normalInput = !modalOpen` 改为「已删」口径；② `HistoryPanel.ts` 注释里的 `renderHistoryPanel`、`QuestionPrompt.ts` 的 `OPTION_CONT_INDENT` 引用与两段孤儿 JSDoc 清理；③ `main.ts` 四处「注释停用」说明补「恢复需补回 import」（审阅提示的隐藏坑）；④ 采纳建议：删 `Viewport` 的 `followBottom` / `scrollOffset` 两个「写后无人读」字段并同步 `SPEC.md:412` 措辞（`--noUnusedLocals` 不报对象字段，属判据盲区）。
  - **判据补充（审阅提出）**：`--noUnusedLocals` 不报 `export` 与对象字段；「全仓零引用 grep」判不出「本文件内被活代码读取」——条目原文把 13 个这类符号列为候选正是栽在此。后续同类清理应加两条判据：**export 面零引用** + **本文件内零活读者**。
  - **已知未覆盖项（审阅判定非必须，留档）**：删掉的 5 个 `computeViewport` 用例中 4 类语义在新路径有等价断言（`pipeline-rows.test.ts:53/71-80/102-112/114-134`、`scroll-position.test.ts:36-61/83-91`、`app.test.ts:4136-4188`、`layout4.test.ts:2680`）；唯 `buildFrame` 层「内容不足一屏 → `dialogueMaxScroll=0` 且 `dialogueTopIdx=0`」无直接断言（既有几何用例只覆盖长内容），未补。
  - **过程中的一次误删与修复（记录备查）**：清 53 条时我按编译器逐轮迭代删「报错那一行」，第 2/3 轮在 `tests/exit-confirm.test.ts` 级联删掉了两个用例体（删 `const { app, renderer, adapter } = makeApp()` 整行 → `renderer`/`adapter`/`frameText` 相继变「未读」→ 被逐轮删除）。`npm test` 立刻抓到（1 例失败、断言字面量被删成 `assert.equal(0, "...")`）；已 `git checkout HEAD --` 回滚该文件并改为只在解构里去掉 `app`（2 行）。**教训**：删除「未读取的声明」会使其下游使用者也变未读，级联删除必须逐文件人工复核，不能盲跑迭代。

## 测试与证据

- `npm run check`：干净；`npx tsc --noEmit --noUnusedLocals`：**0 条**（改动前 53 条）；`npm run build`：通过。
- `npm test`（TUI）：**1419 / 1419 通过**（改动前 1424 —— 差值 5 正是删除的 `computeViewport` 用例，无其它用例丢失）。
- 引用判据：条目点名的候选逐个 `grep -rn`（含 `tests` / `bench` / `demo`）后删除，删除后 `tsc` 干净；③ 组「自引用」符号经复核**全部有本文件活读者**，未删。
- 引用判据的另一半（审阅补充）：删除的 6 个函数/结构（`computeViewport` / `ViewportInput` / 三个 `render*Panel` / `permColor` / `wrapSegs`）在父提交 `a57125c` 上全仓各只出现 1 次（= 定义本身），确认删前即无读者。
- 未做：真机目视（验收含「真机目视帧不变」——本条目只删无人读取的声明与两个死函数，`build*PanelBox` / 组装路径零改动；真机项留给用户）。

## 收尾

（待填）
