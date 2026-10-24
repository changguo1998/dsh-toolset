# 审阅本项目各工具的描述是否准确合理（接取条目：`docs/BACKLOG.md`「审阅本项目各工具的描述是否准确合理」）

状态：已关闭　　开启：2026-10-24　　关闭：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮范围只到**调研与决策**（实现待用户批准后另接），除本文件外任何文件都不改。

## 目标

逐包核对各工具的工具级与参数级 `description` 是否与实现行为一致，修正失真 / 误导 / 过时措辞；对语义重叠的工具写明「与 X 的区别、何时选谁」；同步复核 `tool-consult` 的别名表与检索回归断言。

## 调研

调研基线：当前工作区（2026-10-24），宿主 `dsh 0.2.1-rc.2`。全部结论来自只读阅读与只读脚本；未运行 `build` / `test` / `format`，未改任何源码。

### 1. 工具面盘点

仓库共 32 个插件包，其中 20 个包注册模型侧工具（19 个功能插件 + `tool-consult`），TUI 另注册 2 个；合计 **46 个工具 / 197 个顶层参数**。没有模型侧工具的 12 个包：`auto-approve` / `behavior-correction` / `clock-base` / `command-template` / `herdr-integration` / `md-table-check` / `output-compress` / `ponytail` / `security-guard` / `session-paths` / `session-title-cutoff` / `symbol-normalizer`。

规模口径：工具级描述合计约 **9,208 字符**；参数级描述按顶层参数统计约 **6,915 字符**，递归展开嵌套 schema 约 **8,547 字符**；按顶层口径总计约 1.6 万字符，递归口径约 1.8 万字符。工具级平均约 200 字符；10 个工具超过 300 字符，3 个超过 500 字符（`md_logic` 855、`md_map` 604、`agent_group` 594）；最短为 `task_implement` 13 字符。描述全部为手写字符串，中文为主，宿主核心工具（`bash` / `read` / `edit` / `glob` / `grep` 等）为英文，存在中英混排。

| 包 | 工具数 | 工具名 | 工具级字符 | 参数级字符（顶层） | 参数数 |
| --- | --- | --- | --- | --- | --- |
| `herdr-use` | 10 | `herdr_list` `herdr_read` `herdr_info` `herdr_wait` `herdr_create` `herdr_close` `herdr_label` `herdr_text` `herdr_key` `herdr_run` | 1002 | 868 | 25 |
| `md-logic` | 1 | `md_logic` | 855 | 551 | 11 |
| `session-channel` | 4 | `session_channel` `channel_delegate` `channel_task` `channel_task_result` | 712 | 421 | 22 |
| `task-engine` | 5 | `task_decompose` `task_implement` `task_execute` `task_stop` `task_status` | 673 | 135 | 6 |
| `ast-tools` | 2 | `ast_query` `ast_replace` | 637 | 566 | 18 |
| `md-map` | 1 | `md_map` | 604 | 215 | 6 |
| `agent-group` | 1 | `agent_group` | 594 | 284 | 8 |
| `rule-engine` | 5 | `rule_add` `rule_list` `rule_update` `rule_remove` `rule_test` | 478 | 1107 | 17 |
| `TUI` | 2 | `notice_history` `tui_local_log` | 397 | 263 | 6 |
| `goal-contract` | 1 | `goal_contract_draft` | 391 | 339 | 4 |
| `coagent` | 1 | `coagent` | 343 | 362 | 10 |
| `preference-analysis` | 3 | `preference_list` `preference_add` `preference_remove` | 337 | 101 | 6 |
| `script-interpreter` | 1 | `script_run` | 334 | 183 | 5 |
| `code-map` | 1 | `code_map` | 324 | 95 | 4 |
| `memory-base` | 1 | `memory_query` | 305 | 218 | 9 |
| `background-daemon` | 1 | `daemon_task` | 278 | 337 | 8 |
| `tool-consult` | 1 | `consult_tools` | 215 | 163 | 6 |
| `hash-edit` | 2 | `hash_read` `hash_edit` | 206 | 152 | 5 |
| `metric-loop` | 1 | `metric_loop` | 187 | 204 | 11 |
| `fs-digest` | 1 | `fs_digest` | 182 | 261 | 7 |
| `context-report` | 1 | `context_report` | 154 | 90 | 3 |
| 合计 | 46 | - | 9208 | 6915 | 197 |

参数级规模不均：`rule_add` 一个工具的参数描述约 936 字符（12 个参数，共用 `RULE_PARAMS`），`rule_update.patch` 又嵌套复用同一份 `RULE_PARAMS`（递归后 `rule-engine` 约 2,333 字符）；`md_logic` 顶层约 551 字符（嵌套的 `edits[].content` 与 `section_hash` 另计，递归后约 802 字符），`ast_query` 约 430 字符；另一端 `rule_list` 无参数、`task_status` 无参数。工具级与参数级描述没有分工约定，存在大量重复（如 `md_logic` 的节替换规则在工具级和 `edits` 参数里各写一遍）。

### 2. 重叠对

逐个对照「实现差异 / 描述是否说清 / 证据」：

| 重叠对 | 实际差异 | 现有描述是否说清选择依据 | 证据 |
| --- | --- | --- | --- |
| `task_status` / `channel_task` | `task_status` 读 task-engine 的嵌套任务树（帧、轮次、`parent_id + order`），只读、无参数；`channel_task` 读 Redis 里的跨会话委托任务记录，`status` / `list` / `cancel` 三个动作。两者数据源与生命周期完全不同。 | 未说清。两份描述各说各的领域，都没有点名对方；别名表把「任务状态」同时挂给两者。检索实测「任务状态」top-1 是 `channel_task`（10.85），`task_status` 第二（9.76）。 | `task-engine/src/tools.ts:350-357`、`session-channel/src/index.ts:1704-1712`、`tool-consult/src/aliases.ts:20`、`:25` |
| `bash` / `herdr_run` | `bash` 每次全新 shell、在会话工作区与文件沙箱内执行，返回 stdout/stderr；`herdr_run` 往一个已存在的 herdr 终端注入「文本 + 回车」，复用终端会话状态，命令跑在 dsh 进程外、不受文件沙箱约束，过 security-guard 复查。 | 未说清。`herdr_run` 只写了「跑在进程外、过 security-guard」，没有写「一次性命令用 bash、需要交互状态或 TUI 用本工具」。`herdr-use/src/tools.ts:260-263` 的模块注释声称描述里写了这条，但实际十个工具描述（`:267-463`）都没有。 | 宿主 `@deepseek-ai/dsh-tool-bash/lib/index.js:243-244`、`herdr-use/src/tools.ts:446-450`、`herdr-use/src/tools.ts:260-263` |
| `edit` / `hash_edit` / `md_logic` | `edit` 是宿主文件级字面量替换 + 读后改前版本守卫；`hash_edit` 是行级 `LINE:HASH` 锚点编辑，同一次 `hash_read` 的锚点整批校验、任一失效整批拒绝；`md_logic` 的 `replace` 是按 Markdown 节（标题 + 行范围 + 节内容 hash）整节替换 / 删除，改层级会被拒。 | 部分说清。`md_logic` 用一整段写明三方分工（`:187`），`ast_replace` 也指向 `hash_edit`；但 `hash_edit` 自身只写锚点，没有提 `edit` / `md_logic`。`hash-edit/README.md:71` 明确说「两者靠工具描述区分」，实际描述缺这半边。 | `hash-edit/src/main.ts:325-329`、`md-logic/src/tools.ts:186-188`、`ast-tools/src/tools.ts:385-389`、`hash-edit/README.md:71`、`docs/ARCHITECTURE-REUSE.md:59` |
| `read` / `herdr_read` | `read` 读 UTF-8 文件并给行号；`herdr_read` 从 herdr socket 取终端屏内容（`source` / `lines` / `format`），只接受本插件登记的 `terminal_id`。对象完全不同，但名字都叫 read。 | 基本说清对象差异（「终端屏内容」vs「UTF-8 text file」），但没有互指：`herdr_read` 未写「读文件用 read」，`read` 是宿主工具无法改。检索「读取终端输出」top-1 是 `herdr_wait`（11.54），`herdr_read` 第二（8.09），说明「输出」一词把等待工具顶上来。 | 宿主 `@deepseek-ai/dsh-tool-fs/lib/index.js:251-252`、`herdr-use/src/tools.ts:274-279` |
| `grep` / `ast_query` / `md_map` | `grep` 是文件内容正则检索；`ast_query` 是 AST 结构匹配（不会命中字符串 / 注释里的同名文本）+ 大纲 + YAML 规则；`md_map` 是项目级 Markdown 引用图（文档 / 锚点 / 影响面 / 断链），不是全文检索。 | 部分说清。`ast_query` 有选择成本段，但把 `glob` 也归进「文本 / 正则检索」，且「谁引用了某符号」这句交叉引用反而把 `ast_query` 顶到该查询的 top-1。`md_map` 说清了与 `code_map` / `md_logic` 的分工，但没说「不做全文检索」。 | `ast-tools/src/tools.ts:180-188`、`md-map/src/tools.ts:62-69`、宿主 `@deepseek-ai/dsh-tool-fs-search/lib/index.js:1090-1091` |
| `glob` / `code_map` | `glob` 按路径模式找文件（含隐藏 / 忽略文件，按修改时间排序）；`code_map` 建符号表 + import 图，回答引用 / 影响面 / 依赖环，不按路径模式找文件。 | 基本不冲突，但 `code_map` 没有写「按路径找文件用 glob」，也没有写 `callers` / `callees` / `impact` 会隐式建索引（只有 `cycles` 明确不建）。 | 宿主 `@deepseek-ai/dsh-tool-fs-search/lib/index.js:782-783`、`code-map/src/index.ts:338-342`、`:389-397` |
| `task_stop` / `channel_task cancel` | `task_stop` 不是取消，而是对任务做 RET 验收（mechanical / human / semantic），通过后完成并向上 join；`channel_task cancel` 才是取消一个跨会话委托任务。 | 未说清。`task_stop` 描述写了「验收」，但没写「本工具不取消任务」；`channel_task` 的 `cancel` 写了取消。别名把「停止任务」挂给 `task_stop`。检索「停止任务」top-1 是 `task_stop`（15.68），`channel_task` 只有 3.00；若用户本意是取消委托，会选错。 | `task-engine/src/tools.ts:346-349`、`session-channel/src/index.ts:1704-1712`、`tool-consult/src/aliases.ts:22` |

其他值得关注、但未纳入七组主对的重叠：

- `coagent` / `channel_delegate`：`coagent` 明确写了「派任务用 channel_delegate」（`coagent/src/tools.ts:64-66`），`channel_delegate` 没有反向提 `coagent`。
- `fs_digest` / `md_logic`：双向都写了分工（`fs-digest/src/main.ts:207-210`、`md-logic/src/tools.ts:186`），是现有描述里做得最好的一对。
- `notice_history` / `tui_local_log`：一个读宿主 notice 历史，一个读 TUI 本地输出旁路；两者没有互指，也没有「本地日志 / 命令历史」这类别名。检索「命令历史」top-1 是 `notice_history`（5.61），`tui_local_log` 未进前三。
- `session_channel send` / `channel_delegate`：`channel_delegate` 提了 `channel_task`，`session_channel` 没提 `channel_delegate`；发消息与委托任务的边界只能靠模型自己推断。
- `memory_query` / `preference_list`：前者查知识库 / 记忆，后者查偏好账簿；命名与描述都未互指，但语义距离较远，暂列低优先。

### 3. 失真与过时抽样

以下 12 例均给出 `文件:行`，按「类型 / 现状 / 影响」列出：

| # | 类型 | 证据 | 现状与影响 |
| --- | --- | --- | --- |
| D1 | 参数不一致 | `session-channel/src/index.ts:1534-1536` | `to` 参数只写「目标会话 id，或 cwd:\<绝对路径>」，漏了别名；工具级描述 `:1523` 与实现 `resolveTarget`（`session-channel/src/broker.ts:436-447`）都支持别名。模型会以为别名不能用于 `send`。 |
| D2 | 参数不一致 | `md-map/src/tools.ts:102`、`:64`、`md-map/src/indexer.ts:94` | `root` 参数写「缺省当前会话工作目录」，工具级写「当前工作目录」，实现回落 `process.cwd()`。会话 cwd 与进程 cwd 不同时，模型按描述省略 `root` 会索引到进程 cwd，而不是它以为的会话 cwd。 |
| D3 | 漏下一步指路 | `hash-edit/src/main.ts:326-329`、`hash-edit/README.md:71`、`docs/ARCHITECTURE-REUSE.md:59` | `hash_edit` 只描述锚点机制，没有写「文件级版本守卫用 edit、按节改 Markdown 用 md_logic」；README 与架构文档却把「靠工具描述区分」当作边界成立的前提。模型容易拿 `hash_edit` 做整文件替换或 Markdown 整节替换。 |
| D4 | 漏能力边界 | `task-engine/src/tools.ts:344`、`:306-309` | `task_implement` 全文只有 13 字「完成一个叶子任务并写入产出」，没有写「仅 model 后端 / 缺省叶子」；反向指路只在 `task_execute` 里。声明了 `subagent` / `workflow` / `command` executor 的叶子若直接调 `task_implement`，后端不会被执行，只写回产出。 |
| D5 | 过时 / 漏指路 | `metric-loop/src/index.ts:561-562` | 描述让模型「用宿主 `schedule_create` 排下次自动唤醒」，但当前 profile 没有挂载 `dsh-schedule`（既有记录：`docs/archived/2026-10-02-host-upgrade-execution.md:61`）；本仓等价物是 `daemon_task`（`background-daemon/src/tools.ts:18`）。模型会调用不存在的工具，循环停摆。 |
| D6 | 漏选择依据 | `herdr-use/src/tools.ts:260-263`、`:446-450` | 模块注释声称十个工具描述会写「何时用本工具族 / 何时该用 bash」，实际 `herdr_run` 只写「跑在 dsh 进程之外，过 security-guard」。模型可能用 `herdr_run` 跑一条一次性命令（绕过文件沙箱），也可能用 `bash` 去操作交互式 TUI。 |
| D7 | 选择指引错误 | `ast-tools/src/tools.ts:184` | 「文本 / 正则检索用宿主的 grep / glob」把 `glob`（路径匹配）当成内容检索。模型可能拿 `glob` 去搜正文，得到空结果或路径噪声。 |
| D8 | 术语不统一 | `md-logic/src/tools.ts:187`、`coagent/src/tools.ts:64-66`、`agent-group/src/main.ts:172` | 混用「官方 edit」「宿主」「session-channel 的 channel_delegate」「session-channel / session-paths」等称呼；模型实际看到的是工具名 `edit` / `session_channel`，包名与「官方」都不是可调用名。交叉引用因此不可执行、也不利于检索。 |
| D9 | 参数语义缺失 | `background-daemon/src/tools.ts:110-114`、`background-daemon/src/records.ts:151-155` | `tier` 只写「分档（缺省 S）」，没有解释 `S` / `P` / `U` 分别落 session / project / user 层。模型无法判断该用哪档，可能把会话级任务写到用户层。 |
| D10 | 参数语义冲突 | `memory-base/src/tools.ts:145-155`、`memory-base/src/knowledge.ts:109` | `fuzzy` 写「叠加 trigram 子串召回」，`mode=hybrid` 写「多路召回 + RRF」；实现注释明确「hybrid 下 trigram 恒开、fuzzy 不再改变召回」。两个参数同时出现时，模型会误以为 `fuzzy` 仍有额外效果。 |
| D11 | 工具级漏能力 | `rule-engine/src/tools.ts:159-162`、`:61-66` | `rule_add` 工具级只列了 `tool-call` / `tool-result` / `assistant-text` / `turn-end` / `compaction` 五个匹配面；参数级 `source` 还支持 `user-message` / `turn-start` / `step-start` / `step-end` / `session-start`。只读工具级描述的模型会漏掉一半时机。 |
| D12 | 措辞导致检索失真 | `fs-digest/src/main.ts:210`、`ast-tools/src/tools.ts:383`、`tool-consult/src/matcher.ts:159` | `fs_digest` 写「只读，不改文件」，`ast_replace` 写「默认 dry-run…不改文件」，两处都含完整短语「改文件」；matcher 对描述包含查询短语额外加 4 分。检索「改文件」top-1 是 `fs_digest`（10.21），`ast_replace` 第二（9.63），真正的 `edit` 第三（8.49）。这是否定句造成的典型假阳性。 |

另有 2 个较轻的候选，未进入正式 12 例：`hash_read` 工具级写「读取文件的行内容」，实际缺省只读 200 行（`hash-edit/src/main.ts:298`、`:304-305`）；`goal_contract_draft` 工具级没提 `max_goal_rounds` 与 `clauses_text`（`goal-contract/src/tool.ts:56-63`、`:137-147`），但参数级已写清。

### 4. `tool-consult` 依赖

匹配链路（从宿主 schema 到模型看到的文本）：

1. `main.ts` 用 `tools.schemas()` 拉当前工具面，投影成 `{name, description, parameters}`，再交给 `createMatcher`（`tool-consult/src/main.ts:181-192`）。
2. `indexDoc` 只索五个字段：名称 6、名称前缀 3、别名 4、工具级描述 2、参数键名 1；**参数级描述不参与索引**（`tool-consult/src/matcher.ts:49-55`、`:78-89`）。因此「清理参数描述」改善的是模型可读性，不会改善 BM25 命中。
3. BM25 参数 `K1 = 1.2`、`B = 0.75`；文档长度是加权词频之和，描述越长，长度归一化惩罚越大（`tool-consult/src/matcher.ts:58-59`、`:90-92`、`:150-152`）。
4. 短语加成：名称精确 +20、名称包含 +10、描述包含 +4（`tool-consult/src/matcher.ts:155-159`）。这解释了否定句假阳性与交叉引用污染。
5. 命中结果用 `oneLine` 截断：取首个句号 / 问号 / 感叹号之前，最多 80 字符（`tool-consult/src/matcher.ts:96-101`），用于咨询回执的每一行（`tool-consult/src/tool.ts:116`、`:130`、`:218`、`:248`）。46 个工具中有 **16 个** 的首句预览会在 80 字符处被截断，选择依据常常落在截断之后。

别名表现状：`aliases.ts` 共 44 个键 / 116 条别名；其中 11 个键是宿主工具，33 个键覆盖本仓工具。按 46 个本仓工具计算，**12 个工具没有别名**（`ast_query` / `ast_replace` / `rule_remove` / `rule_test` / `preference_list` / `preference_add` / `preference_remove` / `coagent` / `tui_local_log` / `channel_task_result` / `hash_read` / `hash_edit`；`consult_tools` 刻意不入索引，不计入这 12 个）。唯一重复别名是「任务状态」，同时挂给 `task_status` 与 `channel_task`（`tool-consult/src/aliases.ts:20`、`:25`）；另有「通知」（`session_channel`，`:23`）与 `notice_history`、「终端」（`bash`，`:9`）与 herdr 终端族两组软冲突。

检索模拟（57 条文档 = 46 个本仓工具 + 11 个宿主核心工具；本仓工具用真实工具级描述，宿主工具用安装树描述 / 首段摘要，别名表为真实 `ALIASES`；分数只用于同一次模拟内的相对排序）：

| 查询 | top-3（分数） | 观察 |
| --- | --- | --- |
| 任务状态 | `channel_task` 10.85 > `task_status` 9.76 > `channel_delegate` 4.51 | 重复别名把 `channel_task` 顶到第一。 |
| 停止任务 | `task_stop` 15.68 > `metric_loop` 5.08 > `channel_task` 3.00 | `task_stop` 是验收，不是取消；取消语义没有进入前列。 |
| 改文件 | `fs_digest` 10.21 > `ast_replace` 9.63 > `edit` 8.49 | 否定句「不改文件」造成假阳性，`edit` 掉到第三。 |
| markdown 结构 | `md_map` 10.66 > `fs_digest` 7.09 > `md_logic` 6.82 | `md_logic` 有精确别名「markdown 结构」，仍因描述过长被长度归一化压到第三。 |
| 谁引用了这个符号 | `ast_query` 12.99 > `md_map` 9.92 > `code_map` 8.03 | `ast_query` 的交叉引用句「谁引用了某符号用 code_map」反而让它自己排第一。 |
| 执行终端命令 | `bash` 10.27 > `herdr_create` 6.21 > `herdr_run` 6.03 | `bash` 的别名「执行命令」压过 `herdr_run`；`herdr_run` 缺少「终端命令 / 终端执行」类别名。 |
| 查找引用 | `grep` 5.97 > `md_map` 3.95 > `fs_digest` 3.58 | `code_map` 未进前三；它缺少「查找引用 / 查引用」类别名。 |
| 发通知 | `notice_history` 5.12 > `session_channel` 4.87 | `session_channel` 的「通知」别名与 `notice_history` 名称冲突，同分时按名称字典序后者胜。 |
| 读取终端输出 | `herdr_wait` 11.54 > `herdr_read` 8.09 > `read` 4.94 | 「输出」把等待工具顶上来；`herdr_read` 未写「当前屏幕 / 不是等输出」。 |
| 命令历史 | `notice_history` 5.61 > `task_status` 3.75 > `herdr_run` 3.56 | `tui_local_log` 没有「命令历史 / 本地日志」别名，未进前三。 |
| 跨会话委托 | `channel_delegate` 10.65 > `channel_task` 10.34 > `session_channel` 6.13 | 正向例子：`channel_delegate` 的描述与别名足够明确。 |
| 定时任务 | `daemon_task` 14.89 > `channel_task` 3.00 > `task_implement` 2.91 | 正向例子。 |
| 查看上下文用量 | `context_report` 20.94 > `tui_local_log` 6.12 > `fs_digest` 5.70 | 正向例子。 |

由此得到 6 条对写描述的直接约束：

1. **首句决定检索与预览**：既影响 `oneLine` 的 80 字符预览，也贡献 BM25 词频；首句应只写「做什么 + 何时选本工具」，不要先列全部 action。
2. **长描述会稀释关键词**：`md_logic` 有精确别名仍输给 `md_map`，说明 855 字符的描述把长度归一化拉高；工具级描述需要上限。
3. **否定句会制造假阳性**：「不改文件」「无需…」这类短语包含目标动作词，会被短语加成命中；应改成「只读」等正面表述。
4. **交叉引用会污染检索**：写「X 用 Y」会把 Y 的关键词加进 X 的文档；指路句应短、放在后部，并给 Y 补足别名，让 Y 在同查询上胜出。
5. **别名是仅次于名称的杠杆**：别名权重 4，描述权重 2；但别名也计入文档长度，不能靠堆别名解决长描述问题。
6. **参数描述不参与检索**：参数键名参与，参数描述不参与；检索问题优先改工具级描述与 `aliases.ts`，参数级描述按可读性单独处理。

### 5. 既有检查手段与缺口

现状：

- `npm run check` 只做 TypeScript 类型检查；`format` 只做 prettier 格式化；两者都不检查描述内容。
- 没有 ESLint / 自定义 lint 规则检查工具描述。
- 有 17 条分散在各包测试里的描述相关断言，覆盖 10 个文件：`agent-group/tests/main.test.ts:507-508`、`ast-tools/tests/tool.test.ts:231-234`、`memory-base/tests/tools.test.ts:81-82`、`preference-analysis/tests/tools.test.ts:76`、`script-interpreter/tests/index.test.ts:181`、`script-interpreter/tests/tool.test.ts:121-122`、`TUI/tests/local-log.test.ts:281`、`TUI/tests/notice-history.test.ts:416`、`goal-contract/tests/tool.test.ts:315-316`、`hash-edit/tests/tool.test.ts:67`。这些断言只查「某个词在不在」，不查跨工具选择、不查首句长度、不查交叉引用是否存在。
- `tool-consult` 的检索测试用的是合成夹具：`tool-consult/tests/matcher.test.ts:6-19` 只有 5 条手写文档；`tool-consult/tests/main.test.ts:7-31` 是 15 个 `${name} 工具：用于 ${name} 场景。` 的假描述。没有任何测试导入真实工具描述或真实别名表做回归。
- `security-guard/scripts/tool-surface-check.mjs` 扫的是工具参数键（路径 / 命令 / 代码键）与 security-guard 登记表的差异（`:3-15`、`:28-45`），不审描述文本。
- `docs/ARCHITECTURE-REUSE.md:59`、`:70` 定义了 `edit` / `hash_edit`、`code_map` / `md_logic` / `md_map` 的边界，但只是文档约定，没有测试强制；描述是模型唯一可见的契约。

缺口：

- G1 无「描述与实现 / 参数一致性」检查；D1 / D2 / D10 / D11 都属此类。
- G2 无首句长度 / 预览截断检查；16 / 46 当前会被截断。
- G3 无交叉引用存在性检查；D5 指向不存在的 `schedule_create` 未被发现。
- G4 无别名覆盖 / 重复 / 冲突检查；12 个工具无别名，「任务状态」重复。
- G5 无真实描述检索回归；重复别名、否定句假阳性、长描述稀释都只能靠人工发现。
- G6 无宿主工具名快照；宿主升级或 profile 组合变化时，描述里的宿主工具名会静默过时。
- G7 无术语表；包名 / 工具名 / 「官方」「宿主」混用（D8）。

## 决策

> 2026-10-24 用户确认: 以下 6 项决策按推荐选项定稿 (c / b / c / d / c / b), 实现阶段照此执行, 不再变更; 计划改动文件清单在开工时定稿。

### 决策 1：审阅范围

- a) 只审七组重叠对涉及的工具（约 18 个）。
- b) 只审工具级描述，参数级不动。
- c) 全部 46 个工具的工具级描述 + 197 个参数的描述，全量收口。
- d) 只审 `tool-consult` 常驻的 9 个核心工具。

选定：**c**。理由：总量约 1.6 万字符，三批可完成；只审重叠对会漏掉 D1 / D9 / D10 这类「单个工具内部」的失真；参数级描述是 tier / fuzzy 这类误用的直接来源。全量审阅不等于一次性改完，分批见决策 6。

### 决策 2：优先级排序

- a) 按包名字典序。
- b) 按「检索影响与失真严重度」排三档：P0 覆盖七组重叠对与会改变 top-1 或指错工具的失真；P1 是其余已证实失真、检索高频但只缺选择依据 / 术语的工具；P2 是低频或内部工具。
- c) 按 git 提交时间，最近改过的先审。
- d) 按工具级描述长度，最长的先审。

选定：**b**。理由：已有证据（检索模拟与 12 例失真）能直接排出风险；P0 先修会改变 top-1、指向不存在工具、或写错路径基准的问题，收益最高；其余失真按 P1 处理。三档清单：

- P0（20）：`task_decompose` `task_implement` `task_execute` `task_stop` `task_status`；`session_channel` `channel_delegate` `channel_task` `channel_task_result`；`hash_read` `hash_edit`；`md_logic`；`md_map`；`fs_digest`；`metric_loop`；`herdr_run` `herdr_read` `herdr_text` `herdr_key`；`ast_replace`（只修 D12 的否定句，避免 P0 检索回归仍被它压住）。
- P1（18）：`herdr_list` `herdr_info` `herdr_wait` `herdr_create` `herdr_close` `herdr_label`；`ast_query`；`code_map`；`memory_query`；`rule_add` `rule_list` `rule_update` `rule_remove` `rule_test`；`daemon_task`；`goal_contract_draft`；`coagent`；`agent_group`。
- P2（8）：`context_report`；`preference_list` `preference_add` `preference_remove`；`script_run`；`notice_history` `tui_local_log`；`consult_tools`。

### 决策 3：判定标准

- a) 只查事实一致性（描述与实现 / 参数一致）。
- b) a + 选择依据（重叠工具写明何时选谁）+ 首句可读性。
- c) b + 术语统一 + 参数语义完整 + 检索措辞约束。
- d) c + 机械回归断言。

选定：**c**。机械回归单独作为决策 5，不混进判定标准。逐条清单（实现阶段逐项勾选）：

- [ ] C1 工具级首句不超过 80 字符，首句说清「做什么 + 何时选本工具」。
- [ ] C2 与重叠工具写明选择依据；只写重叠对，不写无关工具；用精确注册名。
- [ ] C3 `action` / `enum` / 默认值 / 拒绝语义与实现一致；不写实现不支持的组合。
- [ ] C4 参数描述含用途、取值、缺省、互斥 / 依赖；必填参数与可选参数不混写。
- [ ] C5 不把当前 profile / 宿主安装假设写成事实；改用条件句（「LSP 可用时…」）。
- [ ] C6 交叉引用只用注册名（下划线），不用包名、「官方」「宿主」等代称；首次出现给全名。
- [ ] C7 术语统一：宿主工具用英文名（`read` / `edit` / `glob` / `grep`），本仓工具用注册名，同一概念只用一个词。
- [ ] C8 否定句不含目标动作的完整短语；用「只读」「不写盘」等正面表述替代「不改文件」。
- [ ] C9 工具级描述上限 400 字符；需要写选择依据的工具目标 120 至 300 字符，短工具可低于 120；超过 400 需在追踪文档写明理由；细节后置，不塞进首句。
- [ ] C10 参数描述不重复工具级已写清的内容，只补工具级没有的取值 / 边界 / 默认值。
- [ ] C11 `aliases.ts` 覆盖该工具且无重复；高价值口语词进表，不用单字泛词。
- [ ] C12 描述提到的工具名在当前 profile 或本仓存在；不存在时改条件句或删掉。
- [ ] C13 变更后跑 `check` + `build` + `test`，并人工看一次 `consult_tools` 预览与命中排序。

### 决策 4：是否改 `aliases.ts`

- a) 不改；只改描述。
- b) 只补缺失别名。
- c) 只修冲突别名（「任务状态」「通知」「终端」）。
- d) 补缺失 + 修冲突 + 加别名数据断言。

选定：**d**。理由：别名权重 4，是仅次于名称的检索杠杆；当前 12 个工具完全没有别名，3 组硬 / 软冲突中已有 2 组改变 top-1（「任务状态」「发通知」）。只补不修会把冲突放大，只修不补则 `hash_edit` / `code_map` 这类工具仍检索不到。具体口径：

- 修冲突：`channel_task` 去掉「任务状态」，改「委托状态 / 委托任务 / 委托列表」；`task_status` 保留「任务状态 / 任务树查看」。`session_channel` 的「通知」改「跨会话通知」或删。`bash` 的「终端」改「终端命令」或删；`herdr_run` 增「终端命令 / 终端执行」。
- 补缺失（12 个）：`hash_read` `hash_edit` `ast_query` `ast_replace` `coagent` `channel_task_result` `preference_list` `preference_add` `preference_remove` `tui_local_log` `rule_remove` `rule_test`；`code_map` 增「查找引用 / 符号引用」，`md_logic` 保留「markdown 结构」并增「按节改写」。
- 约束：每条别名全局唯一，且不得等于另一个工具名；不用「通知」「终端」「日志」这类单字 / 双字泛词；新增别名后必须过决策 5 的检索回归。

### 决策 5：是否加机械回归断言

- a) 不加，只靠人工审阅。
- b) 只在 `tool-consult` 加别名数据断言（覆盖 / 重复 / 冲突）。
- c) b + 重叠对检索回归（fixture + top-1 / top-3 断言）+ P0 关键描述关键词断言（按包补在现有工具测试）。
- d) c + 全仓描述 lint（首句长度 / 交叉引用存在 / 参数非空）。

选定：**c**。理由：检索回归能直接覆盖已发现的 6 类排序错误（重复别名、否定句、长描述、交叉引用污染、别名缺失、泛词冲突）；按包的关键词断言直接盯住源码里的真实描述，防止改回旧措辞；两者成本都可控。全仓 lint 需要解析各包 TS 描述字符串，误报与维护成本高，先不放进本轮，另开条目。具体：

- `tool-consult/tests/aliases.test.ts`：维护 46 个工具名清单；断言除 `consult_tools` 外每个工具至少 1 条别名；断言无重复别名；断言别名不等于另一个工具名；对「任务状态 / 通知 / 终端」三例加显式断言，防止再出现跨工具冲突。
- `tool-consult/tests/retrieval.test.ts`：fixture 放七组重叠对的「目标措辞」短描述（不是完整源码副本），复现否定句、长描述、交叉引用污染等失败模式；查询至少覆盖 §4 表中的 12 条；断言「期望工具在 top-3」，其中 6 条关键查询断言 top-1（任务状态、改文件、markdown 结构、谁引用了这个符号、执行终端命令、查找引用）；不写死分数。它守的是 matcher + aliases + 措辞模式，不冒充源码快照。
- 源码级关键词断言按批次落地，文件用各包现有 `tests/tool.test.ts`（或同等文件）：P0 覆盖 D1 别名、D2 root 默认、D3 `edit` / `md_logic` 指路、D4 `model` / `task_execute`、D5 不含 `schedule_create`、D6 `bash` 分工、D8 用注册名不用「官方 edit」、D12 不含「不改文件」；P1 覆盖 D7 `grep` / `glob` 分工、D9 S/P/U、D10 hybrid 覆盖 fuzzy、D11 source 全集。
- 顺序：先补源码级关键词断言，确认当前源码下为红；再改描述与别名；最后跑检索 fixture 与全量 `check` + `build` + `test`。检索 fixture 是目标态测试，不做「先红后绿」，避免为了红而复制旧描述。
- 已知限制：检索 fixture 是短描述，不是完整源码副本；源码级事实由各包断言守，跨工具排序由 fixture 守，两者不能互相替代。

### 决策 6：分批还是一次性、拆分粒度

- a) 一次性改完 46 个工具，一次提交。
- b) 按决策 2 的 P0 / P1 / P2 三批，每批独立 `check` + `build` + `test` + 人工确认 + 提交。
- c) 每 5 个工具一批，约 10 批。
- d) 每个包一批，约 21 批。

选定：**b**。理由：P0 的 20 个工具覆盖全部七组重叠对与会改变 top-1 的失真，一次改完才能整体验证检索排序；P1 处理其余失真与术语 / 参数语义；P2 是收口；三批各自可回滚，符合「一次提交一个逻辑改动」。每批内部顺序固定：先 `aliases.ts` 与工具级首句，再工具级细节，再参数级描述，最后测试与检索回归。P0 提交前必须人工看一次 `consult_tools` 的预览与 top-3。

## 规划

计划改动文件清单（草案，实现阶段定稿）：

P0：

- `task-engine/src/tools.ts`
- `session-channel/src/index.ts`
- `hash-edit/src/main.ts`
- `md-logic/src/tools.ts`
- `md-map/src/tools.ts`
- `fs-digest/src/main.ts`
- `metric-loop/src/index.ts`
- `herdr-use/src/tools.ts`
- `ast-tools/src/tools.ts`（仅 `ast_replace` 的 D12 措辞）
- `tool-consult/src/aliases.ts`
- `tool-consult/tests/aliases.test.ts`（新增）
- `tool-consult/tests/retrieval.test.ts`（新增）

P1：

- `herdr-use/src/tools.ts`（剩余 6 个工具）
- `ast-tools/src/tools.ts`（`ast_query` 等）
- `code-map/src/index.ts`
- `memory-base/src/tools.ts`
- `rule-engine/src/tools.ts`
- `background-daemon/src/tools.ts`
- `goal-contract/src/tool.ts`
- `coagent/src/tools.ts`
- `agent-group/src/main.ts`
- `tool-consult/tests/retrieval.test.ts`（扩 fixture 与查询）

P2：

- `context-report/src/main.ts`
- `preference-analysis/src/tools.ts`
- `script-interpreter/src/tools.ts`
- `TUI/src/app/adapter/notice-history-tool.ts`
- `TUI/src/app/adapter/local-log-tool.ts`
- `tool-consult/src/tool.ts`
- `tool-consult/tests/retrieval.test.ts`（收口）

文档：

- 仅当边界口径变化时更新 `docs/ARCHITECTURE-REUSE.md` 与相关包 `README.md`；描述本体以源码为准。
- 本任务的过程记录只写本文件；不新增其他追踪文档。

明确不做：

- 本轮不实现任何改动；不动 `tool-consult` 的匹配算法 / 权重 / `oneLine` 上限（先用描述与别名修排序；若 P0 后仍不达标，另开条目评估 matcher）。
- 不改宿主官方工具（`bash` / `read` / `write` / `edit` / `glob` / `grep` 等）的描述。
- 不改任何工具的 `name` / 参数 schema / 执行行为；只改 `description` 与 `aliases.ts`，外加测试。
- 不合并或删除工具；`task_stop` 不改名（改名会破坏兼容，优先在描述里写清「不是取消」）。
- D2 只改描述对齐现有 `md_map` 的 `process.cwd()` 默认；若要把实现改成会话 cwd，属行为变更，另开条目。
- 不审 TUI slash 命令描述（`TUI/src/app/commands.ts`）与 `command-template` 模板描述，它们不在模型工具面。

## 实现记录

分三批落地（顺序：P0 → P1 → P2，每批独立验证）。

### P0（20 个工具）

- 改动 21 个文件（19 改 2 新增）：`task-engine/src/tools.ts`、`session-channel/src/index.ts`、`hash-edit/src/main.ts`、`md-logic/src/tools.ts`、`md-map/src/tools.ts`、`fs-digest/src/main.ts`、`metric-loop/src/index.ts`、`herdr-use/src/tools.ts`、`ast-tools/src/tools.ts`、`tool-consult/src/aliases.ts` + 9 个既有测试 + 新增 `tool-consult/tests/aliases.test.ts`、`tool-consult/tests/retrieval.test.ts`。
- D 落点：D1 `session-channel/src/index.ts:1534`（`to` 补别名）；D2 `md-map/src/tools.ts:101`（`root` 缺省 = 会话 cwd，取不到回落进程 cwd）；D3 `hash-edit/src/main.ts:327`（指 `edit` / `md_logic`）；D4 `task-engine/src/tools.ts:344`（`model` 后端 / 缺省叶子）；D5 `metric-loop/src/index.ts:560`（改指 `daemon_task`，删 `schedule_create`）；D6 `herdr-use/src/tools.ts:450`（`bash` 分工）；D8 `md-logic/src/tools.ts:182`（去「官方」）；D12 `ast-tools/src/tools.ts:383` 与 `fs-digest/src/main.ts:206`（去否定句）。
- aliases：修 4 组冲突（「任务状态」归 `task_status`、「通知」归 `notice_history`、「终端」归 `herdr_run`），补 12 个缺失工具的别名，另加 `code_map`「查找引用」与 `md_logic`「按节改写」。

### P1（18 个工具）

- `herdr-use/src/tools.ts:268-415`（剩余 6 个 herdr 工具）；`ast-tools/src/tools.ts:180`（D7：`grep` 与 `glob` 分工，删「glob 搜正文」）；`code-map/src/index.ts:338`；`memory-base/src/tools.ts:106`（D10：`fuzzy` 与 `mode=hybrid` 对齐实现）；`rule-engine/src/tools.ts:159`（D11：匹配面补全到 10 个 session 节点）；`background-daemon/src/tools.ts:110`（D9：`S` / `P` / `U` 各自落点）；`goal-contract/src/tool.ts:65`（补 `clauses_text` / `max_goal_rounds`）；`coagent/src/tools.ts` 与 `agent-group/src/main.ts`（去代称、用注册名）。

### P2（8 个工具）

- `context-report/src/main.ts:511`；`preference-analysis/src/tools.ts:77`；`script-interpreter/src/tools.ts:472`（与 `bash` 分工）；`TUI/src/app/adapter/notice-history-tool.ts:99` 与 `TUI/src/app/adapter/local-log-tool.ts:104`（互指边界）；`tool-consult/src/tool.ts:152`（咨询即授权 + 揭示只增不减）。

### 测试

- 新增 `tool-consult/tests/aliases.test.ts`（6 例：46 工具清单、至少 1 条别名、全局唯一、别名不等于工具名、三组冲突显式断言）。
- 新增 `tool-consult/tests/retrieval.test.ts`：七组重叠对 + 12 条查询 fixture，按「必须 top-1 / 只要求 top-3」两档断言；P1/P2 又补 8 条（终端列表 / 终端读取 / 规则管理 / 规则测试 / 定时任务 / 契约 / 偏好 / 上下文用量 / 命令历史）。
- 各包既有 `tests/tool.test.ts` 补源码关键词断言，覆盖 D1 至 D12。

## 偏差

- 决策 3 明确「保留现状」的四项未改：`bash` 零参数、`channel_task_result` 两分支、`hash_read` 缺省 200 行、`memory_query` 的 `topK` 缺省。
- 工具级长度目标（120 至 300）为软约束：`md_logic` 330 字符、`coagent` 353 字符略超，均 \<400 上限。
- 参数级描述只按失真项与 P2 收口修改，未逐条重写。

## 测试与证据

- 根 `npm run check` → 全包通过（三批完成后各跑一次）。
- P0：10 个受影响包 746 项全绿；tool-consult 67/67。
- P1 + P2：14 个受影响包 1101 项全绿；tool-consult 74/74（新增 8 条检索断言）。
- C1 / C9 自查：46 个工具首句 ≤80 字符，工具级最长 `coagent` 353 字符，无 >400 项。
- 真机验证与人工预览确认见「收尾」。

## 收尾

已关闭（2026-10-25）。提交：`e10371d`（46 个工具描述 + 别名表 + 回归测试）、`30fe04f`（真机验证发现的一处排序回归）。

真机验证（会话已装载新构建，`consult_tools` 以 `reveal: false` 只预览不揭示，12 条查询）：

- `任务状态` → `task_status` 首位（`channel_task` 退到第二，重复别名已修）。
- `改文件` → `hash_edit` / `edit` 前列（`fs_digest` / `ast_replace` 不再抢先，否定句假阳性消除）。
- `查找引用` → `code_map`；`谁引用了这个符号` → `code_map`。
- `markdown 结构` → `md_logic`；`执行终端命令` → `herdr_run`（`bash` 退到第三）。
- `读取终端输出` → `herdr_read`；`命令历史` → `tui_local_log`。
- `定时任务` → `daemon_task`；`上下文用量` → `context_report`；`发通知` → `session_channel`；`停止任务` → `task_stop`。
- 发现 1 处回归：`跨会话委托` 的 top-1 变成 `task_stop`（其描述含完整短语「取消跨会话委托任务」，属交叉引用污染）。已在 `30fe04f` 改措辞、给 `channel_delegate` 补别名、补源码断言并把该查询升为 top-1 断言。
- 修复后的排序需重启会话再确认一次：当前进程仍装载修复前的描述（dist 已重建，内存未换）。

命名：归档后本文件为 `docs/archived/2026-10-24-tool-description-review.md`。
