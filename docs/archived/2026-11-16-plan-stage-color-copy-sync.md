# plan 段位配色调整的文档/注释口径同步（接取条目：docs/BACKLOG.md「plan 段位配色调整的文档/注释口径同步」）

状态：实施　　开启：2026-11-16　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

2026-11-16 用户裁定（提交 `a8053e0a`）把 TUI 标题栏 plan 段位配色改为四态：

| 状态 | 颜色 |
| --- | --- |
| 未进 plan 模式（服务面 null / 缺席） | 灰 |
| 已选中 plan、未建树（idle） | 绿 |
| 探索 / 计划（合并同色） | 青 |
| 实施 | 黄 |

代码行为已随 `a8053e0a` 落地；本条目只同步**残留旧口径的注释与文档**，不改任何代码行为：

1. `TUI/src/app/state/types.ts:692` 注释仍写旧三色「探索=青 / 计划=黄 / 实施=绿」，缺 idle 绿。
2. `TUI/README.md:52` 标题栏描述仍是合并前单组旧布局（「最多 7 个…顺序固定：沙箱 / policy / plan / verbose / symbol-unify / bell / flow-track」+「五个开关」），缺 `•` 工作流分组、daemon / team 符号与 plan 四态。
3. `TUI/docs/SPEC.md:130` 与 `:697` 同款旧描述（≤7 图标旧顺序、「五个开关 on/off 灰」），缺 plan 四态与分组口径。
4. `docs/BACKLOG.md:112` 仍标「(2026-11-16 完成, 未提交)」，实际已随 `a8053e0a` 提交。

## 计划改动文件清单

- `TUI/src/app/state/types.ts`：`planStage` 快照注释改四态口径。
- `TUI/README.md`：标题栏首行描述补 2026-11-15 两组分拆（环境/行为组 `•` 工作流组）、daemon / team 符号、plan 段位四态。
- `TUI/docs/SPEC.md`：§顶部区域构成（`:130`）与 §15.1 标题栏（`:697`）两处口径同步。
- `docs/BACKLOG.md`：`:112` 未提交标记改注提交 `a8053e0a`。

明确不做：

- **不改代码行为**（配色映射、idle 合成、只读拦截、阶段注入文案均不动）。
- 不改 `docs/archived/*` 与 `docs/BACKLOG.md:96`（2026-11-15 完成索引里的旧三色是当时史实，保留）。
- 不改 `docs/STATUS.md`（用户维护，plan-mode 测试计数 63→64 仅是提示）。
- 不改 `TUI/src/app/layout/title-bar.ts:86` 与 `TUI/tests/title-bar.test.ts:5-7` 的「四个开关」计数注释（与本条目主题无关的既有次要过时项，另议）。

## 实现记录

2026-11-16：按上述文件清单逐一修改（详见本节）。随后按惯例跑 `format` 与 `pnpm -C TUI run check`、`pnpm run check:docs`。

- `TUI/src/app/state/types.ts:692`：`planStage` 快照注释由「探索=青 / 计划=黄 / 实施=绿」改为四态「灰=未进模式 / 绿=idle 已选中未建树 / 青=探索|计划合并 / 黄=实施」。
- `TUI/README.md:52`：标题栏首行描述改为两组分拆（环境/行为组：沙箱 / policy / verbose / symbol-unify / bell / daemon / team `•` 工作流组：plan / flow-track），删「最多 7 个…固定顺序」旧说法，补 plan 段位四态（数据源 `planStage.current`）与 team 两态。
- `TUI/docs/SPEC.md:130`：顶部区域构成里的标题栏首行同步为两组分拆 + plan 段位四态，删「最多 7 个」与「五个开关」。
- `TUI/docs/SPEC.md:697`：§15.1 标题栏条目同步两组分拆、图标码位表补 `daemon U+F017` / `team U+F0C0`、plan 段位四态（数据源 `planStage.current(sessionId)`）。
- `TUI/docs/SPEC.md:231`：单行组合行例外里的「最多 7 个状态符号」删去（同文件同口径，一并修正）。
- `docs/BACKLOG.md:112`：该完成索引由「未提交」改注提交 `a8053e0a`。

偏差说明：原计划文件清单只列 SPEC `:130` / `:697` 两处；实现时发现 `:231` 有同款「最多 7 个状态符号」旧计数，属于同一口径、同一文件，顺带修正（不新增行为）。

## 验证

- `format` 作用于本次改动文件：通过（types.ts 未变化报 unchanged）。
- `pnpm -C TUI run check`：通过（tsc 0 错误）。
- `pnpm run check:docs`：通过（123 篇 / 0 错误 / 0 警告）。
- 无行为改动，不需要重跑全量测试；如涉及改 TUI 显示口径则跑 `pnpm run test:tui`（本次仅注释与文档，不涉及）。

## 收尾

- BACKLOG §2 条目标完成并移入 §1 完成索引；本追踪文档移入 `docs/archived/`。
