# 插件文档事实校正、去重与精简（接取条目：docs/BACKLOG.md「插件文档事实校正、去重与精简（29 个模块的文档一致性）」）

状态：关闭　　开启：2026-10-18　　关闭：2026-10-18
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

多轮插件开发后, 模块文档与根文档出现事实漂移 / 重复 / 矛盾 / 冗长。本任务逐包核对文档与代码, 修正过时事实与矛盾, 合并或删除重复, 压缩冗长表述；不改代码、不改变功能描述的含义。

## 调研

### 1 机械核对（2026-10-18, 可复现）

- **包清单**：目录 29 个（TUI + 28 插件）；根 `package.json` 的 check / build 链、`scripts/test-parallel.sh` 的 `default_pkgs`、`scripts/install.sh` 的 `canonical_pkgs` 三处集合一致（子代理核对）。清单写错的位置：`docs/WORKFLOW-STANDARD.md:11`（19 个, 缺 9 项）、`docs/ROADMAP.md:10`（20 个）、`docs/ARCHITECTURE-REUSE.md:3,7,9,38`（21 模块 / 总表 22 行 / 保留 15, 且表内漏 7 包）、`docs/STATUS.md:14`（12 个, 旧名 knowledge-base）、`docs/host/HOST-PACKAGES.md:49,484,487`（18 / 20 / 17 三个数）、`docs/BACKLOG.md:91`（21/22 → 26/27, 现 28/29）。
- **根 README 表格**：`README.md:42` / `README.zh.md:42` 的空行把 `agent-group` 行挤出表格（同缺陷 `TUI/docs/COMMANDS.md:43`）；插件表 27 行, 缺 `background-daemon`；目录树缺 `background-daemon` / `auto-approve` / `agent-group`；`AGENTS.md:77` 逐包说明缺 `auto-approve` / `background-daemon`。
- **基线版本**：`README.md:9`、`README.zh.md:7`、`profiles/README.md:50`、`TUI/docs/STATUS.md:11` 仍写 `0.1.7-rc.2`；现基线 `0.2.0-rc.2`（`scripts/install.sh:12`、`docs/BACKLOG.md:9`）。
- **单测例数**（2026-10-18 实跑 `npm run test`, 29 包全绿 1628 + 28 包）：与文档不符 6 处 —— `code-map` 23 → 24、`command-template` 26 → 27、`goal-contract` 37 → 41、`hash-edit` 52 → 53、`herdr-integration` 43 → 49、`session-paths` 23 → 24；其余写数字的包（ast-tools 38 / context-report 41 / fs-digest 66 / md-logic 57 / md-map 49 / memory-base 61 / metric-loop 45 / output-compress 57 / security-guard 135 / task-engine 136）与实测一致。
- **失效路径引用**：追踪文档已归档但正文仍指向 `docs/implementation/` —— `auto-approve/README.md:178`、`background-daemon/README.md:5,87`、`preference-analysis/docs/{DESIGN.md:5,BACKLOG.md:13}`、`docs/BACKLOG.md:19,66,97`、`TUI/docs/BACKLOG.md:16,18,20,24,28,34`、`TUI/docs/SPEC.md:114`；另 `docs/BACKLOG.md:31` 指向已删除的 `TUI/docs/IMPLEMENTATION.md`。
- **重复 / 冗余**：`memory-base/IMPLEMENTATION.md` 与 `README.md` + `docs/DESIGN.md` 三重覆盖, 且未随 2026-10-17 瘦身更新（本任务已并入 DESIGN §11 并删除该文件）；`context-report/README.md` 同一事实（回合 / 步 / 墙钟读官方 `sessionStats`）在 :7 / :58 / :79-85 三段重复；`docs/ARCHITECTURE-REUSE.md:50` 与 `:21` 重复述 `output-compress` 与官方 spill 的分工。
- **矛盾**：`docs/WORKFLOW-STANDARD.md:35`「条目按依赖 → 工作量升序」与 `docs/BACKLOG.md:65`（工作量升序）/ `:105`（依赖深度优先）相反；`docs/ROADMAP.md:11,49`「不引入常驻守护进程」与已落地的 `background-daemon` 未做区分；`AGENTS.md:93` 称轻量包「只留 README + BACKLOG」, 而 `background-daemon` / `context-report` / `goal-contract` / `metric-loop` 无 `docs/`；`TUI/README.md:11`「BACKLOG 未完成待办为空」而实际 4 条；`TUI/README.md:15` 指向根 `archive/`, 与 `AGENTS.md:87` 的「模块历史进模块 docs/archived」相反。
- **其他过时点**：`docs/WORKFLOW-STANDARD.md:17` 把 `docs/ROADMAP.md` 标「（待建）」（已存在 54 行）；`AGENTS.md:34` 的 `--help` 选项列 6 项（实际 10 项）；`README.md:141` / `README.zh.md:141` 称复用审计基线「TUI + 17 包, 后加 3 包」（该文件现自称 21 模块且 7 包未入表）；`README.md:159` DESIGN 名单漏 `preference-analysis` / `agent-group`；`README.md:162` 模块 BACKLOG 名单只列 12 个（实际 22 个）；`docs/ARCHITECTURE-REUSE.md:60` 称两包共用同一 `dbPath`（现为每会话 `digest.db`）；`:92` 引用的 `hash-edit/docs/BACKLOG.md #1` 已不存在；`TUI/docs/COMMANDS.md:20` 基线、`TUI/docs/COMMANDS-SPEC.md:44` 的「BACKLOG 3.1.1」章节引用、`TUI/docs/STATUS.md:10` 的 `/verbose` 两态、`TUI/README.md:163,333` 的「BACKLOG #48 / #6」均与现状不符。

### 2 逐包审计（子代理只读, 逐条已给文件:行证据）

**B 组（security-guard / auto-approve / background-daemon / session-paths / session-title-cutoff / md-table-check）**

- `security-guard/README.md:197` 称「含本仓 19 插件」→ 28；`:211` 记 `str_replace_editor` 待裁定, 与 `docs/BACKLOG.md:12`「当前无未完成项」矛盾；根 `README.md:29` / `README.zh.md:29` 仍称挂在 `tools/pre-execute` 水位线, 与本包 `README.md:5`、`src/index.ts:1310` 的单调守卫 `ctx.tools.guard`（pre-execute 仅回退）矛盾；`:13-14` 与 `:18-21`、`:23` 与 `:166-188` 重复；`:189-213` 约 25 行可压到 10 行。
- `auto-approve/README.md:178` 归档路径未更新（下同）；`:150` 称 `session-paths`「必需」, 与 `:151-152` 的降级说明及 `src/main.ts:63` 的 `inject = ["approval","tools"]` 矛盾；`:156-162` 与 `docs/BACKLOG.md:17-21` 逐条同义；BACKLOG 三条关闭注记属过程叙述, 22 行可压到 12 行。
- `background-daemon/README.md:74` 写 `inject` 五项含 `timer` → 实为四项（`src/main.ts:88`）, `timer` 是可选读（`:218` `readService` + 进程内 `setTimeout` 兜底）；`:5` / `:87` 归档路径；`:100` 称「六个子命令」→ 实为 7 个（`src/commands.ts` 里 pause / resume 分立）。
- `session-paths/README.md:83` 称 23 例 → 24（encode 11 + service 13）；`:27-28` 与 `:46-47` 重复述「唯一写盘入口 / 0700 / 幂等」；`:5-15` 11 行可压到 5 行。
- `session-title-cutoff/README.md:21` 称 provider / model「留空 = 复用会话路由（推荐）」, 与 `src/main.ts:38` 注释「建议配置」矛盾；`:43-47` 的 YAML 块只有一行注释, 可压成 1 行。
- `md-table-check/README.md:132-134` 仍指向 `docs/implementation/`（根 `docs/implementation/` 不存在, 本包该目录为空）；`:52-53` / `:71` / `:78` / `:44-45` 与 BACKLOG 及本文件其他段落重复；`:56-92` 37 行可压到 22 行, `:58-60` 括号未闭合。
- 组内共性：`AGENTS.md:93` 把 `background-daemon` / `session-title-cutoff` 列为「只留 README + BACKLOG」的轻量包, 两包都没有 `docs/BACKLOG.md`（前者无 `docs/`, 后者只有 `docs/archived/`）。

**A 组（ast-tools / context-report / fs-digest / goal-contract / hash-edit）**

- `ast-tools/README.md`：`:3` / `:49` / `:118` 三处重复「走系统 ast-grep CLI」；`:24` 称选择成本「口径与工具描述一致」, 而 `ast_query` 描述（`src/tools.ts:188`）无「单点改写用 `hash_edit`」分支（该分支在 `ast_replace` 描述 `:385`）；`:62-114` 53 行可压到 30 行。
- `context-report/README.md`：同一事实（回合 / 墙钟读官方 `sessionStats`）在 `:7,58,63,79,83` 出现五次；`:48-50` 与 `:75` 重复硬依赖说明；`:87` 与 `:112` 两次引同一依据；`:77-87` 11 行可压到 4 行。
- `fs-digest/README.md:15` 称 signatures 也以省略行收尾 → 实际无省略行（`src/main.ts:116-119`）, 只有 outline / pruned 补；`:53` 与 `:74` 重复指路；`:25-46` 22 行可压到 13 行。
- `goal-contract/README.md:13` 称 `clauses` 与 `clauses_text` 二选一 → 实际 `clauses` 优先、`clauses_text` 被静默忽略（`src/tool.ts:166-174`）；`:32` 与 `:75`、`:13` 与 `:34` 重复。
- `hash-edit/README.md:76` 错字「不经营主围栏」（应为「不经宿主围栏」）；`:71-76` 与 `:84-85`、`:78` 与 `:106` 重复；`:67-78` 12 行可压到 6 行。

**C 组（herdr-integration / herdr-pane / md-logic / md-map / code-map）**

- `herdr-integration/README.md:88`「无心跳 / 漏收不补齐」与 `:27` 的 20 秒周期重发矛盾（`src/main.ts:322-330`）；`:29` 与 `:87` 重复补发策略。
- `herdr-pane/README.md:7` 的归档路径易被读成本包内路径（实际在仓库根 `docs/archived/`）；`:70` 称 `label` / `wait` 也走审批, 与 `:59`、`src/policy.ts:84-87` 矛盾；`:11-22` 与 `:36-47` 两张表逐行重复。
- `md-logic/README.md:58` 称「本仓 21 个包」→ 29；分工说明在 README 四处 + DESIGN 一处重复；`:20-30` 与 `DESIGN.md:32-38` 同述改写管线；`RENDER_LIMIT` 写三处。
- `md-map/README.md:71` / `:89` 的索引快照数字（204 文档 / 1404 边 / 96 孤儿）随仓库增长失真（实测 403 / 3277 / 216）→ 结论是删掉数字。
- `code-map/README.md:11` 漏「带 `root` 时全量重扫」（`src/index.ts:158-160`）；`:97` 列了不存在的根 `index.ts`；DESIGN 引「BACKLOG #22」已无该条目；LSP 三件套在五处重复。

**D 组（task-engine / memory-base / session-channel / rule-engine）**

- `task-engine/README.md:17` 同句自相矛盾（「已完成的当前轮根」vs「done 或 failed」）→ 实际 failed 也开轮（`src/engine.ts:348`）；worktree 与 executor 两段与 DESIGN 大段重复。
- `memory-base/docs/DESIGN.md:50` 称注册约束「只有三条」（实际五条, `src/router.ts:97-106,147`）；`:77` 与 `:143` 对 CJK 兜底条件说法不一（`src/knowledge.ts:314-316`）；README 与 DESIGN 六组近 1:1 重复；`IMPLEMENTATION.md` 三重覆盖且未随瘦身更新。
- `session-channel/README.md:92-94` 的 `TaskRecord` 漏 `triggerSeq?`、`deadline` 必填性写错（`src/types.ts:165,177`）；与 DESIGN 多组重复。
- `rule-engine/docs/DESIGN.md:61` 称内置谓词「只做」四个（实际六个, `src/match.ts:36-37`）；`:14` 的过程叙述已过时；`:97` 漏 `reset`（`src/engine.ts:15`）。

**E 组（preference-analysis / agent-group / command-template / symbol-normalizer / ponytail / output-compress / metric-loop / script-interpreter）**

- `preference-analysis`：DESIGN / BACKLOG 两处归档路径未更新；与 DESIGN 三组重复。
- `agent-group/README.md:30` 的 `check` 收场状态与 `:31`、`DESIGN.md:45` 矛盾（`src/types.ts:37`）；`cordis.patch.yml:2` 注释与实际注册行为不符（`src/main.ts:308-316`）。
- `command-template/README.md:86` 把已落地的叶子 `executor` 写成未来；`totalTimeoutMs` 三处重复。
- `symbol-normalizer/docs/DESIGN.md:3` 引「项目级 BACKLOG #48」（无此编号且规则禁止跨引用）；`README.md:91` 指向空 BACKLOG。
- `ponytail/README.md:37` 同句既说硬依赖又说「缺席告警不注册」（`src/main.ts:19,101-110`）；`DESIGN.md:3` 把 `docs/ponytail-investigation.md` 写成在仓库根。
- `output-compress` / `metric-loop` / `script-interpreter`：各自内部 2 至 4 组重复与冗长段。

## 决策

1. **范围**：选项 (a) 28 插件模块文档 + 根文档的插件事实 + TUI 文档的失效引用; (b) 只做 28 插件 + 根文档; (c) 再加 `docs/STATUS.md` 与 `docs/host/`。**用户 2026-10-18 裁定选 (c)**：在 (a) 之上追加 `docs/STATUS.md` 重写与 `docs/host/` 的计数 / 改名修正（`STATUS.md` 本由用户择时更新, 本次经用户授权一并改）。
2. **数字口径**：选项 (a) 过时例数改为实测值并保留细分; (b) 一律删掉具体数字。**选定 (a)**：已有细分是有效信息, 只是需要与实测对齐；本任务新写的句子不再引入新的例数。
3. **标点**：选项 (a) 改到的段落用 ASCII 标点 + 空格（当前规则）, 未改动的行不动; (b) 全文件统一转换。**选定 (a)**：避免整文件重排掩盖真实改动。
4. **`memory-base/IMPLEMENTATION.md`**：选项 (a) 把仍有效的内容并入 `docs/DESIGN.md` 后删除; (b) 保留并瘦身; (c) 移入 `docs/archived/`。**选定 (a)**：其内容属实现落点与机制, 归 DESIGN；文件在包根而非 `docs/`, 也违反文档分层。
5. **`docs/ARCHITECTURE-REUSE.md`**：选项 (a) 只修口径 / 计数 / 过时事实, 7 个未入表包另立条目; (b) 本次补 7 行审计。**选定 (a)**：补行需要逐包重新判定官方等价物, 属独立调研。

## 规划

三批执行, 每批改完先自查 diff 再进下一批。

- 批次 1（机械修正, 逐条定位）：根 `README.md` / `README.zh.md`（表格断行、缺行、基线、DESIGN / BACKLOG 名单）、`AGENTS.md`（`--help` 选项、轻量包清单补 `script-interpreter`）、`docs/WORKFLOW-STANDARD.md:11,17,35`、`docs/ROADMAP.md:10,11,49`、`docs/ARCHITECTURE-REUSE.md:3,7,9,38,60,92`、`profiles/README.md:50`、6 处例数、14 处失效引用（含 TUI 7 行）、`TUI/docs/COMMANDS.md:20`、`TUI/docs/COMMANDS-SPEC.md:44`、`TUI/README.md:11,15,163,333`。
- 批次 2（逐包去重与压缩）：按逐包审计结果处理 28 包 `README.md` 与 13 份 `docs/DESIGN.md` 中的重复段与冗余表述；`context-report` 三处重复为首个样本。
- 批次 3（结构清理）：`memory-base/IMPLEMENTATION.md` 并入 DESIGN 后删除；`docs/BACKLOG.md` 的重复条目 5、编号断档、过时〔进行中〕标记与条目 8/16 的计数口径。

计划改动文件清单（逐文件确认后改, 未确认不动）：

- 根文档：`README.md`、`README.zh.md`、`AGENTS.md`、`docs/WORKFLOW-STANDARD.md`、`docs/ROADMAP.md`、`docs/ARCHITECTURE-REUSE.md`、`docs/BACKLOG.md`、`docs/STATUS.md`、`profiles/README.md`。
- 宿主面（仅计数与改名）：`docs/host/HOST-PACKAGES.md`、`docs/host/AGENT-ARCHITECTURE-ANALOGY.md`。
- TUI：`TUI/README.md`、`TUI/docs/BACKLOG.md`、`TUI/docs/SPEC.md`、`TUI/docs/COMMANDS.md`、`TUI/docs/COMMANDS-SPEC.md`。
- 插件：28 个 `README.md`、13 份 `docs/DESIGN.md`、21 份 `docs/BACKLOG.md`（仅命中问题的文件）、`memory-base/IMPLEMENTATION.md`（删除）。

明确不做：不改代码与脚本（`scripts/test-parallel.sh:8` 的「11 包」注释另立条目）；不重做复用审计；不改 `docs/host/HOST-UPGRADE-*.md` 里的历史快照数字；不改 `archived/` 与 `archive/` 下的历史文档。

## 实现记录

**2026-10-18 计划文档提交**：`282e8d7`（BACKLOG 条目 + 本追踪文档）。

**批次 1（主代理逐条改，证据见各文件 diff）**

- 根 `README.md` / `README.zh.md`：插件表补 `background-daemon`（27 → 28 行）并修掉截断表格的空行；目录树补 `auto-approve` / `background-daemon` / `agent-group`；DSH 基线句改为「0.1.7-rc.2 逐条复核 + 0.2.0-rc.2 对照无变化」；`security-guard` 行改单调守卫口径；`task-engine` 工具族补 `execute`；`agent-group` 收场状态补 `removed`；ARCHITECTURE-REUSE / DESIGN / BACKLOG 三处清单描述改准；`--sync` 段落压缩约四成。
- `AGENTS.md`：`install.sh --help` 改为指向 README（原列 6 项、实际 10 项）；插件子包清单补 `auto-approve` / `background-daemon`；轻量包口径改「`README.md`（`BACKLOG.md` 按需）」并补 `script-interpreter`。
- `docs/WORKFLOW-STANDARD.md`：模块定义改「`TUI` 与 28 个插件包（清单以 `AGENTS.md` 为单一来源）」；ROADMAP 去掉「（待建）」；条目排序改「依赖深度 → 工作量」。
- `docs/ROADMAP.md`：20 → 28 包；「常驻守护进程」限定为「进程外」，并注明进程内投递由 `background-daemon` 承担。
- `docs/ARCHITECTURE-REUSE.md`：口径改 29 模块 / 已审计 22 个 + 未入表 7 包清单；结论分布改 16 保留 + 6 并存；`memory-base ⇄ output-compress` 边界改为「不共库直写 + 作用域句柄」；删失效的 `hash-edit/docs/BACKLOG.md` #1 引用。
- `profiles/README.md`：条目 id 出处改为「宿主 `dsh-base` + 本仓 + `- insert:`」三源，去掉 0.1.7 版本口径。
- 6 处单测例数改实测值：`herdr-integration` 49（state 12 + herdr 12 + main 25）、`code-map` 24、`command-template` 27、`goal-contract` 41（clauses 8 / contract 11 / interview 8 / tool 14）、`hash-edit` 53、`session-paths` 24。
- `docs/BACKLOG.md`：§2 整理 —— 删重复的 Docker 条目、关闭并移出 10 条已完成项（各项落点见各自追踪文档）、编号从 1 重排、实现顺序表重排、排序依据统一为「依赖深度 → 工作量」、§5 的 herdr 取证指向修正、`:19` / `:66` 归档路径修正。
- `docs/STATUS.md`：按 28 个插件重写状态表（含实测单测数）、宿主基线改 `0.2.0-rc.2`、profile 挂载数改 29 包、依赖关系按现状重写。
- `docs/host/HOST-PACKAGES.md`：三处包计数改 29 / 28；`docs/host/AGENT-ARCHITECTURE-ANALOGY.md`：`knowledge-base` → `memory-base`（注记原名）。
- TUI：`README.md`（BACKLOG 条数、历史目录指向、补 `STATUS.md` 行、删失效编号）；`docs/{BACKLOG,SPEC,COMMANDS,COMMANDS-SPEC,STATUS}.md`（归档路径、基线版本、`/verbose` 口径、清除 `BACKLOG #n` 类失效引用）；`docs/DESIGN.md`（同类编号引用清理）。

**批次 2 / 3（6 个编辑子代理，按包分工，互不重叠；主代理逐份复核 diff）**

- 逐包处理见「调研」§2 各组的条目：每组按「过时 → 修正、重复 → 留一处其余指路、冗长 → 压缩」处理，事实性改动均要求代码或另一份文档作依据。
- `memory-base/IMPLEMENTATION.md`（83 行，包根）：仍有效的实现落点与踩坑并入 `docs/DESIGN.md` §11 后删除该文件。
- 主代理复核时修正了两处子代理过度改写：`security-guard` 里把 `str_replace_editor` 写成「已裁定不登记」（无裁定记录，改为「不在本包登记表内，若需纳入另开条目」）；`ast-tools` 里插入的「工具描述口径」说明（读者无关的内部不一致描述，删去）。

## 偏差

- **TUI 历史编号引用未清完**：`TUI/docs/DESIGN.md` 仍有约 15 处 `TUI#n` 形式的旧任务编号（属历史溯源，非本任务清单内文件的核心问题）；`TUI/docs/SPEC.md` 与本任务涉及的其他 TUI 文档已清零。另立条目。
- **`docs/host/HOST-UPGRADE-*.md` 的历史快照数字未改**（如「17 个包」）：那是升级当时的真实记录，改成现值会伪造历史；只在 `HOST-PACKAGES.md`（当前字典）改计数。
- **`docs/host/` 仅做计数与改名**：未重做宿主面知识复核（该目录不参与本流程）。
- **`docs/ARCHITECTURE-REUSE.md` 未补 7 个包的审计行**（决策 5 选 a），只在口径处列出缺口。
- **`scripts/test-parallel.sh:8` 的「11 包」注释未改**（代码文件，明确不做），另立条目。
- **`TUI/docs/COMMANDS.md` 的「现注册 6 条」只改基线版本**：本机无 0.2.0 宿主命令清单可核，未重新点条数。

## 测试与证据

- `npm run test`（2026-10-18，改动前跑的基线）：29 包全绿 —— TUI 1628 / herdr-integration 49 / herdr-pane 109 / memory-base 61 / task-engine 136 / ast-tools 38 / md-logic 57 / md-map 49 / fs-digest 66 / goal-contract 41 / hash-edit 53 / metric-loop 45 / output-compress 57 / security-guard 135 / code-map 24 / context-report 41 / rule-engine 151 / symbol-normalizer 43 / session-channel 62 / session-title-cutoff 8 / command-template 27 / ponytail 5 / md-table-check 73 / auto-approve 115 / background-daemon 136 / preference-analysis 68 / session-paths 24 / script-interpreter 73 / agent-group 40。
- 包清单一致性（脚本核对）：29 个目录 = 根 `package.json` check / build 链 = `scripts/test-parallel.sh` = `scripts/install.sh` = 根 README 两张表（各 29 行，含 TUI）= `docs/STATUS.md` 28 行 + TUI 单列 = `AGENTS.md` 清单。
- 失效路径引用扫描（脚本，排除 `archived/` / `archive/` / `docs/host/` 历史项）：0 条（剩余命中均为宿主安装树路径、模板占位符与历史叙述）。
- `md_map` 刷新：403 文档 / 4048 锚点 / 3356 内部边 / 2 条断链——两条断链都在 `archived/` 历史文档里（`md-map` 与 `session-channel` 各一条），本次未动。
- 量化：64 个文件变更（含 1 个删除），+557 / −824 行（净减 267 行）；文档行数由 4905（README 合计）+ 2254（DESIGN 等）降到相应减少后的值。
- `format`：改动文件统一格式化（Markdown 用 mdformat，`cordis.patch.yml` 按项目约定不格式化）。
- 本次只改文档与一处 YAML 注释（`agent-group/cordis.patch.yml` 的注释），未改代码；`npm run check` / `build` 不适用（无代码变更），`npm run test` 在改动前后同为零代码影响。

## 收尾

- 回写：`AGENTS.md`（包清单与轻量包口径）、根 `README.md` / `README.zh.md`（插件表与文档索引）、`docs/ROADMAP.md`、`docs/ARCHITECTURE-REUSE.md`、`docs/WORKFLOW-STANDARD.md` 均已在批次 1 内同步。
- BACKLOG：条目「插件文档事实校正、去重与精简（29 个模块的文档一致性）」标完成并移出 §2；顺带关闭并移出 10 条已完成项。
- 遗留：已写入 `docs/BACKLOG.md` §2「后续补条目候选」（2026-10-18 文档整理遗留）——TUI `DESIGN.md` 的 `TUI#n` 清理、`scripts/test-parallel.sh` 注释计数、`docs/ARCHITECTURE-REUSE.md` 补 7 包审计、`agent-group/src/main.ts` 头部注释与 `docs/STATUS.md` 的 P 级字段（重写后未保留，原 P0/P1/P2 与实际规划表已不一致）。
- 本文件移入 `docs/archived/`。
