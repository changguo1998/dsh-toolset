# 文档口径与整理遗留同步（接取条目：`docs/BACKLOG.md` §2「docs/ARCHITECTURE-REUSE.md 的模块口径随加包同步」+「文档口径与整理遗留同步」）

状态：已完成（2026-10-22 关闭）　　开启：2026-10-22　　关闭：2026-10-22
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让全仓文档与实际形态一致：模块 / 包计数、复用审计表的覆盖行、README 双侧的审计口径、`TUI#n` 旧编号引用、两处代码注释、`docs/BACKLOG.md` §4 未建包表、`herdr-use` 已完成的条目标记。来源：用户 2026-10-22 指令「更新所有需要更新的文档」。

## 调研

（来源：`docs/ARCHITECTURE-REUSE.md`、根 `README.md` / `README.zh.md`、`docs/BACKLOG.md`、`TUI/docs/DESIGN.md`、`herdr-use/docs/BACKLOG.md`、`scripts/test-parallel.sh`、`agent-group/src/main.ts`）

1. **包与模块计数**：仓库现有 **31 个包**（`ls -d */package.json` 实测）= `TUI` + 30 个插件，与 `AGENTS.md:3,30,62` 的「30 个插件 / 挂载 31 个包 / 模块 = TUI 与 30 个包」一致。
2. **`docs/ARCHITECTURE-REUSE.md` 现状**：头部写「本仓 29 个模块（TUI + 28 插件）」「已审计 29 个全量」，§0 总表实际 **29 行**（TUI + 28 插件），结论分布「改用 0 / 保留 21 / 并存 8」。行数核对后缺 **2 行**：`timer`（2026-10-19 新增包）与 `behavior-correction`（2026-10-22 新增包）。§1 标题「保留项（21）」与 §2 标题「并存项（8）」按行数计数。
3. **README 双侧口径**：`README.md:148` / `README.zh.md:148` 写「覆盖 30 个模块中的 22 个，最新的 8 个尚未入表」——这 8 个已于 2026-10-20 补审 7 个，只剩 `behavior-correction`；模块数也应改 31。
4. **`TUI/docs/DESIGN.md` 的 `TUI#n`**：共 15 处（`grep -n "TUI#[0-9]"`），分布在状态列 Agents 块（`TUI#39`/`TUI#55`/`TUI#56`）、别名段（`TUI#48`）、排队块（`TUI#43`×2）、会话列表（`TUI#1`/`#2`、`TUI#22`/`#23`×2、`TUI#40`×2）、投影事件（`TUI#13`）、skill 自载（`TUI#41`）、启动参数（`TUI#19`）、usage 占位（`TUI#12`）、一次性中断原因（`TUI#54`）、面板保鲜（`TUI#10`）、面板标记（`TUI#1`，另一处同号不同条目）。`TUI/docs/BACKLOG.md:4` 已写明编号**每次整理重编号、仅供阅读**，故这些编号在语义上不可回溯——旧 `TUI#1` 同时指「问答面板空心→实心」与「会话列表排序」两个不同条目即为证据。
5. **代码注释**：`scripts/test-parallel.sh:8` 写「11 包子包测试各自独立」（现 30 包）；`agent-group/src/main.ts:105-107` 的 `readService` 注释写「本包故意不写 `inject`（可选读取口径）」「而不是按设计『不注册工具 + 一次警告』」，与同一文件 6-12 行的头注释（`inject = ["tools"]`，2026-10-19 真机修正）矛盾。
6. **`docs/BACKLOG.md` §4「插件规划（未建包）」**：表内两行均已失效——`behavior-correction` 已于 2026-10-22 建包并关闭；「内容资产（非插件）/ 模板体系③」随 `command-template` 于 2026-09-30 交付。
7. **`herdr-use/docs/BACKLOG.md:7`**：「tab_create 之后不必再建 pane」已按快速流程完成（提交 `5121690`），但按快速流程约定未更新条目状态，故文件里仍写「未接取」。
8. **不可做项**：`~/.dsh/profiles/fff` 的 output-compress 过渡 `sessionDir` 行在工作区外（只读沙箱），本次不处理，保留在候选清单。

## 决策

1. **计数口径统一为「包」**：`docs/ARCHITECTURE-REUSE.md` 与 README 双侧改用 **31 个包（TUI + 30 插件）**，与 `AGENTS.md` 的 31 包口径一致；不再使用「N 个模块」这个易混说法（旧文里 29 / 30 两种口径同时存在，正是混用所致）。
2. **审计表补两行**：`timer` 记为**并存**（与宿主 `cordis-plugin-timer` 并存、不包装，服务面 `clock` 自持原语）；`behavior-correction` 记为**保留**（`rule-engine` 的 `tools/pre-execute` guard 消费者，官方 hooks / `agent-instructions` 无「该用专用工具却走 shell」判定）。结论分布随之为 **改用 0 / 保留 22 / 并存 9**，§1 / §2 标题计数同步。
3. **`TUI#n` 一律不换成新编号**：编号口径本身不稳定，换新号等于制造新的失效引用。改为**删去编号、由正文描述承载**（这些句子里大多已写明功能）；确有需要保留溯源的，回指 `TUI/docs/archived/` 的追踪文档而不引编号。
4. **代码注释按实况改写**（不是删注释）：`test-parallel.sh` 的「11 包」改「30 包」；`agent-group` 的 `readService` 注释改为「`inject = ["tools"]` 只声明工具面，其余服务仍是可选读取，故 `ctx.get` 失败要自吞」。
5. **§4 表保留表头并写明当前无未建包项**（不整节删除），便于下次加包时直接续写。
6. **`herdr-use` 条目改关闭注记**（与其它模块 BACKLOG 的写法一致：留一行 `> 日期 关闭：…` + 证据，条目正文移除）。

## 规划

### 计划改动文件清单

1. `docs/BACKLOG.md` —— 条目状态流转（接取 / 收尾移除）；§4 表清空未建包项（已改）。
2. `docs/implementation/2026-10-22-docs-consistency.md` —— 本文件。
3. `docs/ARCHITECTURE-REUSE.md` —— 头部计数 31、结论分布 0 / 22 / 9；§0 补 `timer` / `behavior-correction` 两行；§1 标题（22）与并列述、§2 标题（9）与并存对表补 `timer` 行。
4. `README.md:148` —— 审计覆盖口径改为 31 个包全量。
5. `README.zh.md:148` —— 同上（中文版）。
6. `TUI/docs/DESIGN.md` —— 15 处 `TUI#n` 改为正文描述。
7. `scripts/test-parallel.sh:8` —— 注释 11 包 → 30 包。
8. `agent-group/src/main.ts:105-107` —— `readService` 注释与 `inject` 实况对齐。
9. `herdr-use/docs/BACKLOG.md` —— 已完成条目改关闭注记。

**明确不做**：给 `TUI/docs/DESIGN.md` 引入新编号；改 `docs/STATUS.md`（用户择时更新）；动 `~/.dsh/profiles/fff`（工作区外）；重跑复用审计结论（`timer` / `behavior-correction` 只按既有事实记账，不重审官方包）。

### 步骤

1. 接取条目并建本文件 → 改 `docs/BACKLOG.md`（条目状态 + §4 表）。
2. 改 `docs/ARCHITECTURE-REUSE.md`（计数 + 两行 + §1 / §2）。
3. 同步 `README.md` / `README.zh.md`。
4. 改 `TUI/docs/DESIGN.md` 的 15 处编号引用。
5. 改两处代码注释。
6. `herdr-use/docs/BACKLOG.md` 条目关闭。
7. 验证：`format` 改动文件、`npm run check`（`agent-group` 涉及 TS）、`npm --prefix agent-group test`、`grep` 复核零残留。
8. 关闭：条目移除、本文件移入 `docs/archived/`、收尾提交。

### 验收

- `grep -rn "TUI#[0-9]" TUI/docs/DESIGN.md` 零命中；正文语义不变（逐处核对，不删功能描述）。
- `grep -rn "29 个模块\|已审计 29\|30 个模块中的 22"` 零命中（`docs/archived/` 与各模块 `archived/` 除外）。
- `docs/ARCHITECTURE-REUSE.md` §0 表 31 行，§1 标题（22）/ §2 标题（9）与行数一致。
- `scripts/test-parallel.sh:8` 不再出现「11 包」；`agent-group/src/main.ts` 的 `readService` 注释与 `inject = ["tools"]` 不矛盾。
- `herdr-use/docs/BACKLOG.md` 不再有「未接取」的已完成条目。
- `npm run check` 通过、`npm --prefix agent-group test` 通过。

### 风险与待确认

- `TUI#n` 删除后，若某处正文本身没写清功能，会损失溯源线索——逐处读上下文，必要时补一句功能描述而不引编号。
- `agent-group` 注释改动涉及 `src/`，需跑 `check` + 包测试；纯注释不应影响行为，测试预期全绿。

## 实现记录

1. `docs/BACKLOG.md`：接取条目 3 并修正其口径（29 模块 → 31 包、待补 2 行）；新增条目 4 承载 TUI#n / 代码注释 / §4 表 / herdr-use 条目；§4「插件规划（未建包）」表体清空为一行说明（`behavior-correction` 已建包、模板体系③已交付）；「文档整理遗留」段收敛为剩余项（只剩 profile 过渡行与 timer 统一面接入）。
2. `docs/ARCHITECTURE-REUSE.md`：头部计数改「31 个包（TUI + 30 插件）」、结论分布改「改用 0 / 保留 22 / 并存 9（总表 31 行）」；§0 补 `timer`（并存）与 `behavior-correction`（保留）两行；§1 标题（21→22）与并列述同步；§2 标题（8→9）并补 `timer` 并存对行；§3 补一行「2026-10-22 补审的 2 个包对官方底座无新增消费」；§7 补一条修订记录。
3. `README.md` / `README.zh.md`：审计行改为「覆盖全部 31 个包（结论 0 / 22 / 9）」。
4. `TUI/docs/DESIGN.md`：15 处 `TUI#n` 全部改为正文描述（21 次字符串替换，含同一句内多处）；另清理同类的 3 处（`TUI/docs/COMMANDS.md` / `COMMANDS-SPEC.md` / `design/NOTICE-LEVELS.md` 各 1 处），见「偏差」1。
5. `scripts/test-parallel.sh:8`：注释「11 包子包测试各自独立」→「30 个包各自独立」。
6. `agent-group/src/main.ts:104-107`：`readService` 注释改写为「`inject` 只声明 `["tools"]`（注册面必需），其余服务可选读取，故回退路径必须自吞异常」，删除「故意不写 inject」「按设计不注册工具 + 一次警告」的旧表述。
7. `herdr-use/docs/BACKLOG.md`：已完成条目改为一行关闭注记（提交 `5121690` + 证据）。

## 偏差

1. **计划外文件（3 个，同类残留）**：`grep -rn "TUI#[0-9]"` 全仓扫描发现 `TUI/docs/COMMANDS.md:14`（`/continue 为 TUI#1 新增`）、`TUI/docs/design/NOTICE-LEVELS.md:131`（`TUI#17`）、`TUI/docs/COMMANDS-SPEC.md:73`（`TUI#10 起`）也是同类旧编号引用——原遗留条目只写了 DESIGN.md 的 15 处。按「同一口径一次清干净」处理（各 1 处、纯删除编号），记在此处。
2. **`docs/BACKLOG.md` §4 表清空而非删节**：保留标题与表头，表体换成一行说明，方便下次加包续写。
3. **计数口径用「包」不用「模块」**：旧文里「29 个模块」「30 个模块」两种口径并存（前者 = TUI + 插件总数、后者 = 误把插件数当模块数），本次统一为「31 个包 = TUI + 30 插件」，与 `AGENTS.md` 一致。
4. **未做**：`~/.dsh/profiles/fff` 的 output-compress 过渡 `sessionDir` 行（工作区外只读）；`docs/STATUS.md`（用户择时更新）。

## 测试与证据

| 命令 | 结果 |
|---|---|
| `npm --prefix agent-group run check` | exit 0（`tsc -p tsconfig.json --noEmit` + `tests/tsconfig.json`） |
| `npm --prefix agent-group run build` | exit 0 |
| `npm --prefix agent-group test` | **63 例全绿**（`pass 63 / fail 0`） |
| 全仓 30 包 `npm --prefix <pkg> run check`（`timer` 无 `node_modules`，环境既有问题） | 全部 exit 0 |
| `grep -rn "TUI#[0-9]" --include="*.md"`（排除 `archived/`、本文件、BACKLOG 条目正文） | **0 命中** |
| `grep -rn "29 个模块\|已审计 29\|30 个模块中的 22\|11 包子包"`（排除 `archived/` 与本文件） | 仅 BACKLOG 条目正文（历史现象描述）命中，活文档 **0 命中** |
| `docs/ARCHITECTURE-REUSE.md` §0 行数与标签计数 | **31 行**、保留 **22**、并存 **9**，与 §1 / §2 标题一致 |
| `format`（改动的 11 个文件） | 已跑，产物无额外改动 |
