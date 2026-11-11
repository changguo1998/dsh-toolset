# 工具说明全量审计与修订（接取条目: docs/BACKLOG.md「工具说明全量审计与修订」）

> 本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改.
> 状态: 进行中. 调研（现状盘点）与决策项 1 / 2 已完成, 决策项 2 裁定沿用注册处 `description` 的现有格式（与宿主同款）, 不做注入改造; 决策项 3 已拆为独立条目并移入 `docs/implementation/2026-11-11-tool-description-registry.md`; 7 项文案修订未开始.

## 目标

让本仓所有模型侧工具的 `description` 覆盖五要素（用途 / 参数语义 / 返回值 / 边界与失败 / 典型用法）, 模型从工具说明即可了解用法与边界, 无需通过试错探索. 工具说明沿用注册处 `description` 的现有格式（与宿主同款）, 直接在注册处修订, 不引入 `TOOL_USAGE`、同名桩或调用门禁.

交付顺序: 调研（只读审计）→ 修订 7 项文案. 决策项 3 的单一来源与按需投递已另立条目, 不阻塞本任务.

## 调研

> 本节点只记现状（已经存在的情况）; 要做的事见「决策」.

### 工具说明现状

#### 范围与方法

- 范围: 仅本仓 38 个包的模型侧工具（宿主 `ctx.tools.register` 注册面, 排除 `commands` 命令面与纯服务面）.
- 方法: grep 定位全部注册点 → 逐一读取工具定义（`src/tools.ts` 或注册点）→ 按五要素逐条核对 → 汇总缺口.
- 结果: 23 个包注册了 54 个模型侧工具, 无「无说明」或「严重不足」的工具; 多数已采用「用途 / 用法 / 效果 / 边界 / 相关」五段式（或四段式）, 且普遍带邻工具分工指引.
- 与宿主官方口径对照: 宿主官方 65 个模型可见工具清单在宿主仓库 `docs/tool-catalog.md`（官方维护, 本任务不审不改, 只作背景）.

#### 工具清单与逐条结论（54 个）

五要素列按「用途 / 参数语义 / 返回值 / 边界与失败 / 典型用法」; ✓ = 达标, △ = 部分达标（有但不完整）, ✗ = 缺.

| 包 | 工具 | 位置 | 用 | 参 | 返 | 边 | 型 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pin-note | pin_note | `src/tools.ts:70` | ✓ | ✓ | ✓ | ✓ | ✓ | 五段式完整, 带用量软提示 |
| pin-note | note_list | `src/tools.ts:120` | ✓ | ✓ | ✓ | ✓ | ✓ | 返回结构写在用法里 |
| pin-note | note_remove | `src/tools.ts:164` | ✓ | ✓ | △ | ✓ | ✓ | 返回字段未列出（ok/id/error） |
| memory-base | memory_query | `src/tools.ts:105` | ✓ | ✓ | ✓ | ✓ | ✓ | mode/fuzzy/截断说明详尽 |
| rule-engine | rule_add | `src/tools.ts:158` | ✓ | ✓ | △ | ✓ | ✓ | 返回 ok/error/rule 未写明 |
| rule-engine | rule_list | `src/tools.ts:184` | ✓ | ✓ | ✗ | △ | △ | **缺口 3**: 只「用途 + 相关」, 未说明返回 |
| rule-engine | rule_update | `src/tools.ts:203` | ✓ | ✓ | △ | ✓ | ✓ | patch 语义讲清 |
| rule-engine | rule_remove | `src/tools.ts:265` | ✓ | ✓ | △ | ✓ | ✓ | 基线屏蔽语义讲清 |
| rule-engine | rule_test | `src/tools.ts:291` | ✓ | ✓ | ✓ | ✓ | ✓ | 干跑不改状态 |
| session-channel | session_channel | `src/tools.ts:96` | ✓ | ✓ | △ | ✓ | ✓ | 六 action 逐条说明 |
| session-channel | channel_delegate | `src/tools.ts:230` | ✓ | ✓ | ✓ | ✓ | ✓ | 返回 task_id 写明 |
| session-channel | channel_task | `src/tools.ts:283` | ✓ | ✓ | △ | ✓ | ✓ | 状态枚举在参数里 |
| session-channel | channel_task_result | `src/tools.ts:346` | ✓ | ✓ | ✓ | ✓ | ✓ | 截断与 failed 标注 |
| context-report | context_report | `src/main.ts:618` | ✓ | ✓ | ✓ | ✓ | ✗ | **缺口 5**: 无「相关」段 |
| ast-tools | ast_query | `src/tools.ts:183` | ✓ | ✓ | ✓ | ✓ | ✓ | 边界穷举 grep/glob/fs_digest 分工 |
| ast-tools | ast_replace | `src/tools.ts:381` | ✓ | ✓ | ✓ | ✓ | ✓ | dry-run + 写回守卫讲清 |
| agent-group | agent_group | `src/index.ts:165` | ✓ | ✓ | ✓ | ✓ | ✓ | 12 action 逐条一句话 |
| md-map | md_map | `src/tools.ts:61` | ✓ | ✓ | △ | ✓ | ✓ | 无「效果」段, 各 action 返回未列 |
| task-engine | task_decompose | `src/tools.ts:374` | ✓ | ✓ | △ | ✓ | ✓ | **缺口 4**: accepted/next 未说明 |
| task-engine | task_implement | `src/tools.ts:381` | ✓ | ✓ | △ | ✓ | ✓ | 返回字段未列 |
| task-engine | task_execute | `src/tools.ts:338` | ✓ | ✓ | △ | ✓ | ✓ | 证据回填, 返回字段未列 |
| task-engine | task_stop | `src/tools.ts:391` | ✓ | ✓ | △ | ✓ | ✓ | accepted/next 未说明 |
| task-engine | task_status | `src/tools.ts:398` | ✓ | ✓ | ✓ | ✓ | ✓ | rounds/tree/折叠都讲了 |
| flow-track | flow_record | `src/tools.ts:87` | ✓ | ✓ | △ | ✓ | ✓ | 顺序策略专段 |
| flow-track | flow_status | `src/tools.ts:184` | ✓ | ✓ | △ | ✓ | ✓ | 返回结构未列, 只读讲清 |
| flow-track | flow_enable | `src/tools.ts:243` | ✓ | ✓ | ✓ | ✓ | ✓ | 开关与进程内语义讲清 |
| flow-track | flow_remove | `src/tools.ts:280` | ✓ | ✓ | ✓ | ✓ | ✓ | id/slug 二选一讲清 |
| flow-track | flow_rollback | `src/tools.ts:347` | ✓ | ✓ | △ | ✓ | ✓ | 目标阶段保留讲清 |
| code-map | code_map | `src/index.ts:337` | ✓ | ✓ | △ | ✓ | ✓ | 隐式建索引差异讲清 |
| coagent | coagent | `src/tools.ts:70` | ✓ | ✓ | ✓ | ✓ | ✓ | 只接受参数清单写明 |
| metric-loop | metric_loop | `src/index.ts:548` | ✓ | △ | △ | ✗ | △ | **缺口 2**: window/plateau 与停止条件不直观 |
| md-logic | md_logic | `src/tools.ts:209` | ✓ | ✓ | ✓ | ✓ | ✓ | edits 校验与 section_hash 详述 |
| preference-analysis | preference_list | `src/tools.ts:101` | ✓ | ✓ | ✓ | ✓ | ✓ | 状态枚举逐条 |
| preference-analysis | preference_add | `src/tools.ts:133` | ✓ | ✓ | ✓ | ✓ | ✓ | 候选待审边界明确 |
| preference-analysis | preference_remove | `src/tools.ts:172` | ✓ | ✓ | △ | ✓ | ✓ | 撤审权不交给模型的边界写明 |
| fs-digest | fs_digest | `src/index.ts:205` | ✓ | ✓ | △ | ✓ | ✓ | 三 mode 各有参数说明 |
| hash-edit | hash_read | `src/index.ts:326` | ✓ | ✓ | ✗ | ✓ | ✓ | **缺口 6**: 未说明返回形状 |
| hash-edit | hash_edit | `src/index.ts:370` | ✓ | ✓ | ✓ | ✓ | ✓ | stale 整批拒绝讲清 |
| herdr-use | herdr_list | `src/tools.ts:268` | ✓ | ✓ | ✓ | ✓ | △ | **缺口 1**: 无「何时不该用」 |
| herdr-use | herdr_read | `src/tools.ts:277` | ✓ | ✓ | ✓ | ✓ | ✓ | 已写何时用/不当用 |
| herdr-use | herdr_info | `src/tools.ts:307` | ✓ | ✓ | ✓ | ✓ | △ | **缺口 1** |
| herdr-use | herdr_wait | `src/tools.ts:321` | ✓ | ✓ | ✓ | ✓ | △ | **缺口 1** |
| herdr-use | herdr_create | `src/tools.ts:368` | ✓ | ✓ | ✓ | ✓ | △ | **缺口 1** |
| herdr-use | herdr_close | `src/tools.ts:395` | ✓ | ✓ | ✓ | ✓ | △ | **缺口 1** |
| herdr-use | herdr_label | `src/tools.ts:409` | ✓ | ✓ | ✓ | ✓ | △ | **缺口 1** |
| herdr-use | herdr_text | `src/tools.ts:426` | ✓ | ✓ | ✓ | ✓ | ✓ | 已写何时用/不当用 |
| herdr-use | herdr_key | `src/tools.ts:444` | ✓ | ✓ | ✓ | ✓ | ✓ | 已写何时用/不当用 |
| herdr-use | herdr_run | `src/tools.ts:465` | ✓ | ✓ | ✓ | ✓ | ✓ | 已写何时用/不当用 |
| background-daemon | daemon_task | `src/tools.ts:58` | ✓ | ✓ | △ | ✓ | ✓ | 选择器形态 enum 里写全 |
| goal-contract | goal_contract_draft | `src/tool.ts:65` | ✓ | ✓ | ✓ | ✓ | ✓ | readback.match 写明 |
| tool-consult | consult_tools | `src/tool.ts:152` | ✓ | ✓ | ✓ | ✓ | ✓ | 咨询即授权语义明确 |
| script-interpreter | script_run | `src/tools.ts:474` | ✓ | ✓ | ✓ | ✓ | ✓ | 与 bash 分工 + 沙箱语义明确 |
| TUI | tui_local_log | `src/app/adapter/local-log-tool.ts:103` | ✓ | ✓ | ✓ | ✓ | ✓ | 与 notice_history 互指 |
| TUI | notice_history | `src/app/adapter/notice-history-tool.ts:98` | ✓ | ✓ | ✓ | ✓ | ✓ | 与 tui_local_log 互指 |

汇总: 用途 54/54 ✓; 参数语义 53/54 ✓; 返回值 33/54 ✓; 边界与失败 52/54 ✓; 典型用法 45/54 ✓.

另有 14 个工具的「返回值」为 △（有说明但未逐字段列出）, 按可接受处理, 不列入修订范围: note_remove、rule_add、rule_update、rule_remove、session_channel、channel_task、md_map、flow_record、flow_status、flow_rollback、code_map、preference_remove、fs_digest、daemon_task.

#### 缺口清单（7 项, 按严重度排序）

1. herdr-use 的 6 个工具缺「何时不该用」引导（`herdr-use/src/tools.ts:268-407` 的 list / info / wait / create / close / label）. read / run / text / key 已写明选择引导（如「一条命令能跑完的事用 bash」, 等待输出用 herdr_wait）, 注释 `tools.ts:257-265` 明标其余 6 个为 P1 待办.
2. metric_loop 的 window / plateau 与停止条件不直观, 缺「何时不该用」（`metric-loop/src/index.ts:550-553`）, `window` 的 description 写「plateau 窗口」但未解释判定语义（窗口内数值不再改进即停）; 工具级描述未说明诊断模式下边界（timeBoundMs / tokenBound / maxRounds）如何收敛.
3. rule_list 描述过简（`rule-engine/src/tools.ts:186-187`）. 只有「用途 + 相关」, 未说明返回结构（rules 数组字段 / status）与「配置基线 + 运行时层」两层来源.
4. task 系列 4 个工具（decompose / implement / execute / stop）未在其描述里说明返回的 accepted / next（`task-engine/src/tools.ts:338-395`）. 这 4 个工具都返回 accepted / next, 成功返回不含 `feedback`, 失败时另带 `feedback`; 描述只提「返回 accepted / next」或未提, 模型不知道 accepted 表示门禁是否通过, next 打回时指向重做目标. task_status 不返回这两个字段.
5. context_report 无「相关」段（`context-report/src/main.ts:619-623`）.
6. hash_read 未说明返回形状（`hash-edit/src/index.ts:327-330`）. 返回 `{ ok, path, file_hash, line_count, hashlines }`, 描述只写「是 hash_edit 的输入」.
7. 全仓普遍缺一句话典型调用示例. action 枚举 ≥4 的工具（agent_group 12 / code_map 8 / daemon_task 8 / md_map 7 / session_channel 6 / metric_loop 4）均未给示例.

#### 调研结论

本仓工具说明整体已达「模型一看即知大致用法」的水准, 距「无需试错」只剩上述 7 处收尾点: 1 处是已登记的 P1 待办（herdr-use）, 2 处涉及返回结构说明不足（rule_list / hash_read）, 2 处涉及语义不直观（metric_loop / task\_\*）, 1 处是互指空缺（context_report）, 1 处是示例缺失. 其余「返回值」为 △ 的 14 个工具按可接受处理, 不列入修订范围.

> 非工具说明类内容（规范 / 引导 / 术语表等）的注入机制盘点与三分类, 已拆到 `docs/implementation/2026-11-10-injection-inventory.md`.

### 注入方式现状

#### 承载方式

- 模型侧工具说明随工具声明进 tools 槽位, 每工具一条 `{ name, description, input_schema }`, description 原样全量、不截断（宿主 `llm-deepseek/src/serialize.ts:160-167`, `tool-executor-native/src/index.ts:15-17`）.
- description 只能来自注册定义（宿主 `core/tools/src/schema.ts:641`）; assemble 瀑布不接管 tools, 声明始终由 provider 提供（宿主 `system-prompt/src/index.ts:687`）→ 说明要改只能改注册处.
- 本仓现状: 23 个包 54 个工具全部经 tools 槽位申报; 未揭示的多数受 tool-consult 的 `restrict` 遮罩, 不在槽位呈现; 0 项把工具说明放进 `ctx.systemPrompt.section`（规范 / 引导类另有载体, 见 `docs/implementation/2026-11-10-injection-inventory.md`）.
- tool-consult 现状: 用 `tools.restrict({ allow })` 遮罩（`tool-consult/src/index.ts:250-293`）; 揭示 = 把工具名加回 allow 列表, 该工具的声明（含全量描述与参数 schema）重新进入 tools 槽位; 检索索引从 `tools.schemas()` 的 description 建（`tool-consult/src/index.ts:191-202`）.
- 缓存后果: tools 槽位位于 messages 之前, 遮罩或揭示都会改动槽位, 该次请求的前缀从头失效.

#### 宿主的可见性档位与派发

- 三档: 声明（`register` 注册, `when: true`）; 剔除（`when: false` 或 `restrict`, 声明与派发一起去掉, 宿主 `core/tools/src/index.ts:156-182`, `core/tools/src/contracts.ts:115-124`）; 已声明未激活（`deferLoading` + `tool_addition` 激活, 需路由 `toolUpdate`, 宿主 `llm-deepseek/src/wire-types.ts:38`, `llm/src/content.ts:382-394`）.
- 没有「声明常驻、派发拒绝」的原生档位; 要拒绝某个工具的调用只能自己挂 `tools/pre-execute`（宿主 `core/tools/src/events.ts:18`）.
- 同名遮蔽: 在作用域内注册同名工具会遮住全局定义, 撤掉作用域注册后全局定义重新可见（宿主 `core/tools/src/index.ts:121-128`, "Scoped tools shadow globals"）. 该能力存在, 但本任务已否决「同名桩」方案, 保留为宿主能力记录.
- 本机路由: profile `fff` 的 `llm-pi-ai` 段（provider `tg` / `openai-completions` / 模型 `ds41f`）只设 `compat.supportsDeveloperRole: false`; `toolUpdate` 与 `systemPromptUpdate` 由 compat 标志算出（宿主 `llm-pi-ai/src/models.ts:75-91`）, 两项都为空; 能力为空时宿主每次全量发出工具并丢弃 developer 消息（宿主 `llm/src/content.ts:445-451`）→ `defer_loading` 路线在本机不可用.

## 决策

> 本节点只记要做的事（想要做的内容）; 现状与依据见「调研」.

### 决策项 1: 审阅结论（7 项缺口）的处置

2026-11-10 用户裁定 a), 7 项全改, 含缺口 7 的示例; action 枚举 ≥4 的六个工具（agent_group / code_map / daemon_task / md_map / session_channel / metric_loop）优先补.

选项: a) 7 项全改（含缺口 7 的示例补写）; b) 只改缺口 1 至 6, 缺口 7 逐项评估; c) 先改缺口 1 至 3, 其余记入 BACKLOG; d) 暂不改, 审计结论只留档.

修订对象: 这 7 项内容直接写入各工具注册处的 `description`; 不引入 `TOOL_USAGE`、包装函数或其他注入载体.

### 决策项 2: 工具说明的注入方式

裁定（2026-11-11）: 沿用现有格式, 即工具说明写在注册处 `description`, 随 tools 声明全量进入工具槽位, 与宿主官方工具的承载方式相同; 不做注入改造, 不新增 `TOOL_USAGE`、同名桩或调用门禁.

否决记录: 曾考虑在 agent 作用域为每个工具注册同名桩, `description` 只留一行、`parameters` 留空, 揭示时撤桩恢复真实声明. 否决原因: 揭示与撤桩必然改动 tools 数组, 与「tools 槽位稳定」冲突; 空参让模型猜参数.

现状与约束:

1. `description` 与 `parameters` 仍由注册处全量进入 tools; tool-consult 用 `tools.restrict` 遮罩, 揭示时改 allow 清单, 会改 tools 数组、缓存断在 tools; 本任务不据此做注入改造.
2. tools 数组在会话期间保持稳定; 说明是静态文本, 构建后不再变化.
3. 不改参数 JSON Schema; 参数语义只改对应参数的 `description` 字段.
4. 不再采用同名桩、空参或撤桩重建声明.

官方条件工具: 不包装（包装会丢 `when`）. 官方清单原有 8 个; 本机 `exit_plan_mode` 已随 plan-mode 禁用, `propose_action` 未挂载, 4 个 `team_task_*` 仍挂载但 Team 条件未开.

结论: 本项已裁定; 注入改造取消, 直接执行 7 项说明修订.

### 决策项 3: 已拆出

- 完整说明的单一来源与按需投递（`TOOL_USAGE` + `registerWithDocs` + 模块级台账 + 22 个工具包依赖）不再由本任务承担.
- 新条目: `docs/BACKLOG.md`「工具说明注册表与按需投递」; 新追踪文档: `docs/implementation/2026-11-11-tool-description-registry.md`.
- 本任务只保留 7 项 `description` 文案修订.

## 规划

### 修订计划（未执行）

修订只做 7 项说明文案: 直接修改各工具注册处的 `description`, 不改参数 schema、`execute` / `output` 与工具可见性. 注入改造已随决策项 2 裁定取消, 不在本计划内. 任务按 T1 至 T7 顺序执行, 每项改完跑对应包 check / test, 全部完成后跑全量 check / build / test.

#### 任务清单（7 项）

每项列「可机械审计的断言」: 内容用 grep 命中「应含片段」核对, 结构对照本文件「调研」清单, 不依赖阅读判断.

| # | 任务 | 文件 / 登记位置 | 改动要点 | 可机械审计的断言 |
| --- | --- | --- | --- | --- |
| T1 | 补「何时不该用」 | `herdr-use/src/tools.ts`（list / info / wait / create / close / label, 行号 268 / 307 / 321 / 368 / 395 / 409） | 各 description 末段补一句「何时不该用」: 能用 bash 一条命令跑完的操作别用 herdr | 6 个注册处的 description 各含「不该」且含「bash」 |
| T2 | 展开 window / plateau 与停止条件 | `metric-loop/src/index.ts:548`（metric_loop） | description 解释 window 判定语义（窗口内数值不再改进即停）与诊断模式收敛边界（timeBoundMs / tokenBound / maxRounds）; 用法段尾补一句话示例 | description 含「不再改进」且含「timeBoundMs」; 含「例如」 |
| T3 | 补用法与返回结构 | `rule-engine/src/tools.ts:184`（rule_list） | description 补「用法: 无参数」, 返回 rules 数组字段与 status, 及「配置基线 + 运行时层」两层来源 | description 含「基线」且含「rules」且含「status」 |
| T4 | 补 accepted / next | `task-engine/src/tools.ts`（execute / decompose / implement / stop, 行号 338 / 374 / 381 / 391） | 各 description 说明 accepted = 门禁通过, next = 打回后重做目标, 失败返回含 `feedback`; task_status 不返回这两个字段, 不改 | 4 个注册处的 description 各含「accepted」且含「next」 |
| T5 | 补「相关」 | `context-report/src/main.ts:618`（context_report） | description 补「相关」段: 指向 task_status / flow_status, 写明只读报告不替代状态查询 | description 含「相关」 |
| T6 | 补返回形状 | `hash-edit/src/index.ts:326`（hash_read） | description 补返回体 `{ ok, path, file_hash, line_count, hashlines }`, 供 hash_edit 引用 | description 含「file_hash」且含「hashlines」 |
| T7 | 补一句话典型示例 | 5 个工具: agent_group（`agent-group/src/index.ts:165`）/ code_map（`code-map/src/index.ts:337`）/ daemon_task（`background-daemon/src/tools.ts:58`）/ md_map（`md-map/src/tools.ts:61`）/ session_channel（`session-channel/src/tools.ts:96`）; metric_loop 由 T2 一并处理 | 各 description 的「用法」段尾补「例如: 」一句话调用 | 6 个注册处的 description 各含「例如」 |

> 修订直接写注册处 `description`; 不预设 `TOOL_USAGE`.

#### 机械审计（实施后逐项执行）

- 内容断言: 按任务表「可机械审计的断言」逐条 grep, 每条至少命中一处.
- 结构不变: 工具名集合仍为 54 个, 未新增 / 删除注册; 逐文件对比改前改后, 参数 JSON Schema（`additionalProperties` / `required` / `enum` / `items`）零变化.
- 改动面最小: 11 个源文件当前相对 HEAD 无改动, 实施后 `git diff` 只覆盖这些文件且只含 `description` 行; 不含 `TOOL_USAGE`、新桩、`restrict` / reveal / withdraw 调用.
- 工程门禁: `pnpm run check` + `pnpm run build` + `pnpm run test` 全绿.
- 缓存口径: 不引入任何会改 tools 槽位数组的机制, 不触碰 tool-consult 的 `restrict` 逻辑（与决策项 2 裁定一致）.

### 明确不做

- 不改宿主官方工具说明（官方维护, 本仓只读）; 不改其 `description` 与参数 schema; 不再采用同名桩.
- 不动参数 JSON Schema 结构（`additionalProperties` / `required` / `enum` / `items`）, 只改 `description` 文案; 若需补充参数语义, 只改对应参数的 `description` 字段.
- 不改既有工具的 `execute` / `output` 行为与渲染; 不新增桩.
- 不做自动化「说明质量」检查脚本（如需, 另开 BACKLOG 条目）.
- 本任务不引入 `TOOL_USAGE` / `registerWithDocs` / 模块级台账 / 22 个工具包依赖; 这些归决策项 3 的新条目.

## 实现记录

（修订执行时按时间追加.）

## 偏差

- 决策项 2 的同名桩方案被否决（2026-11-11）, 裁定沿用注册处 `description` 的现有格式; 注入改造取消. 此前的桩 / 撤桩 / 22 包依赖 / TUI 一行方案不作考虑, 仅在此留档.
- 与 `docs/implementation/2026-11-10-injection-inventory.md` 及 `docs/BACKLOG.md`「各插件注入方式整理」的分类冲突按分工消解: 本任务只改 tools 槽位内的 `description`, 不改注入方式; 工具总则 / 按需投递归 injection-inventory 与决策项 3 的新条目.
- 官方 plan-mode 已禁用（本机 fff / fff-test 与仓库示例 profile）, 自研 plan 模式另立项目级 BACKLOG 条目; 本任务不再处理 `exit_plan_mode` 的说明.

## 测试与证据

- 调研为只读审计, 不改代码; 证据 = 逐一读取的 54 个工具定义（位置见「调研」清单表格）.
- 注入改造取消; 7 项说明修订未开始; 完成后补 check / build / test 结果.

## 收尾

（未关闭.）
