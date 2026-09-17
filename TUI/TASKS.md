# TUI 渲染管线重构任务（Tasks）

> 状态：**设计草案，待实施**（2026-09）。
> 类型：**[task]**——实施与验收清单；涵盖**主线 A（契约迁移：`RenderLine[]` → `FrameRow[]`）**与**主线 B（Box 排版模型重构）**。
> 配套：`SPEC.md`（规格）、`DESIGN.md`（设计）、`IMPLEMENTATION.md`（实现要点）。

## 0. 重构全景（两条主线）

- **主线 A · 契约迁移（样式链路归位）**：渲染层/排版层/测试同步迁移到 `FrameRow[]`（见 §1），消灭 app 侧手拼 ANSI。
- **主线 B · Box 排版模型重构**：`buildFrame` 换为 Box 树 + measure/allocate/fill（见 §2）。
- 关系：A 先冻结 `FrameRow[]` 契约（接口），B 在其上建 Box——两线可并行推进。
- 两线均拆为**多个可独立回归的提交**（§5）。

## 1. 主线 A · 契约迁移（RenderLine → FrameRow）

> **状态：已完成**（3 提交：98e9efd 契约类型 / d0d28d6 markdown 收敛 / b35826d 原子翻转；
> 回归标准：570 单测 + 36 smoke 帧断言全绿）。以下条目为实施清单留档。

**A1 渲染层**

- `screen.ts`：`render/renderDelta` 接受 `FrameRow[]`，新增段级序列化 `segStyle(seg, theme)`（名→hex→SGR、相邻同 style 合并、未知名回退；规格见 `SPEC.md` §14）；delta 比较改按序列化文本（内部实现，不对外）。
- `theme.ts`：`ColorName` 增加 `"code"` 槽位（dark 现值 `#434343` / light `#E8E8E8`，从 `markdown.ts CODE_BG` 迁入）；序列化函数内部化（`colorFor`/`ansiNameToHex`/`hexSgr` 收口）。
- `index.ts`：`Renderer.render/refresh` 签名 `RenderLine[] → FrameRow[]`；删除 `RenderLine` 类型（由 `FrameRow` 替代）。

**A2 排版层**

- `layout/markdown.ts`：`InlineSegment`/`InlineStyle` 收敛为 `FrameSegment`/`FrameStyle`（字段已对齐）；删除 `renderSeg`（序列化移交渲染层）；删除 `CODE_BG`（改 `style.bg: "code"`）；`wrapSegments`/`wrapInlineMarkdown` 改产出 `FrameSegment[]`（跨行段每行重声明 — `SPEC.md` 不变量 #4）。
- `layout.ts`：54 处 ANSI 直写 / `colorFor(...)` 直包改 `style` 字段（如 `makeSep` → `{ fg: "border" }`）；`renderStatusLine` 等纯函数改返回 `FrameRow[]`。
- `components/*`：8 处同理；`TextInput` 保持 `caret` 语义。
- `app/index.ts`（控制层）：仅随 `buildFrame` 返回类型顺延，不涉行为。

**A3 测试**

- 新增：渲染层序列化单测（名→SGR / 相邻合并 / 未知名回退 / 主题切换 / caret 定位）。
- 新增：排版层产出断言（纯文本无 ANSI、宽度合计 = 行宽）。
- 现有 560 测试：断言从「带 ANSI 文本」改为 `segments` 结构；导入面小改（不涉及行为）。
- `demo` 帧断言与 `smoke:pty` 不变（行为不变即回归标准）。

## 2. 主线 B · Box 排版模型重构

推进分三波（顺序推进为主，勾选并行仅在文件边界清晰的任务间开 worktree——一任务一 worktree，且「内容映射替换 `wrapBufferLines`」与「`layout.ts` 拆文件」绝不同时开）：

1. **接口冻结（已完成 cc743d7）**：定义 `Box`/`Paragraph`/`NodeBase` 类型 + `measure/allocate` 签名（纯函数）；同步修订 `SPEC.md` §6 契约歧义（SizeTable.root / separator 仅纵向 Box / Paragraph 总宽含 indent+prefix）。
1. **接口冻结后的有限并行**：① 契约迁移（已并入主线 A）；② measure/allocate 实现 + 单测（宽度规则/保底/比例/悬挂缩进）——**已完成 eea8196**（`layout/measure.ts` + `tests/measure.test.ts`，24 项契约断言，advisor 复核后扩展：spacer 横/纵轴、多 ratio 归一、min>max、v 过度约束压缩顺序）；③ 内容映射（`state.buffer` → 内容 Box 树，替换 `wrapBufferLines` 的分类处理）；④ 测试序列化辅助（`FrameRow[]` ↔ 字符串，复用旧断言）；⑤ 随子系统实现**逐步抽文件**（不再单设大规模拆文件并行道：`layout.ts` 按 DESIGN Part II §6 目标结构边做边拆，行为不变）。
1. **接线汇合**：各区域改造为 `fill(ctx, rect)`；`FocusFrame` 实现与测试（对照现有焦点框线各焦点态的帧断言）；面板改造为 Box 生成器（`DESIGN.md` Part II §7；场景原语 `SPEC.md` §7）。
1. **依赖基元迁移（防循环依赖，接线前必做）**：`measure.ts` 目前从 `layout.ts` import `wrapLine/truncateToWidth`、从 `layout/markdown.ts` import `displayWidth`。接线里程碑必须先把这些共享宽/折行原语迁到中立模块（如 `layout/width.ts`），再让 `layout.ts` import `measure.ts`，避免双向依赖。
1. 全量回归：`npm run check/test/build` + `demo -- --smoke` + `smoke:pty`。
1. 文档同步：`SPEC.md` 引用、`DESIGN.md`「四区域布局」改为「由 Box 树声明」、`REFACTOR.md` 归属登记。

## 3. 验收

```sh
npm run check          # 类型通过
npm run test           # 全量测试通过（含新增序列化/排版产出断言）
npm run build
npm run demo -- --smoke   # 帧断言 SMOKE_PASS 不变
npm run smoke:pty      # 真机冒烟（工具行/状态栏 usage）
```

实施完成后文档同步：`DESIGN.md` 术语节「现状偏差」→「样式链路已收敛」、「核心接口契约」更新为 `FrameRow`；`IMPLEMENTATION.md` 增补「段序列化」要点。

## 4. 不在范围（明确不做）

- 不换 TUI 框架、不加事件总线/中间件、不引入样式规则引擎/布局引擎（保留「排版后扁平快照」模型）。
- 不为 Approval/Question/ModelPicker 建共享 Panel 基类；不把控制逻辑装进 `components/` 渲染文件（REFACTOR.md 约定）。
- 渲染层继续不量宽、不感知内容。
- 不启用 bracketed paste / 鼠标 / 滚动区域（单独条目，另行评估）。

## 5. 提交拆分（C5）

拆成多个可独立回归的提交：契约层 / Box 类型+单测 / 测量算法 / 内容映射 / 接线+FocusFrame+面板 / 测试迁移——每批独立可验证，天然支持并行。

## 6. 待决清单

| # | 问题 | 备注 |
|---|---|---|
| C2 | markdown 解析器重构范围 | 块解析自 `wrapBufferLines` 抽出后，`markdown.ts`（727 行）是否整体重排——动工那一步按实际 diff 形态评估 |
| C3 | 测试迁移策略 | 560 个测试断言由「带 ANSI 文本」改为 `segments` 结构：改动面、是否提供序列化辅助——动工那一步按实际 diff 形态评估 |
| — | 活动区两态触发方式 | 状态 2（紧凑）：由「fill 按高度预算自动降级」 vs「用户显式配置」决定（`SPEC.md` §6.8） |
| — | 表格 `minW` 取值策略 | 候选：`ceil(colW_natural / 4)`（≥ 3 列）；SPEC 只定了「有 minW 下限 + 省略号截断」机制，具体值待定（`SPEC.md` §3.2） |
| — | 面板选中/高亮字符 | 候选沿用现状：`>` 高亮、单选 `*`、多选 `+`；SPEC 面板原语只定结构字段，字符待定（`SPEC.md` §7） |

## 7. 开放点

- **内容树的测量代价**：消息多时每帧全量 measure；若成为瓶颈，再评估「内容行缓存」（现状本来也是每帧 wrap 全量，预期无回归）。
