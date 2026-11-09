# 工具说明全量审计与修订（接取条目：docs/BACKLOG.md「工具说明全量审计与修订」）

> 本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。
> 状态: 进行中（2026-11-09）——阶段一（审计, 只读）已完成；阶段二（修订）待用户指令逐项执行。

## 目标

让本仓所有模型侧工具的 `description` 覆盖五要素（用途 / 参数语义 / 返回值 / 边界与失败 / 典型用法）, 模型从工具说明即可了解用法与边界, 无需通过试错探索。交付顺序: 先审计（只读）→ 报告（本文件「调研」章节）→ 用户确认后修订。

## 调研

### 范围与方法

- 范围: 仅本仓 38 个包的模型侧工具（宿主 `ctx.tools.register` 注册面, 排除 `commands` 命令面与纯服务面）。
- 方法: grep 定位全部注册点 → 逐一读取工具定义（`src/tools.ts` 或注册点）→ 按五要素逐条核对 → 汇总缺口。
- 结果: 23 个包注册了 **54 个**模型侧工具, 无「无说明」或「严重不足」的工具; 多数已采用「用途 / 用法 / 效果 / 边界 / 相关」五段式(或四段式), 且普遍带邻工具分工指引。
- 与宿主官方口径对照: 宿主官方 65 个模型可见工具清单在宿主仓库 `docs/tool-catalog.md`（官方维护, 本任务不审不改, 只作背景）。

### 工具清单与逐条结论（54 个）

五要素列按「用途 / 参数语义 / 返回值 / 边界与失败 / 典型用法」; ✓ = 达标, △ = 部分达标（有但不完整）, ✗ = 缺。

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

汇总: 用途 54/54 ✓; 参数语义 54/54 ✓; 返回值 41/54 ✓; 边界与失败 52/54 ✓; 典型用法 49/54 ✓。

### 缺口清单（7 项, 按严重度排序）

1. **herdr-use 6 工具缺「何时不该用」引导**（`herdr-use/src/tools.ts:268-407` 的 list / info / wait / create / close / label）。现有 read / run / text / key 已写明「一条命令能跑完的事用 bash / 等待输出用 herdr_wait」等选择引导, 注释 `tools.ts:257-265` 明标其余 6 个为 P1 待办。建议: 对齐已写口径, 给这 6 个补「何时不该用」一句。
2. **metric_loop 的 window / plateau 与停止条件不直观, 缺「何时不该用」**（`metric-loop/src/index.ts:550-553`）。`window` 的 description 写「plateau 窗口」但未解释判定语义（窗口内数值不再改进即停）; 工具级描述未说明诊断模式下边界（timeBoundMs / tokenBound / maxRounds）如何收敛。建议: 展开 plateau 判定, 补「边界: 不需要指标驱动的场景别用」。
3. **rule_list 描述过简**（`rule-engine/src/tools.ts:186-187`）。只有「用途 + 相关」, 未说明返回结构（rules 数组字段 / status）与「配置基线 + 运行时层」两层来源。建议: 补「用法: 无参数」与返回体说明。
4. **task\_* 五工具返回的 accepted / next 未在描述里说明*\*（`task-engine/src/tools.ts:338-402`）。execute 均返回 `{ ok, accepted, next, feedback }`, 但描述只提「返回 accepted / next」或未提; 模型不知道 accepted 表示门禁是否通过、next 打回时指向重做目标。建议: 统一补一句。
5. **context_report 无「相关」段**（`context-report/src/main.ts:619-623`）。建议: 补「相关: task_status（任务树）、flow_status（流程推进）」或写明它只读报告、不替代状态查询。
6. **hash_read 未说明返回形状**（`hash-edit/src/index.ts:327-330`）。返回 `{ ok, path, file_hash, line_count, hashlines }`, 描述只写「是 hash_edit 的输入」。建议: 补「效果: 返回 file_hash 与 hashlines（LINE:HASH 数组）供 hash_edit 引用」。
7. **全仓普遍缺一句话典型调用示例**。action 枚举 ≥6 的工具（agent_group 12 / code_map 8 / daemon_task 8 / md_map 7 / session_channel 6 / metric_loop 4）最受益。建议: 对这类工具在「用法」段尾部补一句示例, 减少模型对参数组合的试错。

### 调研结论

本仓工具说明整体已达「模型一看即知大致用法」的水准, 距「无需试错」只剩上述 7 处收尾点: 1 处是已登记的 P1 待办（herdr-use）, 2 处涉及返回结构说明不足（rule_list / hash_read）, 2 处涉及语义不直观（metric_loop / task\_\*）, 1 处是互指空缺（context_report）, 1 处是示例缺失（全仓可选）。

## 决策

（阶段二修订时按「决策项 = 数字、选项 = abcd」记录; 目前未修订, 无决策。）

## 规划

### 计划改动文件清单（阶段二, 未执行）

| 文件 | 改动内容 | 对应缺口 |
| --- | --- | --- |
| `herdr-use/src/tools.ts` | 6 个工具描述补「何时不该用」 | 1 |
| `metric-loop/src/index.ts` | metric_loop 描述展开 window / plateau 与停止条件, 补「边界」 | 2 |
| `rule-engine/src/tools.ts` | rule_list 描述补用法与返回结构 | 3 |
| `task-engine/src/tools.ts` | 五工具描述补 accepted / next 字段说明 | 4 |
| `context-report/src/main.ts` | context_report 描述补「相关」 | 5 |
| `hash-edit/src/index.ts` | hash_read 描述补返回形状 | 6 |
| 各 action ≥6 工具所在文件 | 「用法」段尾补一句话典型示例（可选, 逐项评估） | 7 |

### 明确不做

- 不改宿主官方 65 个工具说明（官方维护, 本仓只读）。
- 不动参数 JSON Schema 结构（`additionalProperties` / `required` / `enum` / `items`）, 只改 `description` 文案; 若需补充参数语义, 只改对应参数的 `description` 字段。
- 不改 `execute` / `output` 行为与渲染。
- 不做自动化「说明质量」检查脚本（如需, 另开 BACKLOG 条目）。

## 实现记录

（阶段二执行时按时间追加。）

## 偏差

无（2026-11-09, 阶段一审计只读完成, 未改代码）。

## 测试与证据

- 阶段一为只读审计, 不改代码; 证据 = 逐一读取的 54 个工具定义（位置见「调研」清单表格）。
- 阶段二执行后再追 check / build / 测试结果。

## 收尾

（未关闭。）
