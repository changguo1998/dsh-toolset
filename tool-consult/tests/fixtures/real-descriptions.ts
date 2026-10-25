/**
 * fixtures/real-descriptions.ts — 真实措辞守护语料（决策 5, 见
 * docs/archived/2026-10-25-tool-consult-matcher-review.md）。
 *
 * 来历: 2026-10-25 从各包源码逐字提取 44 个工具的工具级 description（不含
 * 参数名; 参数键名权重 1, 不影响本语料要守的加成 / 长度参数）。此前
 * `tests/retrieval.test.ts` 用的是手写「目标措辞」, 与源码漂移（如「改文件」
 * 断言 edit top-1, 源码里 hash_edit 的描述含「按 LINE:HASH 锚点改文件」）, 守
 * 的是假想措辞。本文件让守护测试反映源码现状。
 *
 * 维护: 工具描述改动后同步本文件（描述层改动归 lint 任务）。脚本化提取:
 * 按 `name: "<工具名>", description:` 取源码里的字符串拼接 / 模板 / 数组
 * join; task-engine 的 `decompose("<动作>", ...)`、herdr-use 的
 * `makeTool(deps, "<动作>", ...)` 与 `TOOL_NAME` 形态各自按工厂调用点取。
 * 本文件只读展示, 不被插件运行时加载。
 */

import type { ToolDoc } from "../../src/matcher.ts";

/** 本仓 44 个工具的真实描述（逐字, 未改写）。 */
export const REAL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  agent_group:
    "同事模型群组的编排（跨会话协调层）：建组、加成员、建主从或平等连接、派指令、结算。create_group 建组（管理者 = 调用方会话）；add_member 加成员（name / target，target = 会话 id 或别名，须在线）；link 建主从连接（从方须是自由代理，等级 = 主方 + 1）；link_peer 建平等连接（双向、无等级）；send 发指令（每条主从连接同时只允许一条未结）；send_peer 经平等连接发消息；broadcast 按成员逐条发送并汇总；check 懒判定结算；remove 移除成员（非叶子被拒）；close_group 关闭组；status 只读查看。派任务给单个会话用 channel_delegate；拉起常驻会话用 coagent。拒绝都带原因与下一步。",
  ast_query:
    "语法级查询（ast-grep）——按 AST 结构找代码，字符串与注释里的同名文本不算命中。action=search 按模式匹配（$VAR 单节点、$$$VAR 序列元变量）；action=outline 出文件语法骨架（类 / 函数 / 方法 / 导入）；action=rules 跑 YAML 规则（可内联或用规则文件）。要「所有 foo( 调用点」「某语法形态」「按结构批量定位」时用 search；按文本 / 正则找内容用 grep（会匹配字符串与注释，更快）；按路径模式找文件用 glob。某文件有哪些符号 / 结构快览用 fs_digest；谁引用了某符号、改动影响面用 code_map。输出行号 1 基（与 read / grep 一致）。改代码用 ast_replace（默认 dry-run）。",
  ast_replace:
    "语法级结构化替换（ast-grep fix 语义）：按 AST 模式匹配并把命中替换为 replacement（可引用 $VAR）。**默认 dry-run**：只返回预览与命中，文件保持原样；确认无误后再用 write:true 写回。写回是**整文件重写、无读后改前版本守卫**（直接 node:fs 写），写前请自行确认文件未被并发修改。单点精确改写优先用 hash_edit（LINE:HASH 行级锚点 + 漂移检测 + 整批原子拒绝）；按语法形态批量改同一写法才用本工具。",
  channel_delegate:
    "把一个任务委托给本机另一个会话执行并回收结果（planner-worker 语义）。任务正文作为一条 [CHANNEL] 消息注入目标会话的下一回合；worker 本轮结束时会自动回传最终回答（worker 也可调用 channel_task_result 显式回传，显式优先）。返回 task_id，用 channel_task 查状态 / 列任务 / 取消。只传话不委托执行用 session_channel（action=send）；在当前会话拉起常驻同事用 coagent。",
  channel_task:
    "委托任务管理（channel_delegate 建的任务）：查委托状态、列委托任务、取消委托。action=status 查单个任务（taskId）；action=list 列任务（sessionId 缺省=调用方会话；可选 status / limit）；action=cancel 取消任务（taskId）。记录在 Redis 任务表（`task:<id>`，TTL 7 天），跨会话 / 跨进程共见；嵌套任务树查 task_status。",
  channel_task_result:
    "回传委托任务的结果（worker 侧，任务由 channel_delegate 建立）。显式回传优先于轮末自动回收；taskId 取自注入正文的 `TASK <id>:`；text 为结果正文（≤ 64 KB，超出截断并标注）；failed=true 时标记失败（可带 error）。",
  coagent:
    "用途: 拉起/收尾独立进程的长驻 dsh 会话(上下文零继承), 只管起停不派任务。\n用法: spawn 在 herdr 终端里前台发 fffdsh、轮询 peers 认领新会话(回执 terminal_id / session_id); list 列本会话记录并按需探测终端与会话是否还在; close 发 /quit 等进程退出后关终端, 失败可 force。\n效果: 新会话经 peers 认领并回执 terminal_id / session_id; close 会退出进程并关终端。\n边界: 只接受 cwd / label / claimTimeoutSec, 不接受 task / text / target。\n相关: channel_delegate、agent_group、herdr_read、herdr_text、herdr_key。",
  code_map:
    "代码结构与引用地图：建符号表与 import 图，回答谁引用了某符号、改动波及哪些模块。index / refresh 建索引；callers 查符号引用（LSP 可用时 precision=lsp，否则回落同名候选 structural）；callees 查文件级 import 目标；impact 查改动某文件的影响面（反向 import 闭包）；cycles 查依赖环；report 出项目报告；summary 查索引状态。callers / callees / impact / report 会隐式建索引，cycles 不会（未索引返回 not_indexed）。按路径模式找文件用 glob；按文本检索用 grep。root 缺省取进程 cwd（process.cwd()）。",
  context_report:
    "查看当前或指定会话的上下文用量报告：token 分桶、上下文占用比例、回合与工具耗时。action=report（缺省）渲染报告，可配 detail=summary / standard / full；action=state 出投影原始状态；action=list 列会话。report 含回合 / 步数、token 分桶（未缓存输入 / 缓存读 / 缓存写 / 输出，reasoning 为子集）、上下文占用（请求压力 / 模型容量）、模型与工具墙钟、首 token 与解码速率。",
  daemon_task:
    "面向会话投递的进程内定时调度：按选择器到点向目标会话投递提示文本或执行 slash 命令。create 新建, list 列表, show 详情, pause / resume 暂停恢复, run 立即投递一次, cancel 删除, log 运行流水。守护默认关闭, 需先 /daemon start 开启; 选择器支持 after_seconds / at / every_seconds（≥60 s）/ daily / weekly（无 cron）。投递只面向本进程已注册的活跃 agent：目标会话无活跃 agent 时记 skipped, 不重试。指标循环的到点唤醒用 metric_loop 的提示参数配合本工具。",
  fs_digest:
    "上下文感知文件读取（只读，省 token 的结构概览）：出大纲 / 签名 / 裁剪，不改内容，改内容用 edit。mode=outline 出章节 / 符号大纲（Markdown 额外给每节行范围与块结构清单——列表 / 表格 / 代码块 / 引用，便于按节读而不是整篇读）；signatures 出函数 / 方法签名；pruned 裁大文件头尾。Markdown 深查（链接 / 引用式定义 / 嵌套层数 / 表格维度）用 md_logic；全文检索用 grep。相对路径相对会话 cwd。",
  goal_contract_draft:
    "起草 goal 契约并落到 goal 事件源（goal/change），用于开工前把目标与 Done-when 条款定下来。 字段：objective（目标描述）、clauses 或 clauses_text（Done-when 条款，二选一）； clauses 的 schema 对齐 task-engine 的 Acceptance（id / check / level / command），mechanical 必须带 command。 objective 首行必须是一句话概括（≤40 显示列，约 20 个汉字）。 objective 与条款齐备时直接创建；缺任一则经 ask_user 逐题访谈（目标→条款→确认）。 max_goal_rounds 设 goal 回合上限（缺省取会话配置值）。 创建后回读 goal 视图并解析 Done-when 条款，返回往返比对结果（readback.match）。",
  hash_edit:
    "按 LINE:HASH 锚点改文件（set_line / replace_lines / insert_after / delete_line），精确改行。锚点都用同一次 hash_read 的内容校验，任一失效（stale）则整批拒绝、文件保持原样，返回失效锚点供重新读取。文件级字面量替换用 edit（带读后改前版本守卫）；按节改 Markdown 用 md_logic。",
  hash_read:
    "读取文件的行内容并返回 LINE:HASH 锚点（每行: 1 基行号:sha256 前 8 位 hex），是 hash_edit 的输入。缺省从第 1 行起读 200 行，更长文件用 offset / limit 分段读取。",
  herdr_close:
    "关闭整个终端（关掉它的 tab，并注销登记）；先 herdr_list 确认 terminal_id 再关。继承 lane 下调用者自己所在的 tab 会被拒。只接受本插件登记的 terminal_id。",
  herdr_create:
    "建一个终端（新 tab，自带 root pane；不抢焦点，自动打 label），后续命令用 herdr_run 提交。foreground 缺省 true：落在父会话所在 herdr session；设 false 则落在名为 dshbg 的后台 session，该终端之后的所有命令自动带 --session dshbg。新终端的工作目录缺省取会话工作目录。",
  herdr_info:
    "终端进程探活：返回 running / shell_pid / foreground_processes，判断命令是否还在跑。只判存活与前台进程，不取屏；要屏内容用 herdr_read。只接受本插件登记的 terminal_id。",
  herdr_key:
    '发送按键序列（如 ["ctrl+c"] / ["esc"] / ["up"] / ["enter"]），用于中断程序、翻页、确认提示框。组合键与单键都走这里；注入字面量文本（输入文本）用 herdr_text。只接受本插件登记的 terminal_id。',
  herdr_label:
    "同时改终端标题（tab 标题）与归属标记（root pane label），label 必须非空；用于标记终端用途、便于 herdr_list 辨认。只接受本插件登记的 terminal_id。",
  herdr_list:
    "列本会话创建的终端（前台 + 后台 dshbg 两处），逐条标 foreground / registered / focused / pane_count。先看有哪些终端再决定读或写哪一个；terminal_id 取自 herdr_create 回执。registered: false 的是残留终端，需人工在 herdr 里关闭。",
  herdr_read:
    "取终端当前屏幕内容，即读屏 / 看屏（走 socket，回执带 revision / truncated）。读文件用 read；要等程序输出、判稳再取用 herdr_wait。缺省 source=recent-unwrapped、lines=120、剥 ANSI；TUI 类程序用 visible。只接受本插件登记的 terminal_id。",
  herdr_run:
    "向已创建的 herdr 终端提交命令（文本 + 回车一次完成），复用该终端的会话状态。一次性命令用 bash；要在交互式程序里连跑命令、依赖终端当前目录 / shell 变量、或看屏幕时序时用本工具。只输入不回车用 herdr_text。这是终端命令的提交口，跑在 dsh 进程之外（不经文件沙箱），过 security-guard 复查。只接受本插件登记的 terminal_id。",
  herdr_text:
    "向终端注入字面量文本（不追加回车），用于回复提示或粘贴片段；要提交命令用 herdr_run。只接受本插件登记的 terminal_id。",
  herdr_wait:
    "等终端输出：match 字面量 / regex 正则 / stable 静默判稳，三选一互斥；要立即取当前屏用 herdr_read。match / regex 走 CLI wait-output，stable 走 socket 判稳；到点返回结构化超时结果而不抛错。只接受本插件登记的 terminal_id。",
  md_logic:
    "单文件 Markdown 逻辑结构（读 + 按节改写）：出节树 / 块 / 链接，或按节整节替换、删除。structure 给节树（层级 + 行范围 + 内容 hash），blocks 给块清单，links 给链接定义；只要标题 + 块快览用 fs_digest。replace 的 edits 带 heading + start_line / end_line（取自 structure）与 content（整节新文本，须以标题行开头）；section_hash 不符则 section_stale。改写分工：按节改 Markdown 用本工具；按行号改行用 hash_edit；整文件替换或改标题层级用 edit。行号 1 基；path 相对会话 cwd。",
  md_map:
    "Markdown 项目级引用图（文档之间，非全文检索）：建索引，查谁引用某文档 / 锚点、影响面、断链。index / refresh 建索引（默认扫会话工作目录下的 `**/*.md`）；callers 查引用来源（path + 可选 anchor + 可选 kind）；impact 查影响面（反向闭包，depth 缺省 2）；orphans 查孤儿；report / summary 出总览与索引状态。行号 1 基；path 相对 root。分工：代码结构用 code_map；单文件结构用 md_logic；全文检索用 grep。除 index / refresh 外都依赖先前建立的索引。",
  memory_query:
    "只读查询跨会话记忆库（跨全部已注册 kind，可按层 / 项目过滤）。action=search（缺省）全文检索，action=list 按 kind 列举；知道查什么用 search，要看某类都写了什么用 list。search 的 mode 选策略：缺省 bm25（单词面）；hybrid 多路召回 + RRF 融合，长句 / 多词查询更稳，此时 trigram 恒开，fuzzy 不再额外改变召回。结果多时用 kind / tier / project / limit 收窄（缺省 10 行，上限 100）。本工具只读，写入与删除走各扩展。查偏好用 preference_list。",
  metric_loop:
    "指标驱动自动循环：每轮跑测量命令取一个数字，按窗口与边界判定是否继续。start 新建并跑第一轮，tick 推进一轮（wake=auto 受 cadence 节流，explicit 紧急唤醒不受限），status 查状态，stop 手动停止。无测量命令时为 metricless（只按边界停止）。结果含唤醒提示：运行中按提示参数用 daemon_task 排下次自动唤醒。",
  notice_history:
    "读 notice 历史原文：已被 compaction 折叠出上下文、会话日志里仍在的一次性事件交代。这类事件含 subagent 收尾 / 后台任务 / 模型切换（source.form:'notice'），取回后按需读最近 N 条。kind=生产者类别（source.kind，如 tool-jobs / subagent-settled / model-selection；缺省不过滤）、limit 缺省 20（上限 200）、session_id 缺省当前调用方会话。本工具只读。TUI 命令提示与 $ 模式命令输出在 tui_local_log。",
  preference_add:
    "登记一条用户偏好建议，一律落候选待审（status = candidate），等用户审核后才生效并注入。仅在用户明确表达一条持久偏好（而不是一次性要求）时调用；正文写成用户可读的一句约束，保留用户原话，不要自己概括成抽象规则。要核对已有偏好用 preference_list。",
  preference_list:
    "列出偏好账簿条目（id / 正文 / 状态 / 证据数 / 跨会话数 / 重要度 / 最近证据时间）。用户问「现在有哪些偏好」或确认某条是否存在时用本工具；本工具只读，登记用 preference_add、撤销用 preference_remove。状态：observe（观察中）/ candidate（候选待审）/ active（生效并注入）/ dormant（休眠）/ retired（已退休）。",
  preference_remove:
    "撤销一条偏好（按 id），仅在用户当次明确要求撤销时调用。撤销后该模式记入抑制键，重放同一行为不会再被归纳出来；撤销前可用 preference_list 核对 id。",
  rule_add:
    "新增一条注入规则：命中条件（关键词 / 正则 / 内置谓词）成立时，代替用户向下一个回合注入一条 user-role 消息。source（匹配面，可挂多个）共 10 个会话节点：assistant-text / user-message / tool-call / tool-result / turn-start / turn-end / step-start / step-end / session-start / compaction；缺省 assistant-text。边界类节点（turn-* / step-* / session-start）文本为空，match 可省即无条件命中。id 已存在会报错，改用 rule_update。",
  rule_list:
    "只读列出生效规则（配置基线 + 运行时层，含来源层 origin、送达路径 delivery 与节流参数）与引擎状态。",
  rule_remove:
    "删除一条规则：运行时规则直接移除；配置基线规则记入运行时层的屏蔽列表（配置文件本身不改）。",
  rule_test:
    "用途: 干跑判定哪些规则会命中。\n效果: 只返回命中判定, 不注入、不改状态。\n边界: 供调试规则写法。",
  rule_update:
    "更新一条规则（浅合并 patch：只改 text / match / cooldownTurns 等；patch.text 与 patch.action.text 等价）。基线规则被更新后以运行时版本生效（原配置保持原样）；规则不存在时先用 rule_add。",
  session_channel:
    "跨会话消息通道（本机专用 Redis）：列会话、发消息、查收件箱、管别名。peers 列在线会话；send 发消息到目标会话；inbox 查某会话最近收到的消息（只读）；state 查某会话的 agent 忙闲（idle/running + 转换时刻 at，也可作为跨会话通知的派发通道）；alias 管会话别名（op=set/list/clear，name=别名，to 缺省为调用方所在会话）；status 查连接与已跟踪会话。发消息用本工具（action=send）；让另一个会话执行任务并回收结果用 channel_delegate。",
  task_decompose:
    '把一个待细化任务拆成子任务（每次只细化一层；机械+语义蕴含双门禁通过才挂树）。多轮：对**已完成的当前轮根**再分解会**自动开新一轮**（新根 `root-2` / `root-3…`，沿用同一根契约，旧轮只读保留；跨轮子帧 id 必须唯一）；`parent_id: "root"` 始终指当前轮根',
  task_execute:
    "发起叶子任务声明的 executor 后端（subagent / workflow / command），把执行证据回填到该帧。model 后端（本会话自己执行）用 task_implement；回填后仍需 task_stop 做 RET 验收。叶子须已挂树且声明了非 model 后端，否则拒绝。",
  task_implement:
    "完成一个叶子任务（写产出），仅限 model 后端（本会话自己执行）。声明了 subagent / workflow / command 后端的叶子用 task_execute 发起。叶子指 need_decompose=false 的帧，非叶子会被拒（先 task_decompose）；产出在 task_stop 验收通过后才算完成。",
  task_status:
    "查看本引擎的嵌套任务树（帧 / 轮次 / parent_id + order，先序，含 executorKind），跨会话委托任务查 channel_task。多轮会话返回**森林**：`rounds` = 已开启轮数（= 当前轮号），`tree` 每轮一棵（树根带 `round`）；只展开当前轮（末项），更早的轮折叠为根摘要（`children: []` + `descendantCount` + `truncated: true`），折叠后本工具不提供取回，细节在事件流里。",
  task_stop:
    "对任务执行 RET 验收（mechanical/human/semantic），通过则完成并向上 join，返回 accepted/next。凭 task_id 指定任务；本工具只做验收与完成，取消委托用 channel_task（action=cancel）。",
  tui_local_log:
    "读 TUI 本地输出旁路日志：$ 模式执行的命令与结果（含退出码）、TUI 命令的提示行（notice）。这些内容默认不进模型上下文；要核对命令历史或某条 TUI 提示时，用本工具按需取最近 N 条。kind=shell / notice / all（缺省），limit 缺省 20（上限 200），session_id 缺省当前会话。一次性事件交代（subagent 收尾 / 后台任务 / 模型切换）在 notice_history。",
};

/**
 * 8 条占位描述: 6 个宿主核心工具（描述在安装树里, 不属本仓）+ `script_run`
 * （描述由函数动态拼装）+ `consult_tools`（查询入口本身, 不入检索索引）。
 */
export const PLACEHOLDER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  bash: "Run a shell command.",
  consult_tools: "按用途查找并揭示工具，咨询即授权。",
  edit: "Literal string replacement in one file.",
  glob: "Find files by path pattern.",
  grep: "Search file contents with a regexp.",
  read: "Read a UTF-8 text file.",
  script_run: "执行一段脚本并返回 stdout / stderr；一条命令用 bash。",
  write: "Write a UTF-8 text file.",
};

/** 守护语料: 44 条真实 + 8 条占位 = 52 条工具文档。 */
export const CORPUS_DOCS: readonly ToolDoc[] = [
  ...Object.entries(REAL_DESCRIPTIONS),
  ...Object.entries(PLACEHOLDER_DESCRIPTIONS),
].map(([name, description]) => ({ name, description }));

/**
 * 生产检索索引: `consult_tools` 是查询入口本身, 由 `src/main.ts` 的
 * `buildMatcher` 过滤掉; 这里同样排除, 让守护测试与线上索引同口径。
 */
export const INDEXED_DOCS: readonly ToolDoc[] = CORPUS_DOCS.filter(
  (doc) => doc.name !== "consult_tools",
);
