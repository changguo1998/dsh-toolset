# 全仓工具描述 lint（接取条目：`docs/BACKLOG.md`「全仓工具描述 lint」）

状态：实现完成 / 待人工确认　　开启：2026-10-25

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
任务口径（2026-10-25 与用户对齐后修订）：**不开发 linter / 插件**，改为「先定描述规范，再由模型/人工逐条审 46 个工具并按规范改进」的检查工作。本文先记录已定的规范条款与未决项，随后逐工具检查。

## 目标

为全仓工具描述定下一套一致的规范，并逐条审阅 46 个工具，把不符合规范的地方改进到达标。只涉及描述文本 / 规范，不新增自动检查脚本。

## 已定规范（共 5 条）

### S1 首句长度

- 定义：`首句 = 开头到「第一个中/英文句号」与「128 字符」两者先到者`；上限实际 ≤128。
- 按 Unicode 码点计数；句号本身算进首句。
- 断句边界：中文 `。` / `！` / `？` 直接断；ASCII `.` / `!` / `?` 需后接空白或句尾（避开 `patch.text` / `0.2.1` 这类点）。
- 实测（43 个已取数工具）：无一超过 128、无一被裁，现即全绿，不需改首句。

### S2 交叉引用

- 保持现状：描述里工具名**裸写**（无反引号）。
- 按语言区分：中文部分是散文；`snake_case` token 视作工具名引用。
- 逐个把引用的 `snake_case` token 对照注册集（46 本仓 + 11 宿主名），校验存在且拼写正确。
- 已知问题：`goal_contract_draft` 引用不存在的 `ask_user`（宿主名为 `ask_user_question`），需改。

### S3 参数级描述

- 每个参数必须有**非空**的 `description`。
- 现状欠账：7 个 `action` 参数无描述，需补：
  1. `session_channel.action`
  2. `channel_task.action`
  3. `md_map.action`
  4. `agent_group.action`
  5. `daemon_task.action`
  6. `metric_loop.action`
  7. `code_map.action`

### S4 载体结构

- 采用固定格式（字段名前导 + 散文值；不用伪 JSON / 花括号 / 数组）。每字段一行，字段名后空一格再写值。
- 字段集与顺序：
  1. `用途:` - 干什么 / 何时用（总起，一句话；S1 首句长度落到本字段值）
  2. `用法:` - 怎么做：动作 / 关键参数 / 缺省值（按动作/方面分句，`; ` 分隔）
  3. `效果:` - 调用后产生的结果或副作用（改文件 / 触发重启 / 注入消息 / 落地回传）（可选）
  4. `边界:` - 不做什么 / 限制 / 前提（只读、只接受登记的 terminal_id 等）（可选）
  5. `相关:` - 相关工具**裸名**，用 `、` 分隔（可选）
- 字段省略规则：`用途` 必带；`用法` 通常有；`效果` / `边界` / `相关` 无实质内容时整行省略；短工具只保留必要字段，不强凑五行。
- 这是现状的结构化升级：现状为整段连续散文、`；` 串句；加字段名与回行的长度影响见 U1 试点实测（约 +10 至 +25 字符）。

### S5 语言表述

- 现代中文书面语；不自造缩写或术语。
- 工具名 / 参数名 / 代码标识符原样保留。
- 表述清晰无歧义；靠模型 / 人工判断，不机械校验。

## 未决项

（工具级长度阈值已在 2026-10-25 定为 512，见下方 U1；已无未决项。）

### U1 工具级长度阈值（已定：512）

实测与试点：

- 实测分布（43 个已取数工具；缺 `script_run` / TUI 2 个未取）：最大 `goal_contract_draft` 409；350-400 档 3 个（`agent_group` 359 / `ast_query` 358 / `coagent` 353）；300-349 档 4 个；其余多在 200 以下。
- 五字段格式试点（`coagent` 353→377、`rule_test` 43→52）：行名 + 回行开销约 +10 至 +25，不是早期估计的 +60-80。
- **裁定：工具级长度上限 = 512 字符（Unicode 码点，整段含字段名 / 回行）**。现状全绿，且给五字段复杂度留足余量。

## 决策

2026-10-25 已定描述规范（6 项，全部作为逐工具检查的标准）：

| 项 | 标准 |
| --- | --- |
| S1 首句 | 首句 = 「第一个中/英文句号」与「128 字符」先到者（≤128 码点）；中 `。` 直接断，英 `.` 需后接空白或句尾 |
| S2 交叉引用 | 保持裸写；`snake_case` token = 工具名引用，校验落注册集（46 + 11）且拼写正确 |
| S3 参数级 | 每个参数必须有非空 `description` |
| S4 载体结构 | 五字段格式：`用途` / `用法` / `效果` / `边界` / `相关`；字段名后空一格，每行一字段；`用途` 必带，其余按需省略 |
| S5 语言表述 | 现代中文书面语；不自造缩写；工具名 / 参数名 / 标识符原样保留 |
| U1 工具级长度 | ≤ 512 字符（Unicode 码点，整段含字段名 / 回行） |

## 规划

计划改动文件清单（开工时定稿，覆盖被审工具与其参数描述）：

- 将被审的 **46 个本仓工具**所属各插件 `src/**/tools.ts`（或等价工具定义文件）：按 S1-S5 改进描述。包括此前实测未覆盖、需一并补入的 3 个：`script_run`（构造曾报错）与 TUI 的 `notice_history` / `local_log`。
- 已知欠账：`goal_contract_draft`（`ask_user` 修正 + 长度压缩）与 7 个 `action` 参数补描述；`rule_update` 首句按新规则复核。

执行决策（2026-10-25）：

- 范围：只改本仓 46 个工具；宿主侧工具（`read` / `edit` / `bash` 等）不改。
- 大批量执行：可开子代理（coagent）并行分批；分批按包分组。
- S2 交叉引用验证：在项目内直接检索核对（grep / 项目内工具）；引用到不属于本项目的，记下并跳过。

明确不做：

- 不开发 linter / `node --test` 测试 / 独立检查脚本。
- 不新增插件或包。
- 不改任何工具的行为 / schema 结构（只改 description 文本与参数描述）。
- 不改宿主侧工具描述。

## 实现记录

2026-10-25 按 S4 五字段格式改造全部 46 个工具（`coagent` / `rule_test` 两个试点已符合，保持原样），改动 21 个文件：

- `herdr-use/src/tools.ts`（10 个）、`md-logic/src/tools.ts`、`md-map/src/tools.ts`、`session-channel/src/index.ts`（4 个）、`task-engine/src/tools.ts`（5 个）、`ast-tools/src/tools.ts`（2 个）、`agent-group/src/main.ts`、`rule-engine/src/tools.ts`（5 个）、`goal-contract/src/tool.ts`、`preference-analysis/src/tools.ts`（3 个）、`code-map/src/index.ts`、`memory-base/src/tools.ts`、`background-daemon/src/tools.ts`、`tool-consult/src/tool.ts`、`hash-edit/src/main.ts`（2 个）、`metric-loop/src/index.ts`、`fs-digest/src/main.ts`、`context-report/src/main.ts`、`script-interpreter/src/tools.ts`、`TUI/src/app/adapter/notice-history-tool.ts`、`TUI/src/app/adapter/local-log-tool.ts`。
- S2：`goal_contract_draft` 的 `ask_user` 改为 `ask_user_question`；其余 `snake_case` token 逐个核对，均为参数名 / 动作名 / 枚举值 / 状态码，不是工具引用。
- S3：补 7 个 `action` 参数描述（`session_channel` / `channel_task` / `md_map` / `agent_group` / `daemon_task` / `metric_loop` / `code_map`）；另递归检查发现 `hash_edit.edits[]` 的 4 个变体键（`set_line` / `replace_lines` / `insert_after` / `delete_line`）无描述，一并补齐。
- S4：字段顺序统一为 `用途` / `用法` / `效果` / `边界` / `相关`，无实质内容的字段整行省略（如 `rule_list` 只有 `用途` + `相关`，`task_decompose` 无 `效果` / `边界`）。
- 参数级描述除上述 S3 欠账外未逐条重写（维持 P0-P2 已校准的文本）。

## 偏差

- `coagent` / `rule_test` 试点保持原样，未二次改写。
- 新写字段值沿用试点标点口径：逗号 / 分号 / 括号用 ASCII 并在标点后留空格，顿号 `、` 与句末 `。` 保留；既有工具的原中文标点随改写转为该口径（与试点一致）。
- `goal_contract_draft` 481 字符、`agent_group` 439、`script_run` 429：均在 U1 的 512 以内，但超出上一轮审阅的 400 软约束；本轮不加改写，留待 U1 收紧时再看。
- 未改任何工具行为 / schema 结构 / 测试；参数级描述只动 S3 欠账。

## 测试与证据

- 取数与复测脚本：`tmp/dump.mts`（导入各包源码构造 46 个工具定义，输出 `tmp/descs.json` / `tmp/measure.json`）、`tmp/check-fields.mts`（字段顺序 / 重复 / 首句 / 长度 / 参数非空）。两者为临时文件，收尾时删除。
- 46 个工具复测：U1 最长 `goal_contract_draft` 481（上限 512）；S1 首句最长 `herdr_list` 90（上限 128）；S4 五字段顺序与去重检查 0 问题；S3 递归参数检查 0 缺失。
- `npm run check` 全包通过（exit 0）。
- `npm run build` 全包通过（exit 0）。
- `npm run test` 全包通过（exit 0，34 包全绿；受影响包：TUI 1760 / herdr-use 136 / memory-base 83 / task-engine 150 / ast-tools 47 / md-logic 58 / md-map 50 / fs-digest 67 / goal-contract 41 / hash-edit 54 / metric-loop 47 / code-map 24 / context-report 41 / rule-engine 174 / session-channel 72 / background-daemon 166 / preference-analysis 68 / script-interpreter 94 / agent-group 63 / tool-consult 74）。

## 收尾

2026-10-25 关闭。实现提交 `0a41f00`（46 个工具描述改为五字段 + S2 / S3 修正 + 本文件）；用户确认提交，check / build / test 全绿。收尾变更（归档本文件、清理 BACKLOG 条目）随后提交。

命名：归档后本文件为 `docs/archived/2026-10-25-tool-description-lint.md`。
