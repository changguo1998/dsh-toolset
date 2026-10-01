# 回合区类型间隔收窄（接取条目：TUI/docs/BACKLOG.md「回合区类型间隔收窄：只保留「思考 ↔ 正文」空行」）

状态：关闭　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

回合区（Turn pane）的「类型间隔」由「思考 / 正文 / 工具三类相邻互切各插 1 行空行」收窄为\*\*只保留「思考 ↔ 正文」（双向）\*\*的空行：

- 保留：思考→正文、正文→思考（各 1 行空行）；
- 不插：思考→工具、工具→思考、正文→工具、工具→正文；
- step 分割线与内容之间不留空行（step 头属工具类；分割行原有的「吸收拖尾空行」照常生效，不再为类型间隔空行让路）。

范围仅回合区；会话区（历史）的空行口径不动。

## 调研

来源：`TUI/src/app/layout/build-box.ts`（`noteActKind` / `gapBlank` / `flushToolRun`）、`TUI/tests/{activity-type-gap,activity-verbose,layout4,content-mapping}.test.ts`、`TUI/docs/SPEC.md` §「活动区类型间隔（#5）」、`TUI/docs/DESIGN.md`「活动区」段、`TUI/docs/archived/2026-10-01-activity-type-gap.md`、用户 2026-10-02 口述。

- **现状实现**：`noteActKind(kind, rowMeta)` 在思考 / 正文（非 final）/ 工具三类入口各调一次；`lastActKind !== kind` 时推入一个空叶（`kind:"plain"`），并把它记为 `gapBlank`。
- **`gapBlank` 的由来**（2026-10-01 #5 实现期发现）：`absorbActivityBlank` 会把 step 分割行之前的拖尾空活动行吞掉，从而吞掉刚插入的「思考 → 工具（step 头）」间隔空行；故 `flushToolRun` 在 step 头分支加了 `activityLeaves[last] !== gapBlank` 的豁免，`layout4.test.ts` 相应断言「思考块与分割行之间为类型间隔空行」。
- **本次改动后 `gapBlank` 的豁免失效**：思考→工具不再插空行，「分割行前不得吞掉间隔空行」这一诉求消失 → 豁免判据成为死代码，应随本任务移除（`absorbActivityBlank` 恢复无条件调用 = 分割行前紧排）。
- **上游口径（不变的部分）**：notice / shell / 已有空行不算类型边界（既不引发也不阻断判断）；同类连续只在边界插一次；回合区开头（无前一类）不插。`content-mapping.test.ts` 的「思考↔正文」间隔断言与本次口径一致，不需改。

## 决策

1. **保留面收窄为 `{thinking, assistant}` 互切**：`noteActKind` 只在「旧类 ∈ {思考, 正文} 且新类 ∈ {思考, 正文}」且两者不同时插空行——工具类与任何类型相邻都不插（含 step 头 / 调用行 / 结果行）。用户裁定：双向保留（2026-10-02）。
1. **移除 `gapBlank`**：豁免判据随需求消失即删（含 `flushToolRun` 里 step 头的跳过分支与注释），`absorbActivityBlank` 恢复无条件调用；不留无效机制。
1. **不动部分**：会话区（历史）的空行口径、notice / shell 的边界语义、`/verbose` 三档过滤与 `/collapse` 紧凑模式（过滤掉的行本就不参与类型判定）均不改。
1. **实现方式**：最小改动——只改 `noteActKind` 的判据与 `gapBlank` 相关代码；`type ActKind` 与调用点保持不变（调用点仍如实上报类型，判据集中在 `noteActKind`）。

## 规划

任务拆分（每步的验证）：

1. `TUI/docs/BACKLOG.md` 条目 + 本追踪文档 → 验证：条目「进行中」、文件头条目按标题引用。
1. `TUI/src/app/layout/build-box.ts`：`noteActKind` 判据改「仅思考↔正文互切插空行」（类型收窄为 `kind === "thinking" || kind === "assistant"` 且旧类不同且非工具）；删 `gapBlank` 变量与 step 头豁免分支；相关注释同步 → 验证：`npm --prefix TUI run check`。
1. 测试：`TUI/tests/activity-type-gap.test.ts`（改「工具互切」「step 头」两例 + 文件头注释）、`TUI/tests/activity-verbose.test.ts`（行数期望）、`TUI/tests/layout4.test.ts`（「思考块与分割行之间」用例改为紧排）→ 验证：`npm run test:tui`（全量）。
1. 文档：`TUI/docs/SPEC.md` §「活动区类型间隔（#5）」改写口径 + `TUI/docs/DESIGN.md`「活动区」段一句 → 验证：`format` + 自查 diff。
1. 门禁：`npm --prefix TUI run check` / `run build` / `npm run test:tui` + 真机目视（思考→正文有 1 行空行；思考→工具、工具→正文、step 分割线前后紧排）→ 验证：输出与真机现象记入「测试与证据」。

计划改动文件清单（**只改这些**）：

- `TUI/docs/BACKLOG.md`（条目：进行中 → 完成并清理）
- `TUI/docs/implementation/2026-10-02-turn-type-gap.md`（本追踪文档，关闭时移入 `TUI/docs/archived/`）
- `TUI/src/app/layout/build-box.ts`
- `TUI/tests/activity-type-gap.test.ts`
- `TUI/tests/activity-verbose.test.ts`
- `TUI/tests/layout4.test.ts`
- `TUI/docs/SPEC.md`
- `TUI/docs/DESIGN.md`

明确不做：不改会话区（历史）空行口径；不改 notice / shell / 空行的边界语义；不改 `/verbose` 档位过滤与 `/collapse` 紧凑模式；不动渲染层与其它包；不做顺手重构。

## 实现记录

2026-10-02：

- `TUI/src/app/layout/build-box.ts`：`noteActKind()` 判据由「旧类 ≠ 新类」改为「新类与旧类同属 `{thinking, assistant}` 且不同」——插空行改称 `isDialoguePair`；删除 `gapBlank` 变量与 `flushToolRun` 里 step 头的豁免分支（`absorbActivityBlank` 恢复无条件调用）；四处注释同步（`noteActKind` 头注、step 头分支、tool / thinking / 非 final assistant 调用点）。
- `TUI/tests/activity-type-gap.test.ts`：文件头注释改口径；「工具块与正文互切」由「各插一处」改为「全程紧排」；新增「思考→工具→正文」用例；「notice / step」用例的 step 部分改为「不留空行（分割行前也紧排）」。
- `TUI/tests/activity-verbose.test.ts`：紧凑模式行数期望由 `buf.length + 2` 改为 `buf.length`（工具类不再产生间隔行）。
- `TUI/tests/layout4.test.ts`：用例名与断言由「思考块与 step 分割行之间是类型间隔空行」改为「紧排」。
- 文档：`TUI/docs/SPEC.md`「活动区类型间隔（#5；2026-10-02 收窄）」改写（语义 / 工具类不插 / step 紧排 / 实现 / 回归）；`TUI/docs/DESIGN.md`「活动区」段类型间隔一句同步。

2026-10-02（真机复查后补修）：

- **现象**：真机仍见「正文 → 工具」空行。**根因**：不是类型间隔，而是**拖尾空行未被吸收**——`absorbActivityBlank(activityLeaves)` 此前只在 `flushToolRun` 的 step 头分支调用，故无 step 头的工具 run（正文后直接跟 `○` 调用行）前面的空行原样渲染；空行来源是宿主每步补发的 `"\n\n"`（`appendStream` 的同 kind 空白分片不丢弃，见 `state.ts` P5 降级注释）或 thinking 拖尾换行锚点。
- **修法**：`build-box.ts` 的 `flushToolRun` 在 `toolRun.length === 0` 守卫之后、落盘工具节点之前调用 `absorbActivityBlank(activityLeaves)`（与 step 分割行同语义）；step 头分支原调用保留（覆盖 run 内场景）。
- `TUI/tests/activity-type-gap.test.ts`：新增用例「正文 / 思考的拖尾空行 → 工具：吸收后紧排」——正文空段 → 工具（吸收）、thinking 拖尾换行 → 工具（剥尾）、正文**段内**空行（其后还有正文）保留为 1 行（该行带块内竖线 `┃`，按剥掉竖线后为空判断）。

## 测试与证据

- `npm --prefix TUI run check`：通过（无 `error TS`）。
- `npm run test:tui`（全量）：1295 pass / 0 fail（较改动前 +2 条新用例：思考→工具→正文、拖尾空行吸收）。
- `npm --prefix TUI run build`：通过（`tsc -p tsconfig.json`）。
- 真机（2026-10-02 两轮）：第一轮复查发现「正文 → 工具」仍留空行 → 补修（见实现记录第二段）；第二轮用户确认「没有问题」——思考→正文保留 1 行空行，思考→工具、工具→思考、正文→工具、工具→正文与 step 分割线前后均紧排，正文段内空行保留。

## 收尾

- 提交：`dddabd6 feat(TUI): 回合区类型间隔收窄为仅「思考↔正文」`（src + 3 个测试文件）、`0e1f431 fix(TUI): 正文→工具紧排（工具 run 落盘前吸收拖尾空行）`（src + 1 个测试文件）；文档（本文件、`TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`、`TUI/docs/BACKLOG.md` 状态）随关闭后提交。
- 回写：`TUI/docs/SPEC.md`「活动区类型间隔（#5；2026-10-02 收窄）」改写；`TUI/docs/DESIGN.md`「活动区」段一句同步。`TUI/README.md` 未涉及（该段属渲染口径细节，README 无对应描述）。
- BACKLOG：`TUI/docs/BACKLOG.md`「回合区类型间隔收窄：只保留「思考 ↔ 正文」空行」标完成并从待办清理移除。
- 遗留项：无（真机两轮确认通过，未发现新问题）。`state.ts` 的同 kind 空白分片策略（P5 降级）未改——本次改的是渲染期吸收，宿主补发的 `"\n\n"` 仍会入 buffer。
- 临时文件：无。
- 本文件移入 `TUI/docs/archived/2026-10-02-turn-type-gap.md`。
