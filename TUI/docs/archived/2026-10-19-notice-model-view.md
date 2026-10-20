# 允许模型查看 TUI 本地输出（notice / `$` 结果 / 命令提示；接取条目：TUI/docs/BACKLOG.md「允许模型查看 notice 信息」2026-10-19 扩展）

状态：关闭　　开启：2026-10-19　　关闭：2026-10-20
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让模型能够查看 TUI 展示给用户、但默认不进模型上下文的内容：宿主 notice（原始意图，见 BACKLOG）与 TUI 本地输出（`$` 模式的命令与结果、App 命令提示 notice）。先核实宿主 `form:'notice'` 消息在模型上下文与持久日志里的真实形态（结论：content 原文已进上下文与日志），再裁定 TUI 本地输出的通道（选：模型查询通道, TUI 包内自持数据面 + 工具 `tui_local_log`）；TUI 既有显示口径不变，读写一律 best-effort。

## 调研

（来源：官方源码与官方包 `@deepseek-ai/dsh@0.2.0-rc.2` / `dsh-llm@0.2.0-rc.2`（全局安装 `~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh`）、实测（本机持久日志解压核查）、既有文档 `TUI/docs/SPEC.md:158`）

1. **形态定义（`dsh-llm/lib/types/message.d.ts`）**：`ContextFormed` 的 notice 形态要求 `summary`（一行交代）；消息基类字段 `content` 注释为 "Exact model-facing blocks"。`CONTEXT_SUMMARY_MAX_CHARS = 120`，`boundContextSummary` 超长省略号截断。其注释原文：producers commit the one-line account to the durable log —— **summary 是展示契约，未声明 content 不落日志**。
2. **请求组装无 summary 替换点（全宿主源码检索）**：`dsh-llm/lib/index.js` 的 `adapterStream` 只对 messages 做文件 / 图片两类投影，`message.content` 原文透传进适配器；全宿主范围内读 `source.form === 'notice'` 或 `summary` 改写请求消息的消费点为零（全部命中均为生产方或持久化校验）。**结论：模型在请求里拿到 notice 的完整 `content` 原文**（以 user-role 消息进入会话历史，随后每轮请求携带，直到被压缩）。
3. **生产方（`source.kind`，代码核实，均 user-role 消息）**：`subagent-settled`（子代理收尾，content 可达数千字符）、`tool-jobs`（后台任务完成）、`model-selection`（模型切换）、`plan-mode`、`webhook`、`repeat-tool-reminder`、`tool-goal`；另有 typert 声明面（`dsh-commands` / `dsh-goal` / `dsh-user-questions` 等）出现 notice 形态声明，未逐一展开。
4. **持久日志实测**（`~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/tui-ac4bde29-*.zstd` 解压逐条核查）：`user/message` 与 `agent/inbox/spliced` 的 notice 消息均带完整 `content`（实测 content_len 179 / 1691 / 3423 / 3605 字符）+ `source.form:'notice'` + `summary`（≤120）。**原文全量落日志**；jsonl worker（`dsh-session-persistence-jsonl`）只校验 `form` / `summary` 字段，content 属消息本体一并持久化。「一行账目」不意味着原文不落日志。
5. **compaction 边界**：`dsh-compaction-basic` 按 `retainTokens` / `retainRatio` 原文保留近期尾段（"retaining a priced recent tail"），更早区间折叠为合成摘要 user 消息。notice 无特殊待遇——**被压出保留尾段的 notice 原文从上下文消失**，只剩摘要块转述（摘要未覆盖则上下文彻底不可见，日志仍有原文）。
6. **本仓事件面可得性（`TUI/src/app/adapter/`）**：实时 `user/message` / `agent/inbox/spliced` 事件的 notice 项自带完整 `content`（与日志同源）；现 `noticeSummaryOf`（`normalize.ts:60`）取 `summary`，缺失兜底正文首行截 120。恢复 `normalizeHistoryMessages`（`dsh.ts:309`）从会话事件读 notice 形态 → `HistoryMessage{role:'notice', text: summary}`，事件面同样带完整 content。即：**若任何通道将来需要 notice 原文，TUI 事件面已可得，无需宿主改动**。
7. **rule-engine 注入呈现（对比项，BACKLOG ④）**：`ruleInjectionTextOf`（`normalize.ts:90`）把 `rule-engine` / `session-channel` 来源按用户块显示（`[RULE] ` / `[CHANNEL] ` 前缀、全文不截断）；这些来源不带 notice 形态（TUI#49 起）。注入同样以 user-role 消息进上下文，模型可见原文——与 notice 形态殊途同归。
8. **TUI 展示现状**：两条路径（实时 + 恢复）均渲染单行摘要行（log 灰、不展开、不占用户块），口径已一致（`SPEC.md:158`）。

### 核实结论（对应 BACKLOG ②⑤）

- 宿主组装口径：**content 原文进模型上下文，也全量落持久日志**；summary 只是展示面的一行账目。BACKLOG 登记时「上下文里最多拿到 ≤120 字符摘要」的前提不成立。
- 边界：compaction 保留尾段之外的 notice 原文**只存在于持久日志**，上下文与 TUI 均不可再取（除非走日志读取工具）。宿主侧原文可得，不存在「事件面拿不到原文」的兜底需求。

## 决策

1. 「宿主 notice 查看」通道形态（对应 BACKLOG ①③⑤）
   - 选项：a) 完整 `content` 注回模型上下文（自动可见）；b) 模型查询通道（按需取 notice 历史原文）；c) 摘要扩容。
   - **选定：a) —— 采纳宿主现状，无代码改动**。核实结论（调研 1/2/4）：宿主本就把 notice 完整 content 以 user-role 消息送进上下文并全量落日志，「原文可见」已满足。
   - b) 的真实缺口收窄为「compaction 保留尾段之外的 notice 原文按需取回」——属**宿主 notice** 侧的遗留，已在项目级 `docs/BACKLOG.md` 第 5 条登记交后续任务（用户 2026-10-19 裁定同意）。
   - c) 不选：上限 120 由宿主 `CONTEXT_SUMMARY_MAX_CHARS` 决定，TUI 不改宿主；且 summary 是展示字段，扩它不构成模型通道。
2. 宿主组装口径核实结论（对应 BACKLOG ②）：content 原文进上下文 + 落日志；「一行账目」= summary 的展示契约，不排除原文。详见调研节。
3. TUI notice 显示覆盖范围（对应 BACKLOG ③）：实时（`user/message` / `agent/inbox/spliced`）与恢复（`HistoryMessage.role='notice'`）两条路径维持单行摘要行**不变**，本就同口径。
4. 与 rule-engine 注入呈现的关系（对应 BACKLOG ④）：**不统一**。[RULE] 用户块（注入指令）与 notice 形态（一次性事件交代）语义不同，模型两侧都已可见原文；「明确不做」已排除注入形态改造。
5. 边界记录（对应 BACKLOG ⑤）：compaction 保留尾段之外的宿主 notice 原文**只存在于持久日志**——此边界即决策 1 b) 条目的动因。
6. **TUI 本地输出对模型可见的通道（2026-10-19 用户需求扩展，三次问答裁定）**
   - 选项：a) 自动注入（`agent.inject` 进下一 pre-step）；b) 按需查询通道（TUI 落旁路日志，模型工具读）；c) 混合。
   - **选定：b) 按需查询通道**。理由：自动注入会把本地输出（含敏感命令结果）刷进上下文并反复重复；按需读由模型决定拉什么、拉多少，上下文零负担，`$` 的「不进上下文」语义保持。
   - 范围（用户多选）：`$` 命令与输出 + TUI 命令结果 notice；**外部日志行（stderr 桥 / 插件 notice 总线）与面板 / `/help` 不做**（未选）。
   - 承载（用户裁定「不能由 TUI 提供吗」→ 同意）：**写入端与读取工具都在 TUI 包内**（`app/adapter/local-log.ts` + `app/adapter/local-log-tool.ts`），不跨模块、不新包；工具注册走宿主 `ctx.tools.register`（TUI 已持有 tools 服务）。
   - 缺省开关（用户裁定）：**缺省开启**（配置 `tui.config.json` 的 `localLog` 段；`enabled:false` 关闭）。
7. **数据契约（写入端与读取端共用）**：`<会话目录>/tui-local.jsonl`，每行一条 JSON：`{"ts":epoch_ms,"kind":"shell"|"notice","text":正文,"meta":{...}}`；`shell` 的 meta 含 `command` / `exitCode` / `signal` / `ms` / `timedOut` / `blocked`（guard 拦截）。上限：单文件 256 KB（写满轮转为 `tui-local.jsonl.1`）、单条 8 KB 截断。写入 fire-and-forget（串行链防交错）；读写 best-effort（目录缺失 / 损坏静默降级）；随会话目录删除一起清理（`deleteSessionDir` 删整个目录）。
8. **读取工具 `tui_local_log`（本任务实现，与项目级第 5 条不同——后者是宿主 notice 的 compaction 后检索）**：参数 `kind`（shell/notice/all，缺省 all）、`limit`（缺省 20 上限 200）、`session_id`（缺省当前调用方会话）；返回最近 N 条按时间正序的文本渲染；会话不可定位时明确报错（指导传 `session_id`）。渲染含 `[HH:mm:ss] kind` 头与 shell 的 command/exitCode/ms meta。
9. **明确不做（扩展后补充）**：不做自动注入（决策 6）；不覆盖外部日志行、面板、`/help`；不改 TUI 本地行的显示口径（`$` 结果仍只进活动区）；不改宿主；项目级第 5 条（宿主 notice 的 compaction 后检索）不并入本任务。

## 规划

任务拆分（最终；原「取消」项被 2026-10-19 扩展需求取代为新实现）：

- 核实宿主口径 → ✓（调研节）。
- 选通道并定接口 → ✓（决策 1-9）。
- 登记项目级第 5 条（宿主 notice 的 compaction 后检索）→ ✓（用户裁定同意）。
- **扩展：TUI 本地输出通道（用户 2026-10-19 裁定：按需查询 / 范围 `$` + 命令 notice / TUI 包内自持 / 缺省开）** → ✓（见下方实现记录）。
- 收尾：`TUI/docs/BACKLOG.md` 本条目标「完成」并清理移除；本追踪文档移入 `TUI/docs/archived/`。

计划改动文件清单（最终）：

- `TUI/src/app/adapter/local-log.ts`（新：写入 + 读取）
- `TUI/src/app/adapter/local-log-tool.ts`（新：工具 `tui_local_log`）
- `TUI/src/app/config.ts`（`localLog` 配置段）
- `TUI/src/app/index.ts`（接线：notice 两处 + `$` 三处）
- `TUI/src/main.ts`（配置归一化 + 工具注册 + getTools）
- `TUI/src/app/adapter/types.ts`（`ToolsLike.register`）
- `TUI/tests/local-log.test.ts`（新：11 例含端到端）
- `TUI/README.md` / `TUI/docs/SPEC.md`（口径）
- `TUI/docs/implementation/2026-10-19-notice-model-view.md`（本文件）
- `TUI/docs/BACKLOG.md`（收尾：本条目扩展说明与完成清理）
- `docs/BACKLOG.md`（计划外，用户已裁定；登记项目级第 5 条）

明确不做（扩展后）：不改宿主代码；不做自动注入；不覆盖外部日志行 / 面板 / `/help`；不改 TUI notice 与 `$` 的显示口径；项目级第 5 条（宿主 notice compaction 后检索）不并入本任务。

## 实现记录

- 2026-10-19：调研完成（宿主源码 + 持久日志实测 + 本仓事件面），结论写入「调研」节；决策与规划同节写入。
- 2026-10-19：用户裁定（提交点 1 问答）：① 同意在项目级 `docs/BACKLOG.md` 登记新条目 → 已追加为 §2 第 5 条「模型按需检索 notice 历史原文（compaction 后取回）」，同日注记与「实现顺序」表同步（第 5 顺位 / 深度 0 / 工作量待细化）；② 提交点 1 答「不提交」（合并到关闭后）。
- 2026-10-19：用户提出扩展需求「所有 TUI 展示内容都给模型看」（`$` 结果为例）→ 三次问答裁定：通道 b) 按需查询 / 范围 `$` + 命令 notice / 承载 TUI 包内 / 缺省开启（决策 6-8）。
- 2026-10-19：实现完成——新增 `app/adapter/local-log.ts`（JSONL 旁路日志：追加写 / 串行链 / 256 KB 轮转 / 8 KB 截断 / best-effort / 目录命中缓存）与 `app/adapter/local-log-tool.ts`（工具 `tui_local_log`，kind/limit/session_id 参数，文本渲染，会话不可定位时报错）；`config.ts` 加 `localLog` 段（缺省开）；`index.ts` 接线 `recordLocalLog`——`App.notice()` 与 adapter `notice` 事件（kind=notice）、`runLocalShell` 回显 / guard 拦截 / 结果（kind=shell，meta 含 command/exitCode/ms）；`main.ts` 归一化配置注入 App deps + `getTools` + `ctx.tools.register(createTuiLocalLogTool())`（effect 注销）；`types.ts` `ToolsLike` 加 `register`。
- 2026-10-19：测试——新增 `tests/local-log.test.ts` 11 例（写入读回 / kind 过滤与 limit / 关闭与空正文与无目录不写 / 单条截断 / 轮转 / 坏行跳过 / 工具会话定位与参数归一化 / render 文本 / App 端到端 `$` 与 notice 落盘）。
- 2026-10-19：验收——TUI 全量测试 1644 例通过（含新增 11 例）、`npm run check` 通过、`npm run build` 通过；SPEC/README 口径已更新。真机（真实 profile 下工具注册与读取）未验证（profile symlink 指向主检出，需合并后生效）。

## 偏差

- 原计划「落地：TUI `src/app/adapter/**` 数据面取与重排（或注入侧插件查询通道）」与「测试与口径：对应单测 + `SPEC.md`」（针对宿主 notice）**未按原样执行**——原因：决策 1 核实后宿主已把宿主 notice 完整 content 送进上下文，该侧无展示口径变化、无代码。随后 2026-10-19 用户扩展需求（TUI 本地输出）**新产生**了 adapter 侧代码（local-log），与「原计划」目标不同，已按新决策 6-8 记录。
- 原「注入侧插件查询通道」未在本任务实现为跨模块插件——用户裁定改由 TUI 包内自持（决策 6-8）；项目级 `docs/BACKLOG.md` 第 5 条（宿主 notice 的 compaction 后检索）保持登记、交后续任务，**不并入**本任务。

## 测试与证据

- `cd TUI && npm run check`：tsc --noEmit 通过（0 错误）。
- `npm run test`（TUI 全量）：**1644 例通过 / 0 失败**（含新增 `tests/local-log.test.ts` 11 例：写入读回 / kind 过滤与 limit / 关闭与空正文与无目录不写 / 单条截断 / 轮转 / 坏行跳过 / 工具会话定位与参数归一化 / render 文本 / App 端到端 `$` 与 notice 落盘）。
- `npm run build`：tsc 编译通过。
- 本地单次运行新增测试文件：11/11 绿。
- 真机验证（真实 profile 下 `tui_local_log` 工具注册、`$` 命令落盘后模型可读）**未做**：现 worktree 的 profile symlink 指向主检出（`.worktree/tui/TUI` 非挂载点），合并到 main 后由用户复验；单测已覆盖工具 execute 与本地日志读写，真机差异仅剩「宿主 tools registry 集成」与「会话目录真实定位」两处。

## 收尾

（已完成, 2026-10-20 收尾。）

- 真机复验（用户授权重启, 真实 fff profile 加载最新 dist；2026-10-20）：`tui_local_log` 已注册进宿主工具清单（会话日志最近 `request/header` 的 tools 含该名）；对真实会话目录执行 dist 的 `createTuiLocalLogTool().execute` 读取成功（ok=true, 读回本会话 3 条 notice, 含重启后 session-channel 注入提示, 时间戳与正文渲染正确）；本会话 `tui-local.jsonl` 有 8 条真实写入记录。写入端 / 读取端 / 工具注册三面真机验证通过。
- 回写文档：`TUI/docs/SPEC.md`（§15 本地输出旁路日志）、`TUI/README.md`（localLog 配置与 `tui_local_log` 工具）已随 `9e2d51d` 提交。
- 提交：2026-10-19 `9e2d51d`（feat: 本地输出旁路日志与模型侧工具, 含 11 例测试, 全量 1644 例通过）；2026-10-20 收尾提交（本文件状态改关闭 + 填收尾节 + BACKLOG 条目完成清理 + 归档移动）。
- 遗留项：项目级 `docs/BACKLOG.md` 第 5 条「模型按需检索 notice 历史原文（compaction 后取回）」（宿主 notice 侧遗留）待后续任务接取。
- BACKLOG 清理：`TUI/docs/BACKLOG.md` 条目「允许模型查看 notice 信息」（#1, 2026-10-19 扩展为「TUI 本地输出对模型可见」）已标完成并从清单移除（注记见该文件头部）。
- 归档：本文件移入 `TUI/docs/archived/2026-10-19-notice-model-view.md`。
- 收尾提交为本任务最后一次提交；未发现残留问题。
