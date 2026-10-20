# script-interpreter 语言后端（bash / node / sh）（接取条目：script-interpreter/docs/BACKLOG.md「打开 bash 语言后端与二期语言（node / sh）」）

状态：关闭　　开启：2026-10-19　　关闭：2026-10-19
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

主功能定位：**按语言自动探测并切换执行环境**（用户 2026-10-19 纠正，见调研 R6）。按 `LangBackend` 契约新增 node / sh 后端并纳入自动探测集合；bash 保留为显式启用项（官方 `tool-bash` 已覆盖命令执行面）；不改工具名与协议。验收按条目：新语言一例真实执行断言；未启用语言仍明确报错。

## 调研

来源：本 worktree 只读检视 + 本机实测（2026-10-19）+ 官方安装树与包 README（`@deepseek-ai/dsh` 0.2.0-rc.2）+ 已归档设计文档（`docs/archived/2026-10-16-script-interpreter-design.md`）。

- **R1 bash 后端现状（代码）**：`src/langs/bash.ts` 已完整实现（`bash -s` 从 stdin 读脚本、`configKey: bashPath`、`SCRIPT_BASH_INTERPRETER`、`candidates: ["bash"]`、三条常见绝对路径）；`src/index.ts:98-101` 已把它登记进 `BACKENDS`，但 `DEFAULT_LANGUAGES = ["python"]`（`src/index.ts:95`）。即「打开 bash」不欠实现，只欠决策与用例；用户配置 `languages: ["bash"]` 今天就能启用。
  - 实测：`apply(ctx, { languages: ["bash"] })` 后工具 `language` enum 为 `["bash"]`，真实执行回执正常（解释器 `/usr/bin/bash`、bash 5.2.21；stdout / stderr 分段、退出码 0、`sandbox.unavailable` 如实标注未围栏）。
- **R2 `LangBackend` 契约的扩展缺口**：`LangBackend.configKey` 是字面量联合 `"pythonPath" | "bashPath"`（`src/types.ts:32`），`apply` 用 `settings[backend.configKey]` 取解释器覆盖（`src/index.ts:204`）。新增 node / sh 必须扩这个联合，连带三处：`ScriptInterpreterConfig`（`src/types.ts:70-85`）、`ResolvedSettings` 与 `resolveSettings`（`src/index.ts:104-170`）、`INSTALL_GUIDANCE`（`src/tools.ts:46-53`，缺项会落泛化指引）。另 `src/tools.ts:439` 的工具描述硬编码「首期 Python」。→ 原计划改动文件清单缺 `src/types.ts` 与 `src/tools.ts`，需补（见决策 03 与规划）。
- **R3 官方 bash 工具面（重复度核实）**：官方 `bash` 工具在本会话可用（本节机器探测即用它执行）；`docs/host/HOST-PACKAGES.md:134` 标 `tool-bash`（已挂载）。官方 README 口径：每次新壳、`workdir` / `timeoutMs`、`run_in_background` + `job_*` 后台作业、溢出落盘、`sandbox_permissions` 提权审批、沙箱拒绝标记。与本包 bash 后端的差集只有两点：官方是 `bash -c <command>`（转义由调用方负责），本包是 stdin 原文投递 + 解释器探测 / 覆盖 / 安装指引 + schema `enum` 约束；沙箱围栏、回执标记、溢出落盘两边同构。→ bash 的功能面已被官方完整覆盖，缺省打开只会多一个模型选择点（与设计文档决策 02 的裁定同口径）。
- **R4 node / sh 的定位（2026-10-19 用户纠正后重写）**：官方安装树没有 node 执行工具（只有 `dsh-tool-bash` / `dsh-tool-bash-persistent` / `dsh-tool-pwsh`）；PTC `run_code` 仍未暴露（`dsh-ptc-runtime-node` 只是运行时缝，不产生模型工具）。**但这不是本包的立足点** —— 用户裁定：只是执行命令的话官方 bash 就够了；本包的主功能是**按语言自动探测并切换执行环境**，语言面不是「多一条命令通道」的竞争面。据此 node / sh 属于「该语言环境的可用性」，与 Python 同列，不因官方 bash 可达而降级为备用。实测（2026-10-19）：`node -`（v24.16.0）、`sh -s`、`bash -s` 三条 stdin 口径均真实执行成功，args 只需 `["-"]` / `["-s"]`，`run.ts` / `sandbox.ts` / `render.ts` 不用改。
- **R5 验收口径现状**：「未启用语言仍明确报错」已由 `tests/tool.test.ts:135` 钉住（传 bash → `LANGUAGE_NOT_ENABLED`，不静默回落）；「新语言一例真实执行断言」目前缺 bash 后端按自身 argv 的真实执行用例（`tests/run.test.ts` 只覆盖 Python 执行核）。node / sh 若落地，用例沿既有 `pyTest` 的 skip 模式（机器缺解释器时跳过）。
- **R6 定位纠正（用户 2026-10-19）**：原稿把探测写成「配置未给时的回落」、把 node / sh 列为「要用才显式配置的备用后端」，用户指出这违背设计目的 —— **自动探测与切换环境是主路径**，配置里的解释器路径只是覆盖项；机器上装了解释器，该语言就该出现在可切换列表里。设计文档决策 08 的「只补 Python 缺口」是首期范围裁定，不等于「语言面越小越好」；bash 不进缺省的理由仅是官方 `tool-bash` 已覆盖命令执行面（R3），不是「少一种语言更好」。对本次的影响：缺省 `languages` 改为探测驱动（决策 5）。

## 决策

（拟于 2026-10-19。用户确认：1a / 2a / 4a 通过；3 待确认（路径键是「覆盖」而非「启用门槛」）；5 由用户 2026-10-19 裁定 b。改选时在原处划掉并注明取代者。）

1. bash 是否进缺省 `languages`
   a. 不进：不参与自动探测，仅显式配置可启用（README 写明「官方 bash 已覆盖命令执行面」）
   b. 进缺省：与其他语言一起自动启用
   c. 删除 bash 后端
   **选定 a**。理由：官方 `tool-bash` 已挂载且实测可用（调研 R3），「只是执行命令的话 bash 就够了」（用户 2026-10-19），本包的差异化在按语言探测与切换（调研 R6）；bash 不贡献这一价值，故既不自动启用（会让模型在两个 bash 面之间选），也不删除（极简 profile 与无官方 bash 的组合仍可显式启用，调研 R1 实测现状即可用）。

2. node / sh 是否本期落地
   a. 落地 node + sh，探到解释器即自动启用（与 python 并列）
   b. 只落地 node
   c. 都不做，本任务收口为 bash 现状登记 + 文档 + bash 真实执行用例
   **选定 a**。理由：本包主功能是自动探测与切换（调研 R6），node / sh 是「该语言环境可用性」的一部分，与 Python 同列，不因官方 bash 可达而降级为备用（调研 R4）；契约本就为多语言设计（`langs/<语言>.ts` + 统一 `LangBackend`），各一个文件、核心改动只有一次性扩口（调研 R2）。估时与条目一致（0.5 天 / 语言）。

3. 解释器路径覆盖键（破「不碰 `languages` 之外的配置面」的例）
   a. 新增 `nodePath` / `shPath` 两个配置键，与 `pythonPath` / `bashPath` 完全对称
   b. node / sh 只认环境变量（`SCRIPT_NODE_INTERPRETER` / `SCRIPT_SH_INTERPRETER`），`configKey` 契约改为可选
   c. 通用 `interpreterPaths: Record<语言, 路径>` 取代四个单键
   **选定 a**。理由：探测是主路径、路径键只是覆盖，四键同形则用户与文档只记一套口径；b 让四种语言的覆盖方式不对称（文档要多写一句例外）；c 动了既有配置模型，属协议级变更，超出本条目。影响：`src/types.ts` / `src/tools.ts` 进计划清单，「明确不做」里的配置面边界相应改为「`languages` 与四个解释器路径键之外」。

4. 工具描述与安装指引
   a. 描述去掉「首期 Python」硬编码（改按已启用语言表述），`INSTALL_GUIDANCE` 补 node / sh 两条
   b. 措辞不动，新语言落泛化指引
   **选定 a**。理由：工具描述是模型唯一可见的语言面说明，硬编码与「可配置多语言」矛盾；指引缺项会让解释器缺失时的错误文案退化为泛化版。

5. 缺省语言表口径（`languages` 未显式配置时；用户 2026-10-19 裁定 b）
   a. 固定缺省 `["python"]`，其余语言靠显式配置（原方案，已否）
   b. 探测驱动：自动探测并启用除 bash 外的全部后端（python / node / sh），探到解释器即进 `language` enum；显式配置时按配置收窄（bash 也需显式配置）
   **选定 b**。理由：探测与切换是主功能，把它降级成「备用 / 要用才开」违背设计目的（调研 R6）。实现口径：`languages` 未给出 → 自动探测；显式给出（含空数组）→ 严格按配置，空数组仍是「不启用任何语言」的配置错误；自动模式下若一个解释器都没探到，则不注册工具并告警（与现状一致），显式配置的语言即使探测失败也照常进表、调用时给安装指引（保持「缺失不隐藏工具」）。

## 规划

任务拆分（2026-10-19 决策与定位纠正后细化）：

1. 配置与装配口径：`src/types.ts` 的 `configKey` 联合与 `nodePath` / `shPath` 配置字段，`languages` 语义改为「缺省 = 自动探测」（`ScriptInterpreterConfig` / `ResolvedSettings` 注释同步）；`src/index.ts` 的 `BACKENDS` 登记 node / sh、新增自动探测集合（python / node / sh，排除 bash）、`resolveSettings` 区分「未配置」与「显式配置」、`apply` 在自动模式下按探测结果装配并按可用语言生成 `enum`。
2. 新增语言后端：`src/langs/node.ts`（`node -`，`SCRIPT_NODE_INTERPRETER`）、`src/langs/sh.ts`（`sh -s`，`SCRIPT_SH_INTERPRETER`）；`src/langs/bash.ts` 仅把注释口径改为「opt-in，显式配置才启用」。
3. 工具面：`src/tools.ts` 的 `INSTALL_GUIDANCE` 补 node / sh 两条，工具描述去掉「首期 Python」硬编码、改为按可用语言表述。
4. 测试：`tests/helpers.ts` 补 node / sh 探测辅助；`tests/index.test.ts` 补 `languages` 三态（未配置 → 自动；显式 → 收窄；空数组 → 不启用）+ 多语言登记；`tests/probe.test.ts` 补 node / sh 探测（假解释器）；`tests/tool.test.ts` 补 node / sh 一例真实执行（沿 skip 模式）、按 `language` 切换、未启用语言仍明确报错。
5. 文档：`README.md` 同步主功能口径（自动探测与切换）、配置表（`languages` 语义 + 两个新键）、探测顺序、实现落点、测试表。
6. 过程记录：本追踪文档。

计划改动文件清单（决策后更新；较原预估补 `types.ts` / `tools.ts` / `helpers.ts` 与两个测试文件的点名）：

- `script-interpreter/src/types.ts`（`configKey` 联合 + `nodePath` / `shPath` 字段）
- `script-interpreter/src/index.ts`（`BACKENDS` 登记 node / sh、`ResolvedSettings`、`resolveSettings`）
- `script-interpreter/src/langs/node.ts`（新增）
- `script-interpreter/src/langs/sh.ts`（新增）
- `script-interpreter/src/langs/bash.ts`（仅注释口径）
- `script-interpreter/src/tools.ts`（安装指引 + 工具描述）
- `script-interpreter/tests/helpers.ts`（node / sh 探测辅助）
- `script-interpreter/tests/index.test.ts`（配置键解析与多语言登记）
- `script-interpreter/tests/probe.test.ts`（node / sh 探测）
- `script-interpreter/tests/tool.test.ts`（真实执行 + 未启用报错）
- `script-interpreter/README.md`（语言面 / 配置表 / 探测 / 落点 / 测试表）
- `script-interpreter/package.json`（description 的「首期 Python」文案；用户 2026-10-19 批准补入）
- `script-interpreter/cordis.patch.yml`（头部注释的「首期只启用 python」文案；同上批准）
- 本追踪文档

明确不做：bash 不参与自动探测（需显式配置）；不改工具名与协议（`script_run` 与参数键 `script` 不动，`security-guard` 登记无需变化）；配置面只加 `nodePath` / `shPath` 两个键；不做项目级环境探测（Python `.venv` / `uv` 归条目「Python venv / uv 自动探测」，node 版本管理 / `nvm` 等不在本条目，如需要另立条目）；不做 REPL / 跨调用状态保持。

## 实现记录

（2026-10-19 按修订稿实现；决策 3 按 a，另两项 01a / 02a / 04a 已确认，05b 为用户裁定。）

1. **契约扩口**：`src/types.ts` 的 `configKey` 联合扩为四键（`pythonPath` / `bashPath` / `nodePath` / `shPath`），新增 `nodePath` / `shPath` 配置字段，`languages` 注释改为「不给 = 自动探测；显式给 = 严格按表；空数组 = 不启用任何语言」；`versionArgs` 注释补「空数组 = 不做版本探测」。
2. **探测层**：`src/probe.ts` 的命中分支加一条短路 —— `versionArgs` 为空时不调 `readVersion`（`sh` 没有统一版本开关，dash 对 `--version` 报错，强行探测会把错误文案当版本写进 apply 日志）。
3. **后端**：新增 `src/langs/node.ts`（`node -`、`SCRIPT_NODE_INTERPRETER`、`node` + 三条绝对路径、`--version`）与 `src/langs/sh.ts`（`sh -s`、`SCRIPT_SH_INTERPRETER`、`sh` + 两条绝对路径、`versionArgs: []`）；`src/langs/bash.ts` 只改注释（不参与自动探测，显式配置才启用），行为未动。
4. **装配**：`src/index.ts` 用 `AUTO_LANGUAGES = ["python", "node", "sh"]` 替换 `DEFAULT_LANGUAGES`；`resolveSettings` 的 `languages` 改为可选（`undefined` = 自动，空数组保留为空）；`apply` 在自动模式下探测未命中的语言跳过并记日志（显式模式仍保留「缺失不隐藏工具」）；`ToolSettings.languages` 改用实际启用表；补导出 `nodeBackend` / `shBackend`。
5. **工具面**：`src/tools.ts` 的 `INSTALL_GUIDANCE` 补 `node` / `sh` 两条（各自带 `nodePath` / `shPath` 与环境变量名），工具描述去掉「首期 Python」硬编码，改为「按 `language` 选择已启用的解释器」。
6. **测试**：`tests/helpers.ts` 加 `nodeInfo` / `shInfo`；`tests/index.test.ts` 覆盖 `languages` 三态（未配置 = 自动、显式 = 收窄、空数组 = 不启用）+ 自动模式枚举按探测结果 + 显式含 bash；`tests/probe.test.ts` 加 node（PATH / 环境变量 / 绝对路径形态）与 sh（`versionArgs` 空即不探测版本）两条；`tests/tool.test.ts` 加 node / sh 安装指引、node 真实执行、按 `language` 切到 sh 三条。
7. **环境**：本 worktree 无 `node_modules`，把包内 `node_modules` 软链到主仓 `script-interpreter/node_modules`（`.gitignore` 覆盖，不入库）后跑 npm 脚本；构建产物落 `dist/`（同被忽略）。
8. **文档**：`README.md` 同步主功能口径（自动探测与切换）、与官方 bash 的分工（语言面而非命令执行面）、配置表（`languages` 语义 + 两个新键）、探测顺序（含 sh 不做版本）、实现落点与测试表。

## 偏差

- **新增了计划外的一处实现**：`src/probe.ts` 的「`versionArgs` 为空则跳过版本探测」。原因：`sh` 无统一版本开关（dash 对 `--version` 报错），不加这条会把错误文案当成版本写进 apply 日志；属新后端的必需配套，已同步 `types.ts` 注释与 README。证据：`tests/probe.test.ts`「sh 的 versionArgs 为空 = 不做版本探测」用例（假 sh 带参数即报错）。
- **工具描述改的是句式而非只删四个字**：原文「（首期 Python；脚本正文经 stdin…）」改为「（按 `language` 选择已启用的解释器；脚本正文经 stdin…）」，与决策 4a 的「按已启用语言表述」一致。
- **tool.test 多了一条用例**：node / sh 的安装指引按语言区分（对应决策 4a 的指引落点），原计划只写「真实执行 + 未启用报错」。
- **补入两处计划外文案**（用户 2026-10-19 批准）：`package.json` 的 description 与 `cordis.patch.yml` 的头部注释仍写「首期 Python」/「languages = ["python"]」，与新的自动探测口径矛盾；只改文案、不涉行为，已补进计划清单。
- 其余按计划落地，无未做项。

## 测试与证据

均在本 worktree 的 `script-interpreter/` 包内执行（2026-10-19）：

```sh
npm run check   # tsc -p tsconfig.json --noEmit → 通过（无输出）
npm run build   # tsc -p tsconfig.json → 通过（dist/src/langs 下生成 node / sh 的 .js / .d.ts）
npm test        # node --experimental-transform-types --test 'tests/*.test.ts'
                # → tests 79 / pass 79 / fail 0 / skipped 0（含 node、sh 真实执行）
```

真机烟测（不重启 dsh，直接以 `--experimental-transform-types` 跑真实 `apply` + 真实执行）：

- 缺省装配（无 `languages`）：`ENUM ["python","node","sh"]`；装载日志四行 ——
  `Python: /usr/bin/python3（path, Python 3.12.3）`、
  `Node: …/fnm_multishells/…/bin/node（path, v24.16.0）`、`sh: /usr/bin/sh（path）`、
  `script-interpreter ready (script_run; languages=python,node,sh; …)`。
- `language: "node"` → `exitCode 0`、`stdout "smoke-node linux\n"`、回执带解释器绝对路径；
  `language: "sh"` → `exitCode 0`、`stdout "smoke-sh\n"`。
- `language: "bash"` → `{ code: "LANGUAGE_NOT_ENABLED", error: "语言 bash 未启用：可用语言 = python / node / sh；…" }`（bash 不参与自动探测，符合决策 1）。

未覆盖 / 未跑：仓库根 `npm run check` / `npm run test`（本 worktree 其余包无 `node_modules`，无法整仓跑；本次改动全部在 `script-interpreter` 包内，包内三件已全绿）；未重启 `dsh --profile fff` 做人工确认（留给用户按 §5 点 3 执行）。残留清理：烟测用 `tmp/` 已删除；`node_modules` 为软链（gitignore 覆盖）。

## 收尾

（2026-10-19 关闭；用户经主分支会话放行关闭。）

- **人工确认真机效果**：关闭裁定前已做真机烟测（真实 `apply` + 真实 node / sh 解释器执行，证据见「测试与证据」），用户在关闭裁定中放行，视为人工确认通过。运行中 dsh 会话加载新代码需主分支合主 + 重启（由主分支通知时机）。
- **BACKLOG 清理**：`script-interpreter/docs/BACKLOG.md` 的「打开 bash 语言后端与二期语言（node / sh）」条目标记完成并从清单移除（只留未完成项「Python venv / uv 自动探测」，顺位重排为 `#1`）。
- **归档**：本追踪文档移入 `script-interpreter/docs/archived/`。
- **回写**：`README.md` 已随实现同步（主功能口径、配置表、探测、落点、测试表）；`package.json` description 与 `cordis.patch.yml` 注释已按用户批准补正；`STATUS.md` 由用户择时更新，本流程不改。
- **遗留**：Python venv / uv 自动探测为独立条目（追踪文档 `2026-10-19-script-interpreter-venv.md`，另一任务）；node 项目级环境探测（`.nvmrc` / `fnm` / `nvm` 等）不在本条目，如需要另立条目。
- **收尾提交**：提交点 4 完成本次变更的最后一次提交（记录见 git 历史）。
