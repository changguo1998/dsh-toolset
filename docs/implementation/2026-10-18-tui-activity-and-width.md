# TUI 两个待细化条目（接取条目：`TUI/docs/BACKLOG.md`「重新设计活动区两个开关（`/collapse` 紧凑 与 `/verbose` 档位）」；「会话区用户输入文字的宽度计算机制重新设计」）

状态：实现中　　开启：2026-10-18　　关闭：-
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

两条都在待细化状态（条目原文要求开工前与用户讨论新语义 / 新口径）。本文件记录调研与用户已给的口径；未获准开工前不动代码，BACKLOG 条目保持〔待办〕。

## 调研

**条目 1：活动区两个开关**

- 命令面：`/collapse` 与 `/verbose` 已从 `LOCAL_COMMANDS` 移除，仅保留路由与统一提示 `RETIRED_COMMAND_NOTICE`（`src/app/index.ts:222-224`、`src/app/commands.ts:348-353`）；两个 handler 是「已下线」桩，不改状态。
- 状态与传参链仍在：`activityCompact` / `activityVerbose`（`state.ts:599-602`，缺省 `false` / `"think"`）→ `layout.ts:1090-1105`（`activityCompact` / `activityLevel`）→ `build-box.ts`。
- 失效点：`build-box.ts:532` 明确「工具块不受 activityCompact / activityLevel 影响」，工具块改版后恒按完整形态出图；其余条目（思考 / 正文 / notice）的紧凑与档位分支仍在。
- 标题栏仍有 `verbose` 指示（`layout.ts:1326`，`verbose: !activityCompact`）。

**条目 2：会话区用户输入宽度**

- 路径 ①：输入区 `components/TextInput.ts:30-60` 用 `displayWidth` + `charWidth` 自折行（按 code point，不切半个 CJK）。
- 路径 ②：提交后的用户块走盒树 `layout/build-box.ts` → `fill.ts` → `markdown.ts` 的 `charWidth` / `displayWidth`。
- 量宽来源：静态 EAW 表 + 启发式 + 实测覆盖 `<profile>/tui-width-symbols.json`（`layout/width-symbols.ts`）。
- 缺口：两处各自折行，前缀列 / 缩进 / 行内 markdown / 缓存不一致时同一段文本折在不同列；四个裁定项待定。

## 决策

用户已给的口径（2026-10-18）：

- 两个命令**功能不同**、分开保留：一个控制**是否显示**，一个控制**是否压缩到 1 行**。
- 显示命令的格式定为 `/verbose [think|tool|reply] [on|off]`：按类别逐项开关（思考 / 工具块 / 正文回复），无参时回用法与当前三项状态。
- 压缩命令**同格式**：`/collapse [think|tool|reply] [on|off]`——`on` = 该类别压 1 行 + 行尾省略号，`off` = 完整折行。两命令各自按三类维护开关：`/verbose` 管显示，`/collapse` 管压缩。
- 条目 2（宽度口径）暂缓，等条目 1 做完再开工。

用户裁定（2026-10-18，三问三答）：

- **缺省值**：显示三项全开、压缩三项全关（启动后与现状一致）。
- **旧快照迁移**：一律重置为缺省——旧 `activityCompact` / `activityVerbose` 直接丢弃，用户重新设置。
- **其余内容归属**：`notice` 与 step 分隔头**恒显**，不归三类开关。

## 规划

按新口径的计划改动文件清单（六开关：显示 `think|tool|reply` + 压缩 `think|tool|reply`）：

01. `TUI/src/app/state.ts`：新增 `ActivityCategory`（`think|tool|reply`）与 `ActivitySwitches`；`activityCompact: boolean` 改为 `ActivitySwitches`，`activityVerbose: ActivityLevel` 改为 `activityShow: ActivitySwitches`；缺省常量（显示全开 / 压缩全关）；reducer 改 `activity-compact {category,on}` 与新增 `activity-show {category,on}`。
02. `TUI/src/app/commands.ts`：`LOCAL_COMMANDS` 增 `collapse` / `verbose` 两项（desc 写明按类别）；删除 `RETIRED_ROUTES` 及其合并。
03. `TUI/src/app/index.ts`：两个 handler 解析 `[think|tool|reply] [on|off]`，缺参 / 非法回用法 + 当前三项；删 `RETIRED_COMMAND_NOTICE` 常量与两个桩；`ui-flags` 保存去掉 `collapse` / `verbose`（不再持久化，重启回缺省），恢复分支同步删除；`ActivityLevel` 导入改 `ActivityCategory`。
04. `TUI/src/app/layout.ts`：render opts 改传 `activityShow` / `activityCompact` 两张表；标题栏 `verbose` 指示改为「压缩未全开」。
05. `TUI/src/app/layout/pipeline/panes.ts`：`PaneOptions.level` 改 `activityShow: ActivitySwitches`；`visibleAtLevel` 按来源分流（reasoning→think、工具批→tool、assistant 正文→reply、notice / step 头恒显）。
06. `TUI/src/app/layout/pipeline/rows.ts`：透传字段改名；box 缓存键并入显示三项与压缩三项。
07. `TUI/src/app/layout/build-box.ts`：`BuildBoxOptions` 两张表；显示过滤按类别（思考 / 工具 / 非 final 正文）；压缩按类别（思考单行 / 正文折行 / 工具组压 1 行）；notice 与 step 头不压缩；删除「工具块恒完整」分支。
08. `TUI/src/app/adapter/session-ui-state.ts`、`TUI/src/app/adapter/types.ts`：删 `collapse` / `verbose` 字段与 `ActivityLevel` 导入（旧快照读到即忽略）。
09. 测试：`TUI/tests/activity-level.test.ts` 重写为六开关矩阵 + 命令面解析 + 显示关与压缩开的组合；`activity-verbose.test.ts` 改 opts 形状；`app.test.ts` 的 ui-flags 断言改为「不再回填」；其余引用旧 opts 的用例同步改形参。
10. 文档：`TUI/docs/SPEC.md`（§6.8 两态改六开关、§15.5 三档小节重写）、`TUI/docs/COMMANDS.md`（计数 + 两条 desc）、`TUI/README.md`（命令表两行）。

明确不做：条目 2（输入宽度）本轮不动；不改宿主 `/permission` 与其它面板；不引入新依赖。

## 实现记录

- `state.ts`：`ActivityLevel` 换为 `ActivityCategory` + `ActivitySwitches`；`activityCompact` / `activityShow` 两张表与缺省常量；action 改 `activity-compact{category,on}` / `activity-show{category,on}`。
- `commands.ts`：`/collapse` 与 `/verbose` 恢复进 `LOCAL_COMMANDS`（desc 写按类别，支持 `all`），删除 `RETIRED_ROUTES`。
- `index.ts`：两 handler 解析 `[think|tool|reply] [on|off]`（`parseActivitySwitch` / `formatActivitySwitches`；`all` = 三类同时），非法参数回 usage；删除下线提示常量；`ui-flags` 不再保存 / 回填活动区开关。
- `layout.ts`：传 `activityShow` / `activityCompact`；标题栏 `verbose` 指示改为「压缩未全开」。
- `build-box.ts`：按类显示过滤（思考 / 工具 / 非 final 正文；notice 与 step 头恒显）与按类压缩：think / reply 先按 markdown 块级元素排版（记号渲染掉）再拼成一行，超宽时省略号在前、保留末尾（随流刷新）；tool 把整节所有调用的名字与参数拼到一行（名字保持黄色）填满后加省略号。三开关全开时每节固定三行（think / tool / reply 各一行，step 头另计）。
- `pipeline/panes.ts`：`visibleAtLevel` 按来源分流（reasoning / tool / assistant）；`frame.ts` / `rows.ts` 传参与缓存键改为六开关。
- `adapter/session-ui-state.ts` / `adapter/types.ts` / `adapter/dsh.ts`：删 `collapse` / `verbose` 字段与迁移，旧快照值读到即丢。
- 测试：`activity-level.test.ts` 重写为显示矩阵 + 命令面；`activity-verbose.test.ts` 改为压缩矩阵 + 工具组压 1 行 + `/collapse` 命令；`pipeline-*`、`thinking-markdown`、`title-bar`、`app`、`adapter.dsh`、`session-ui-state`、`completion` 同步改形参与断言。
- 文档：`SPEC.md` §6.8 / §15.5 重写为六开关；`COMMANDS.md` 计数 41→43；`README.md` 命令表与活动区说明更新。

## 偏差

- `notice` / shell 行不再支持「压缩」：按用户裁定归恒显类，`noCompact` 字段不再决定压缩（保留字段供其它用途）。
- 标题栏 `verbose` 指示语义改为「压缩未全开」，不再等价于单一 `activityCompact`。
- 旧快照的 `activityCompact` / `activityVerbose` 不迁移（用户裁定重置）。

## 测试与证据

- `npm --prefix TUI run check`：0 error。
- `npm --prefix TUI run test`：1625 例全绿（fail 0）。
- `npm --prefix TUI run build`：通过；`npm run demo -- --smoke`：`SMOKE_PASS jobs-kill` / `SMOKE_OK`。
- 断言覆盖：显示三类矩阵与 `/verbose` 命令、压缩三类矩阵与 `/collapse` 命令、工具组压 1 行、notice 恒显不压、旧快照字段丢弃、pipeline 与旧渲染等价、标题栏指示随压缩状态。

## 收尾

- 待办：条目 1 标完成并移出 `TUI/docs/BACKLOG.md`；本文件移入 `docs/archived/`；条目 2（输入宽度）另起追踪文档。
- 回写：`SPEC.md` / `COMMANDS.md` / `README.md` 已改。
- 未做：宿主面板、条目 2、新依赖。
