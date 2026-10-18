# 插件文档事实校正、去重与精简（接取条目：docs/BACKLOG.md「插件文档事实校正、去重与精简（29 个模块的文档一致性）」）

状态：规划　　开启：2026-10-18　　关闭：-
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
- **重复 / 冗余**：`memory-base/IMPLEMENTATION.md` 与 `README.md` + `docs/DESIGN.md` 三重覆盖, 且未随 2026-10-17 瘦身更新；`context-report/README.md` 同一事实（回合 / 步 / 墙钟读官方 `sessionStats`）在 :7 / :58 / :79-85 三段重复；`docs/ARCHITECTURE-REUSE.md:50` 与 `:21` 重复述 `output-compress` 与官方 spill 的分工。
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

（A / C / D / E 组待回填）

## 决策

1. **范围**：选项 (a) 28 插件模块文档 + 根文档的插件事实 + TUI 文档的失效引用; (b) 只做 28 插件 + 根文档; (c) 再加 `docs/STATUS.md` 与 `docs/host/`。**选定 (a)**：`docs/STATUS.md` 按 `AGENTS.md` 由用户择时更新, `docs/host/` 不参与本流程, 两者登记条目交后续任务。
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

- 根文档：`README.md`、`README.zh.md`、`AGENTS.md`、`docs/WORKFLOW-STANDARD.md`、`docs/ROADMAP.md`、`docs/ARCHITECTURE-REUSE.md`、`docs/BACKLOG.md`、`profiles/README.md`。
- TUI：`TUI/README.md`、`TUI/docs/BACKLOG.md`、`TUI/docs/SPEC.md`、`TUI/docs/COMMANDS.md`、`TUI/docs/COMMANDS-SPEC.md`。
- 插件：28 个 `README.md`、13 份 `docs/DESIGN.md`、21 份 `docs/BACKLOG.md`（仅命中问题的文件）、`memory-base/IMPLEMENTATION.md`（删除）。

明确不做：不改代码与脚本（`scripts/test-parallel.sh:8` 的「11 包」注释另立条目）；不改 `docs/STATUS.md` 与 `docs/host/`；不重做复用审计；不改 `archived/` 与 `archive/` 下的历史文档。

## 实现记录

（实施时按时间追加）

## 偏差

（待填）

## 测试与证据

（待填）

## 收尾

（待填）
