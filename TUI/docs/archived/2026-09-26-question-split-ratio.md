# 问答分窗比例策略修订（BACKLOG: TUI#3.2.11）

状态：关闭　　开启：2026-09-26　　关闭：2026-09-26

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把问答面板的分窗分配从「选项窗 = min(选项内容行数, 面板体一半)」改为用户 2026-09-26 人工验收时给出的规则：

1. 题干与选项之间不留大段空白（内容不足时剩余行让给下一段）
1. 不溢出时空白留在活动区**下方**
1. 两窗合计溢出时**优先让选项窗滚动**
1. 描述窗最多占面板体 **2/3**

## 调研

- 现行实现（3.2.1）：`optMinRows = min(optRows.length, max(1, floor(maxBody/2)), maxBody-1)` → `descWindowMax = maxBody - optMinRows` → 描述窗上限**随选项内容行数变化**；选项内容未超半屏时选项窗整体显示、永不滚动（5 选项 ≈ 11 行 < 半屏 → 用户「看不出选项部分的溢出滚动」即此）。
- 用户观察到的第二个现象（切题时两窗高度跳变）同样源于描述窗上限随内容变化。

## 决策

新分配（纯函数、只依赖 `maxBody` 与两段内容行数）：

```
descMaxRows    = max(1, floor(maxBody × 2 / 3))                 // 描述窗上限（要求 4）
descVisible    = min(descRows.length - descStart, descMaxRows, maxBody)  // 内容不足不留空（要求 1）
optWindowRows  = max(0, maxBody - descVisible)                  // 选项窗吃剩余（要求 2、3）
maxDescScroll  = max(0, descRows.length - descMaxRows)          // 上界恒按上限算，滚动不抖动
```

- 溢出优先级：描述窗先按上限取满（≤ 2/3），其余全部给选项窗 → 合计溢出时**选项窗先滚动**；描述内容超过 2/3 时描述窗自身也可滚动（两窗各带滚动条）。
- 不溢出时：`descVisible` = 实际内容行数、`optWindowRows` = min(选项行数, 剩余) → 两窗紧邻、空行落在 body 末尾（活动区下方）。

## 规划

计划改动文件清单：`src/app/components/QuestionPrompt.ts`、`tests/question-window.test.ts`、`tests/app.test.ts`（若断言受影响）、`tests/fixtures/focus-frame-legacy.json`（重跑）、`docs/SPEC.md` §7.1、`docs/IMPLEMENTATION.md` 面板章节。

不做：审批面板（仅描述窗，不涉及分窗）、其它面板的内边距与窗口策略、选项窗滚动条的视觉变更（沿用 3.2.8 口径）。

## 实现记录

- `components/QuestionPrompt.ts`：第 3~4 步替换为 `descMaxRows = max(1, floor(maxBody × 2 / 3))` → `maxDescScroll = descRows − descMaxRows` → `descVisible = min(descMaxRows, 内容剩余行, maxBody)` → `optWindowRows = min(optRows.length, maxBody − descVisible)`；删除原 `half` / `optMinRows` / `descWindowMax` 三元组。
- `tests/question-window.test.ts`：新增两条用例——「描述窗上限 2/3，溢出由选项窗先承担」（12 个选项 + 长题干：描述窗恒 8 行 = floor(13×2/3)，且第 12 项不可见 → 选项窗滚动）、「内容不足时两窗紧邻、空白落在活动区下方」。

## 测试与证据

- `npm run check` / `npm run build`：通过。
- 全量 `node --experimental-transform-types --test tests/*.test.ts`：全绿（既有分窗 / 滚动 / 焦点用例均兼容新规则）。
- `npm run demo -- --smoke`：无 `SMOKE_FAIL`。
- 冻结基线重跑：无新增差异（基线场景内容不足，两窗紧邻的既有表现不变）。
- 人工复验（2026-09-26）：16 选项 + 长题干提问实测通过——同屏只显示部分选项，`↑/↓` 移动光标时后续项随窗口滚入视野（选项窗溢出滚动成立）。其中「标记项不被滚出」与「滚到底 + 反向响应」两项用户单独确认通过。

**重启加载新构建后复验通过**（2026-09-26）：长题干（约 2000 字）+ 16 选项场景实测，两窗高度比 **2:1** 成立（描述窗限在面板体 2/3、选项窗吃剩余），选项窗溢出滚动与描述窗滚动条同屏出现。注：此前一轮用户报「比例 1:1」，经排查是**运行中的 TUI 仍加载旧构建**（旧规则为选项窗恒占半屏）；`dist` 编译产物已确认含 `descMaxRows = max(1, floor(maxBody × 2 / 3))`，重启后即符合预期——后续凡涉及产物性改动，均需先提醒用户重启再复验。

## 收尾

- 条目 3.2.11 标「完成」；文档回写 `docs/SPEC.md` §7.1、`docs/IMPLEMENTATION.md` 面板章节；本追踪文档归档 `TUI/docs/archived/`。
- 未做：审批面板（无分窗）、选项窗自身的滚动条视觉（沿用现状；如后续需要可另立条目）。
