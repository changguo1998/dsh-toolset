# 登记两个新插件工具的命令参数面（接取条目：`security-guard/docs/BACKLOG.md`「登记两个新插件工具的命令参数面（`script_run` / `herdr_pane`）」）

状态：决策（2026-10-17）　　开启：2026-10-17　　关闭：未关闭
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮范围：调研 + 决策，不写实现代码（用户 2026-10-17 指示：在本会话内开工三个模块条目、不开新 worktree、做完决策后停下等审阅）。工作区：主检出 `main`。

## 目标

把两个待落地新插件的命令文本参数纳入 `security-guard` 的硬拒层：在 `PLUGIN_COMMAND_TOOLS` 登记 `script_run` 与 `herdr_pane`，使脚本正文与注入 pane 的命令 / 文本 / 按键串命中命令黑名单层时被 deny，非命令参数不误拦。

## 调研

来源：`security-guard/src/index.ts`、`security-guard/scripts/tool-surface-check.mjs`、`security-guard/README.md`、`security-guard/tests/`、`docs/implementation/2026-10-16-script-interpreter-design.md`、`docs/implementation/2026-10-16-herdr-pane-design.md`；实测（`npm test` 124 例全绿、`git worktree list`、包目录存在性核查）。

1. **登记表现状**（`src/index.ts:249-257`）：只有 `metric_loop: { commandKeys: ["measureCmd"] }` 与 `task_decompose: { commandPaths: ["children[].executor.command", "children[].acceptance[].command"] }` 两条。`TOOL_SURFACE.registered`（`:323-340`）由 `...Object.keys(PLUGIN_COMMAND_TOOLS)` 等五组并集排序而成 —— 加两条后自动随动，`TOOL_SURFACE` 本身不用改。
2. **`commandKeys` 与 `commandPaths` 是两种提取面，可同时登记**（接口 `:229-237`、提取器 `pluginCommands` `:667-684`）：`commandKeys` 取顶层参数里 `typeof === "string"` 且非空的值；`commandPaths` 走点号路径、段名带 `[]` 表示该值是数组并逐元素展开。两者在同一登记项里并存、各自带来源参数路径（`:667-684` 顺序拼接）。
3. **`commandKeys` 对数组值静默失效（本次关键发现）**：`:672-677` 的分支只收 `string`。实测（子代理在本包内跑引擎）：`metric_loop` 传 `measureCmd: "rm -rf /"` → deny，传 `measureCmd: ["rm -rf /"]` → 放行。而 `herdr_pane` 的 `keys` 是**字符串数组**（herdr-pane 设计 `:228`，例 `["ctrl+c"]` / `["esc"]` / `["up"]`）—— 按设计原文写 `commandKeys: ["keys"]` 会形成**假覆盖**：名字在册、运行时不检查。
4. **登记即脱离未登记工具策略**：门禁分支条件是 `plugin === undefined && commandTool === undefined`（`:1059`），工具一旦登记，`unknownToolPolicy` 对它不再生效。
5. **差异检查脚本扫不到本仓插件包**（`scripts/tool-surface-check.mjs:757-856`、`:1006-1008`）：它只扫宿主安装树里的 `@deepseek-ai/dsh-tool-*`（无条件）与 `lib/index.js` 含 `defineTool(` 的其它官方包，且**只比工具名**、从不校验参数键；本仓插件以 `@dsh-toolset/*` 挂在 profile 的 `node_modules` 下，scope / 包名 / 入口三项都不满足，实测不在面内。故 `docs/implementation/2026-10-16-script-interpreter-design.md:45` 的「一致性由 `scripts/tool-surface-check.mjs` 校验」对本仓两包**不成立**（本轮按「途中发现新问题」登记为项目级条目）。
6. **两份设计给出的工具面**：`script_run` 的工具名与参数名已冻结 —— script-interpreter 设计 `:111`「包 `script-interpreter` + 工具 `script_run`」、`:81`「**必须**在 `PLUGIN_COMMAND_TOOLS` 登记 `script_run` 的 `script` 键（与 `run_code` 的 `code` 同口径，命中即 deny）」、`:127`「加 `script_run: { commandKeys: ["script"] }`」；`herdr_pane` 为单工具 + 十动作（herdr-pane 设计 `:141`、`:222`），命令面参数是 `run` 的 `command`、`send_text` 的 `text`、`send_keys` 的 `keys`（`:224-232`），`:235` 建议 `PLUGIN_COMMAND_TOOLS.herdr_pane = { commandKeys: ["command", "text", "keys"] }` 并注明「保守口径：`keys` 一并纳入，误拦代价低于漏拦」。
7. **前置未满足**：主检出与两个 worktree（`.worktree/script-interpreter` @ `4e8f812`、`.worktree/herdr-pane` @ `12df60e`）下都没有 `script-interpreter/` 与 `herdr-pane/` 包目录，两侧的 `security-guard/src/index.ts:249-257` 与主树逐字相同 —— 登记尚无对应工具存在，参数面无法对着实现核对。
8. **测试面**：四文件 124 例（`blacklist` 9 / `guard` 86 / `script` 22 / `sensitive` 7），实测全绿。`TOOL_SURFACE` 用例只断言「已排序 + 固定名单 includes + 三类键不重叠」（`tests/guard.test.ts:2261-2286`），`commandPaths` 防呆用例断言「解析出的路径字面量 ≥ 2 条、且不含 `[][]`」（`:2413-2433`，新增 `keys[]` 后为 3 条，仍通过）—— 新增两条登记不会打破既有用例。判定的可测性来自引擎按「工具名 + 入参」判定（`guard.inspect`），**无需真实工具存在即可写用例**。
9. **文档随动面**：`README.md:13` 的命令黑名单表格行列了现有两条登记、`:21` 的「插件命令面」段同口径、`:228` 的例数计数（124）—— 加两条后三处都要同步。

## 决策

决策项 1　`herdr_pane` 的 `keys` 用哪个字段登记

- a) 照设计原文 `commandKeys: ["command", "text", "keys"]`（`keys` 静默失效，形成假覆盖）
- b) `commandKeys: ["command", "text"]` + `commandPaths: ["keys[]"]`（数组逐元素展开，设计意图真正生效）
- c) 不登记 `keys`（按键序列不是 shell 命令串）

**选定 b**。理由：设计 `:235` 的口径是「保守纳入」，b 是唯一能让该口径真正生效的写法（调研 3、2）；c 会让 `send_keys` 完全没有命令层门禁，而 `keys` 的取值不受 herdr 语义约束（herdr 侧只校验按键名是否存在，不校验内容安全）。误拦风险实测上不存在：按键名（`ctrl+c` / `esc` / `up`）不会命中命令黑名单规则；真被拦的情形是把黑名单命令串当按键传，那正是要拦的。

决策项 2　`text` 是否算命令面

- a) 纳入（同设计 `:235`）
- b) 不纳入（`text` 是纯文本注入）

**选定 a**。理由：`run` 与 `send_text` 的差别只在是否补回车（herdr-pane 设计 `:34`），不纳入 `text` 等于给 `run` 留一条旁路。

决策项 3　`script_run` 的 `script` 口径

- a) `commandKeys: ["script"]`（同设计 `:81`、`:127`，与官方 `run_code` 的 `code` 同口径）
- b) 按「代码键」只做路径提取（`src/index.ts:288` 的代码键集含 `script` / `code` / `program`，check 模式下只抽路径）

**选定 a**。理由：与 `run_code` 一致（`src/index.ts:1045-1048` 同口径）；b 需要给 `PluginCommandTool` 扩字段、与 `run_code` 分叉，换来的只是「Python 源码里出现 `sudo` 字面词时不拦」这点少误拦。

决策项 4　登记时机（前置未满足，见调研 7）

- a) 现在登记两条
- b) 等两个包落地后随其实现批次登记
- c) 现在只登记 `script_run`，`herdr_pane` 等落地

**选定 b**。理由：`README.md:22` 的既有口径是「按**真实**参数面在对应登记表登记」，而 `keys` 的假覆盖刚证明「照设计字面写」并不可靠 —— 真正能核对的时点是实现落地时（设计自己也写「参数名以两包实现时的真实工具面为准」）。代价照实记：某个包落地到登记生效之间存在无防护窗口，缓解有两条 —— 两份设计的「计划改动文件清单」都已列出这次跨包登记（script-interpreter `:127-128`、herdr-pane `:263`），且 herdr-pane 是三闸并用（`:183`，另有 `guard.inspectCommand` 自查）。
**若改选 a**：登记形态按决策项 1 至 3 落地，并在 `README.md` 的登记表行注明「登记早于两包实现，落地后核对参数面」。

决策项 5　一致性靠什么钉住

- a) `tests/guard.test.ts` 加用例（工具名在册 + 键提取生效 + 非命令键不误拦）
- b) 扩 `scripts/tool-surface-check.mjs`，增加扫本仓插件包的覆盖面
- c) 人工核对

**选定 a**。理由：调研 5 已证脚本对本仓给不出保障；b 要改脚本固定的覆盖边界文案（`:64-67`）并承担 21 个包的噪声与假覆盖口径调整，属另一条条目的事；a 是唯一能同时验证「名字在册」与「键真的被提取」的手段。

## 规划

本轮（调研 + 决策）改动文件清单：

- `security-guard/docs/BACKLOG.md`（本条目标〔进行中: 2026-10-17〕）
- `security-guard/docs/implementation/2026-10-17-command-tool-registration.md`（本文件）
- `docs/BACKLOG.md`（「途中发现新问题」：追加一条项目级条目 —— script-interpreter 设计文档 `:45` 的一致性表述与实况不符）

实现阶段（待决策项 4 裁定后执行）改动文件清单：

- `security-guard/src/index.ts`：`PLUGIN_COMMAND_TOOLS` 加 `script_run: { commandKeys: ["script"] }` 与 `herdr_pane: { commandKeys: ["command", "text"], commandPaths: ["keys[]"] }`
- `security-guard/tests/guard.test.ts`：新增用例 —— `script_run`（黑名单命中 deny / 敏感路径 deny / 普通脚本放行 / 参数缺失或非 string 放行 / `allowPatterns` 放行）、`herdr_pane`（`run:command` 命中 / `send_text:text` 命中 / `send_keys:keys[]` 命中 / 非命令键不误拦 / 读类动作放行）、`TOOL_SURFACE` 名单 includes 断言
- `security-guard/README.md`：`:13` 表格行、`:21` 插件命令面段、`:228` 例数

明确不做：不改 `unknownToolPolicy` 的语义与缺省值（三态与 allowlist 保持原样）；不加按键白名单校验（新语义，属另议）；不改 `scripts/tool-surface-check.mjs` 的覆盖边界（属另条条目）；不改两份设计文档（其它任务的文件）；不动 `PLUGIN_FILE_TOOLS`。

## 实现记录

（本轮为决策轮，未进入实现；待决策项 4 裁定后按「规划」的清单执行。）

## 偏差

无（本轮只做调研与决策，未承诺实现动作）。

## 测试与证据

本轮为决策轮，未改代码，故未跑 `check` / `build` / `test`；调研阶段的实测证据：

- `security-guard` 内 `npm test`：124 例全绿（`tests 124 / pass 124 / fail 0`）—— 作为「新增登记不会打破既有用例」的基线（用例面见调研 8）。
- `git worktree list`：`.worktree/script-interpreter`（`4e8f812`）与 `.worktree/herdr-pane`（`12df60e`）存在；两处根下 `ls -d script-interpreter herdr-pane` 均报「没有那个文件或目录」，两侧 `security-guard/src/index.ts:249-257` 与主树逐字相同（调研 7）。
- `commandKeys` 数组值失效、`commandPaths` 单层 `[]` 展开生效：由子代理在本包内直接跑 `GuardEngine` 实测（构造 `metric_loop.measureCmd` 字符串 / 数组两种入参与 `task_decompose.children[].acceptance[].command`）。

## 收尾

- 本轮不归档：条目保持〔进行中: 2026-10-17〕，本文件留在 `security-guard/docs/implementation/`，等用户对决策项 4 的裁定后再决定「就地实现」或「复位为等前置」。
- 回写文档：本轮无（实现阶段才动 `README.md`）。
- 遗留项：决策项 4 待裁定；`herdr_pane` 落地时需按真实参数面复核 `commandKeys` / `commandPaths` 的两处写法。
