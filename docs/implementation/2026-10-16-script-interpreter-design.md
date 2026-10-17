# 脚本语言解释器插件(bash / python 等): 调研与决策

状态: 调研 / 决策　　开启: 2026-10-16　　关闭: -
本文件是本任务唯一的过程记录与文档变更落点; 计划外的文件不改.

## 接取范围

本任务接取项目级 `docs/BACKLOG.md` 的以下条目(按标题引用, 不写编号):

- `脚本语言解释器插件(bash / python 等)`(进行中: 2026-10-16) —— 本任务只做调研与决策, 不写实现代码.

本任务不含实现; 形态与范围裁定后另立实现条目.

用户裁定(2026-10-16): 形态与范围**已确认** —— 维持本文件的十项决策; 首期**不做 REPL / 状态保持**, **不做 TUI 跑脚本模式或命令**.

## 目标

对条目"接取时裁定"的 6 个问题逐项给出调研结论与最终决策, 产出可实现的落点, 验收与估时, 并把仍需用户裁定的点单独列出. 本回合只交文档.

## 调研

来源: 本 worktree 只读检视 + 全局安装树 `0.2.0-rc.2` 的官方包 README 与类型声明 + 一次真机调用实测.

### S1 本仓现状: 没有自有的脚本执行面

- TUI `$` 模式是**人用**的本地非交互执行: `spawn(command, { shell: true })`, 30s 超时(SIGTERM → 宽限 1s → SIGKILL), 单流 2 万字符截断; 输出只进 buffer(`kind="shell"`), **不进会话与模型上下文, 不过审批链**; 执行前经 `ctx.get("guard").inspectCommand(command, "tui:$")` 复查, guard 不可用时 fail-open 并留痕(`TUI/src/app/local-shell.ts:96-163`, `:250-301`; 口径见 `TUI/docs/DESIGN.md` 输入区段).
- `task-engine` 的 `command` executor 是 `/bin/sh -c` 加机械验收(退出码 0 = 通过), 不是通用脚本面(`task-engine/src/main.ts:91-113`; `task-engine/src/types.ts:27`, `:52`).
- 本仓 21 个插件包 + TUI 均无 `bash` / `python` 类执行工具; `security-guard` 的白名单里已有 `run_code`(代码文本整体过黑名单)与插件命令工具登记表(`security-guard/src/index.ts:162-163`, `:249-257`), 说明"代码文本过黑名单"是既有口径, 可直接沿用.

### S2 官方执行面: bash 已完整, Python 缺口

- **`tool-bash` 已挂载且可用**(不是"未核实"): `dsh-base/cordis.patch.yml:267-269` 注册 `- id: tool-bash` + `disabled: !!js process.platform === 'win32'`, fff profile(`~/.dsh/profiles/fff/package.json` 的 `dsh.profile.bundles` 首选 `@deepseek-ai/dsh-base`)与用户 patch 都**没有**禁用该行; `docs/host/HOST-PACKAGES.md:134` 亦标已挂载. **真机实测**: 本 worktree 会话内调 `bash` 工具执行 `printf` 成功返回, `pwd` 为 worktree 根 —— 该工具在本 profile 可用, 且**普通调用不弹审批**.
- 审批触发点在**提权**而非普通执行: `dsh-tool-bash` 只在 `sandbox_permissions` 升级时经 `ctx.approval` 取同意(`dsh-tool-bash/lib/index.js:351-370`); `dsh-bash-sandbox` 自身不发起审批(README "Deny-only at the seam").
- 沙箱执行器 = `bash-sandbox`(`ctx.shell`, 每条命令经 `ctx.sandbox.confine()`); 沙箱不可强制时 **fail-closed** 抛 `SANDBOX_UNAVAILABLE`, 绝不无围栏执行. `ctx.sandbox.confine(argv, policy, signal?) → Promise<ConfinedArgv>`; `ctx.sandboxPolicy.resolve(request?) → SandboxExecutionPolicy`(`dsh-sandbox/lib/types/index.d.ts:141`; `dsh-sandbox-policy/lib/types/index.d.ts:88`).
- 输出口径可复用: stdout → 带标记的 `[stderr]` 段 → 截断提示 / 沙箱拒绝标记 / 超时 / 信号 / `[exit code: N]`, 每项独占一行; 超限**保留尾部**并把全文落 spill 文件并给路径.
- 其他相关行: `jobs-local` + `tool-jobs` 给 bash 提供后台作业; `terminal` + `terminal-bash` 由 fff 追加挂载(**持久 PTY 会话后端**), 但模型面 `tool-bash-persistent` **未挂载**; `tool-pwsh` 仅 Windows 启用.
- **PTC 的 `run_code` 当前未暴露**: `dsh-tools` 行无 `config`, `mode` 取默认 `native`; `run_code` 只在 `ptc` / `both` 下出现, 且要有已注册 SDK 渲染器的 `ctx.ptcRuntime`(`dsh-tools/README.md:64`, `:127`, `:233`). `ptc-runtime-node` 已挂载但只是运行时缝, 不产生模型工具. Python 侧官方另有**未分发**的私有包 `dsh-experimental-ptc-runtime-python`(全新 CPython 子进程, 无文件围栏; `dsh-ptc-runtime/README.md:45`), 不可依赖.
- 结论: **bash 已被官方覆盖且完整**(沙箱 / 提权 / 后台作业 / 输出口径 / 审计), Python **完全没有**模型侧执行面 —— 这正是本插件的缺口.

### S3 本仓插件接宿主工具面的既有做法

- 注册: `apply(ctx, config)` 里 `ctx.tools?.register(def)`, `ctx.tools` 缺失时告警降级不抛错(`ast-tools/src/index.ts:161-178`, `md-logic/src/index.ts:77-84`, `hash-edit/src/main.ts:362-371`).
- 依赖探测与降级: 显式配置 → 环境变量 → PATH → 本地 `node_modules/.bin`; 缺失时**插件不崩**并注册带安装指引的降级工具(`ast-tools/src/binary.ts:1-52`, `:161-178`).
- 子进程清理: `SIGTERM` → 宽限 1s → `SIGKILL`, stdin `ignore` 防挂死(`TUI/src/app/local-shell.ts:111-133`).
- 硬拒层登记: 新工具带命令文本参数时, 必须在 `security-guard` 的 `PLUGIN_COMMAND_TOOLS` 登记, 否则"未登记工具缺省不拦"(`security-guard/README.md:22`, `:143`); 一致性由 `security-guard/scripts/tool-surface-check.mjs` 校验.
- 契约来源: `ctx.tools` 注册面见 `docs/host/DSH-CTX-API.md`; 服务面清单见 `docs/host/HOST-PACKAGES.md`.

### S4 计数与落点校正

条目写"新包(第 22 或第 23 个插件)", 依据的是 TUI + 19 包口径. 现状是 TUI + **21** 个插件包(`AGENTS.md` 结构与约定; `WORKFLOW-STANDARD.md:11` 的"19 个"为旧值), 故本插件是**第 22 个插件**. `docs/BACKLOG.md` §4 插件规划表在形态裁定后需补一行(本任务不动它, 见"规划").

## 决策

决策项 = 数字, 选项 = abcd, 选定项写字母与理由.

01. 形态
    a. 模型侧工具(agent 调用并把结果回上下文)
    b. 会话内 REPL(多轮状态保持)
    c. TUI 本地执行模式扩展(`$` 之外的新模式, 不经模型)
    d. 仅作测试基底
    **选定 a**. 理由: 用户要的是"让 agent 能用几种脚本语言", 只有模型侧工具能把执行结果回填进上下文; REPL 的状态保持与"能不能执行"正交, 属另一个问题(见决策 9); c 也不做: `$` 模式是 **TUI 内部给人用**的输入模式,**本插件是模型侧工具(给 LLM 用)** —— 两者服务对象不同, 本任务评估后不推荐把执行面塞进 TUI; d 已有 `smokePty.mjs` 与 `demo/`, 无需新包. **用户裁定(2026-10-16): 不做 REPL, 亦不做 TUI 跑脚本模式** —— b / c 在首期与本项目内均不实现.

02. 语言集合与首期范围
    a. 首期全上(python / bash / node / sh)
    b. 首期只 Python; 语言表可扩展, bash 后端随首期实现但**缺省关闭**
    c. 首期 Python + node
    d. 首期只做 bash(补齐自有沙箱口径)
    **选定 b**. 理由: bash 已被官方 `tool-bash` 完整覆盖(含沙箱围栏 / 提权审批 / 后台作业 / spill 输出), 再暴露一个 bash 只会分散模型选择并多一个登记点; node 的定位与官方 `run_code` 的 TypeScript 程序面重叠而后者当前未暴露, 首期不做以免与未来解禁冲突; `sh` 由 Python 的 `subprocess` 覆盖, 单列无收益. 语言后端按"每种语言一个模块 + 统一 `LangBackend` 接口"落地, 二期加语言不动协议.

03. 包的划分
    a. 一个多语言包带 `language` 参数
    b. 每种语言一个包
    c. 双包(核心 + 语言适配包)
    **选定 a**. 理由: 三者的探测 / 超时 / 截断 / 沙箱 / 回执渲染 / 测试夹具几乎全同, 拆包会让同一套语义复制两三份并有口径漂移风险; 语言差异收进 `langs/<语言>.ts` 模块即可, 真到需要独立发包(如某语言要独立依赖)再拆.

04. 执行环境接入(沙箱 / 硬拒层 / 审批)
    a. `ctx.sandbox.confine()` + `security-guard` 登记 + 逐次审批
    b. 复用 `ctx.shell`(即 `bash -c` 包一层)
    c. 直接 `spawn`, 只过 `security-guard`
    d. 只走审批, 不进沙箱
    **选定 a**, 组成: ① 每次执行前 `ctx.sandboxPolicy.resolve()` 取模式与工作区根, 再 `ctx.sandbox.confine(argv, policy)`; 围栏模式拿不到可强制后端 → 按 bash 同款 **fail-closed**(`SANDBOX_UNAVAILABLE`, 不无围栏执行); `ctx.sandbox` 缺失(极简 profile)→ 在结果里标 `sandboxed: false`(能力缺失时**如实标注而不静默**, 与 bash 执行器在无沙箱组合下不激活同口径; 这是模型侧工具, 不沿用 TUI 内部模式的做法). ② `security-guard` 硬拒层: 新工具带代码文本, **必须**在 `PLUGIN_COMMAND_TOOLS` 登记 `script_run` 的 `script` 键(与 `run_code` 的 `code` 同口径, 命中即 deny). ③ 审批链: 逐次审批缺省**关闭**(见决策 7). 理由: bash 的"拒绝 → 提权 → 审批"阶梯是官方既定路径, 而 `confine()` 是官方围栏原语; 用 b 会把 Python 包成 `bash -c`, 语义与错误都变模糊.

05. 依赖探测与缺依赖降级
    a. 严格: 二进制缺失则不注册该语言
    b. 全量注册, 缺依赖时返回带安装指引的错误
    c. 缺失即整个插件不挂载
    **选定 b**. 理由: 探测顺序 = 显式配置 → 环境变量(如 `SCRIPT_PY_INTERPRETER`)→ PATH(`python3` → `python`)→ 常见绝对路径; 探测结果写进插件 apply 日志(可用语言与解释器路径 / 版本). 缺失时"工具在但调用明确报错"比"工具静默消失"好排障, 与 `ast-tools` 的降级工具做法一致; Python 的 `venv` / `uv` 自动探测列二期, 首期只提供解释器路径覆盖(避免自作主张改 `sys.path`).

06. 输出口径与截断
    a. 逐字复刻 bash 口径, **独立**输出上限
    b. 向宿主 spill 缝注册(dsh-spill), 复用其文件与提示
    c. 复用 `.dsh/` 会话级目录, 由宿主清理
    **选定 a**. 理由: stdout → 独立 `[stderr]` 段 → 截断 / 超时 / 信号 / `[exit code: N]` 各一行, 超限**保留尾部**并把全文落盘, 正文附文件路径(便于模型再读); 单次输出上限首期 10 万字符, 可配置; 超时缺省 30s, 上限 10min, 逐次 `timeoutMs` 可覆盖. 全文落盘**仿照官方 `spill-local`**: 根 = `mkdtempSync(join(tmpdir(), "<spillPrefix>"))`（缺省 `/tmp/dsh-script-XXXXXX/`, 目录 0700）, 其下按会话分桶 `session-<sha256(sessionId) 前 12 位>/`, 每次新建一个 **0600** 文件; 正文给路径, **不自动删**（可审计）—— 残留交给 `/tmp` 生命周期, 不自造清理策略（落点与残留口径见“规划”的“实现前冻结的接口”; 对照出处 `dsh-spill-local/lib/index.js:17`、`:35`、`:70`、`:73`）. 不选 b 是因为 `spill`(缝)**未挂载**(`docs/host/HOST-PACKAGES.md:21`), 而 `spill-local` + `spill-policy` 虽已挂载, 其语义是"全文落私有会话目录 + 按 token 预算保留头尾", 与本工具"保留尾部 + 全文路径"的口径不同 —— 接它会把两套语义耦合在一起, 故自管落盘.

07. 逐次审批
    a. 不引入逐次审批(与 bash 对齐)
    b. 缺省逐次审批, 可配置关闭
    c. 只对 `danger-full-access` 前的提权审批
    **选定 a + c**. 理由: 普通执行不弹审批; 首期**不暴露** `sandbox_permissions` 提权参数(要提权就改变会话策略或走官方 bash), 因而不需要提权审批; 审批面在配置里留 `approval: never | ask`(缺省 `never`), 需要更强约束的部署改一个字段即可. **用户裁定(2026-10-17): 缺省和 bash 一致** —— 即保持 `never`(bash 只在提权时经 `ctx.approval` 取同意, 本包无提权参数, 故也无审批面).

08. 与 TUI `$` 模式 / 官方执行面 / `ptcRuntime` 的分工
    a. 新包同时补齐三者
    b. 只做 TUI 侧新模式
    c. 明确分工: 不重复官方 bash, 只补 Python 缺口, 不做 REPL / 持久化, 不改 TUI
    d. 只做 REPL
    **选定 c**. 理由: **`$` 模式是给用户(人)用的 TUI 输入模式, 本插件是给 LLM 用的模型侧工具** —— 服务对象不同, 不重叠也不用合并; 官方 bash 已覆盖 shell 命令, 本包**不注册 bash 语言**(策略见决策 2); `ptcRuntime` 是"模型写 TypeScript 程序调用宿主工具"的编排面, 本包是"跑一段脚本拿输出"的执行面, 交集只在都调子进程; 官方若解禁 `run_code`, 本包价值仍在 Python(官方 Python 后端未分发). REPL / 状态保持 / 交互式驱动不做 —— `terminal` + `terminal-bash` 已在 profile 里提供持久 PTY 底座, 真要做属另立条目(见"后续候选条目"). **用户裁定(2026-10-16): 本包不改 TUI, 不做 REPL, 也不做 TUI 侧跑脚本入口**. 两者是**各自独立的实现**: `$` 模式归 TUI, 本插件归本包, 互不引用, 不共享代码与配置, 也不做"常量收敛到一处"的联动.

09. 命名与落点
    a. 包 `script-interpreter` + 工具 `run_script`
    b. 包 `python-runner` + 工具 `python_exec`
    c. 包 `script-interpreter` + 工具 `script_run`
    **选定 c**. 理由: 包名与条目标题对齐且不锁死语言; 工具名沿用本仓"域在前, 动作在后"的既有风格(`md_logic` / `ast_query` / `hash_edit` / `code_map`), 避免将来与宿主的 `run_code` / `run_script` 撞名. 首期只有 Python, 但 `languages: ["python"]` 是显式配置, 加语言不改工具名.

10. 工具面与提示词落点
    a. 只注册工具
    b. 工具 + `system-prompt/assemble` 注入一段用法提示
    c. 工具 + 注册 `presentAs` 展示
    **选定 a**. 理由: 首期只一个工具, schema 自解释, 注入提示是净增 token 与维护面; 若实测发现模型不会用(例如忘了传 `script` 而想跑一行命令), 二期再补 `system-prompt` 段. 工具的 UI 展示走宿主既有工具行渲染(与 `ast_query` 同款最小 render).

## 规划

### 实现前冻结的接口（消费方按此写）

**工具 `script_run`（唯一注册项）** —— 参数面照官方 bash 工具镜像（键名与描述取自 `dsh-tool-bash/lib/index.js:490-524`）:

| 参数 | 必填 | 口径 |
| --- | --- | --- |
| `script` | 是 | 脚本正文; 空串报错（对应 bash 的 `command`） |
| `description` | 是 | 5 至 10 词, UI 展示用; 空串报错 |
| `language` | 否 | 取值限于**配置里已启用**的语言; 缺省 = 启用的首个（首期即 `python`）; 传未启用语言（如 `bash`）→ 明确报错, 不静默回落 |
| `workdir` | 否 | 缺省会话工作区; 相对路径按工作区解析 |
| `timeoutMs` | 否 | 缺省 30s, 上限 10min |

**不镜像的三项**: `sandbox_permissions` 与 `justification`（决策 7 不暴露提权参数）; `run_in_background`（首期无后台作业面, 要做得二期另立）。

**配置面**: `languages: ["python"]`（启用的语言; bash 后端随首期实现但**不在表内**）· `pythonPath?`（解释器路径覆盖, 对应环境变量 `SCRIPT_PY_INTERPRETER`）· `approval: "never" | "ask"`（缺省 `never` —— 2026-10-17 用户裁定「缺省和 bash 一致」）· `timeoutMs` 缺省与 `maxOutputChars`（缺省 10 万）· `spillPrefix?`（缺省 `dsh-script-`）。

**执行与围栏**: `ctx.sandboxPolicy.resolve()` 取模式与工作区根 → `ctx.sandbox.confine(argv, policy)`; 拿不到可强制后端 → **fail-closed** `SANDBOX_UNAVAILABLE`（绝不无围栏执行）; `ctx.sandbox` 缺失 → 回执标 `sandboxed: false`（如实标注, 不静默）。

**回执**: stdout → 独立 `[stderr]` 段 → 截断 / 超时 / 信号 / `[exit code: N]` 各一行; 超限**保留尾部** + 全文落盘路径。

**溢出落点（仿官方 `spill-local`）**: 见决策 6 的改写段 —— `/tmp/dsh-script-XXXXXX/session-<hash12>/` + 0600 文件 + 不自动删。

**登记（归 `security-guard` 的条目, 本包不重复改）**: `PLUGIN_COMMAND_TOOLS` 加 `script_run: { commandKeys: ["script"] }`; 动作归条目「登记两个新插件工具的命令参数面（`script_run` / `herdr_pane`）」, 本包只保证键名 `script` 与之一致。

### 落点(实现阶段)

- 新包 `script-interpreter/`(第 22 个插件): `package.json` 的 `dsh.bundle` 契约 + `cordis.patch.yml`(模板照 `ast-tools` / `md-logic`); `src/` 分 `index.ts`(apply + 语言表装配 + 日志), `langs/python.ts`, `probe.ts`(二进制探测), `sandbox.ts`(policy 解析 + confine + fail-closed 分类), `run.ts`(spawn / 超时 / 进程组清理), `render.ts`(输出回执), `types.ts`.
- `README.md`(模块契约; 轻量包口径: 首期不建 `docs/DESIGN.md`, 机制变厚再补)+ `docs/BACKLOG.md`.
- 实现时需改的**既有文件**(各一处, 属跨包改动, 实现任务开工前需在条目里写明):
  - `security-guard/src/index.ts` 的 `PLUGIN_COMMAND_TOOLS` 加 `script_run: { commandKeys: ["script"] }`;
  - `security-guard` 的 `tool-surface-check.mjs` 扫描面(若其键集来源需要同步);
  - 三处包清单同批改: `scripts/install.sh`(如需新包随装), 根 `package.json` 的 check / build / test 链, `scripts/test-parallel.sh` 的包清单 —— 三处有强一致断言(见 `~/.dsh/profiles/fff/cordis.patch.yml` 的 ponytail 注释), 漏改会被 CI 拦住;
  - `docs/BACKLOG.md` §4 插件规划表补一行.
- TUI 侧**不动**(决策 8).

### 首期明确不做

- 不注册 bash 语言(缺省关闭, 后端随首期实现以便二期一个开关打开).
- 不做 node / sh 语言; 不做 REPL 与跨调用状态保持; 不做持久 PTY; 不做交互式驱动(按键 / 取屏).
- 不做 `sandbox_permissions` 提权参数; 不做 Python `venv` / `uv` 自动探测; 不做 TUI 新模式或命令.

### 验收细化(实现阶段用)

- 语言与降级: Python 一例执行断言(`print` 与重定向写文件); 解释器缺失时调用返回含安装指引的错误, 插件仍挂载(断言工具已注册 + 错误文案).
- 输出口径: 非零退出码断言(结果含 `[exit code: N]` 且不是工具错误); 超时断言(超时被杀, 结果标超时); 截断断言(超阈值保留尾部 + 全文落盘路径可读); stderr 单独成段.
- 沙箱: `read-only` 下写工作区被拒并标围栏模式; 围栏模式无可用 runner 时 fail-closed(`SANDBOX_UNAVAILABLE`, 未执行); `danger-full-access` 下不限制.
- 硬拒层: 脚本正文含黑名单命令(如 `sudo`)时 deny, 且**未执行**(与 `run_code` 同口径断言).
- 审批: 缺省不产生 `approval/asked`; `approval: ask` 时产生 `approval/asked` + `approval/decided` 审计对.
- 与官方面不重叠: 断言本包不注册 `bash` / `run_code` 工具名.

### 任务拆分（6 步, 每步带中间验证）

1. **起包骨架 + 既有文件接线** —— `package.json`（`dsh.bundle`）/ `cordis.patch.yml`（照 `ast-tools` / `md-logic`）/ `tsconfig.json` / `README.md` / `docs/BACKLOG.md`; 三处包清单（根 `package.json`、`scripts/test-parallel.sh`、`scripts/install.sh`）+ §4 表补行。验证: 根 `check` / `build` 通过, 空实现时工具表里不出现 `script_run`。
2. **探测与降级**（`probe.ts`）—— 配置 → 环境变量 → PATH（`python3` → `python`）→ 常见绝对路径; 探测结果写 apply 日志。验证: 验收「语言与降级」两条（一例执行 + 缺失时报错但仍挂载）。
3. **执行核**（`sandbox.ts` + `run.ts`）—— policy 解析、`confine`、fail-closed 分类、超时与进程组清理（SIGTERM → 宽限 1s → SIGKILL, stdin `ignore`）。验证: 验收「沙箱」两条 + 「输出口径」的非零退出与超时两条。
4. **溢出落盘（仿官方）** —— 根与 `session-<hash12>` 分桶、0600 文件、回执拼路径。验证: 验收「输出口径」的截断一条（保留尾部 + 路径可读）。
5. **回执渲染 + 硬拒层联调**（`render.ts`）—— 与 `security-guard` 的登记对拍。验证: 验收「硬拒层」（含提权类命令的脚本被 deny 且**未执行**）+ 「与官方面不重叠」（不注册 `bash` / `run_code`）。
6. **文档与真机** —— README（模块契约: 参数表、落点与残留口径、审批开关）。验证: 验收「审批」一条 + 该包 `test` 全绿 + 真机一次。

### 估时

实现 1 至 1.5 天(Python 后端 + 探测降级 + 沙箱 / 守卫接线 + 回执渲染 + 测试); 文档与包骨架另计半天. 条目原判 1 至 2 天仍在区间内; 不选 REPL 是主要省时项.

### 实现阶段的验证口径（怎么跑）

「验收细化」列的是**验什么**, 这里列**怎么跑**:

- **单测**: `npm --prefix script-interpreter run test` —— 假 ctx（`ctx.tools` / `ctx.sandbox` / `ctx.sandboxPolicy` 三件可替身）覆盖降级、围栏分类、回执与截断; 解释器存在时跑一例**真实执行**（`print` 与重定向写文件）, 缺失时 skip 并在输出里注明。
- **机械**: 根 `npm run check` + `npm run build` + `npm run test` 三件全绿; `scripts/install.sh --dry-run` 的清单含本包。
- **真机**: 重启 `dsh --profile fff`, 调一次 `script_run` 跑 `print`, 再故意造一次大输出核对回执里的落盘路径可读, 并确认 `/tmp/dsh-script-*` 生成。
- **不做**: 不验 REPL / 状态保持（首期不做）; 不验提权（未暴露该参数）; 不验 bash 后端执行（缺省关闭, 只断言「传未启用语言即报错」）。

### 收尾动作（实现完成时）

- 条目「脚本语言解释器插件(bash / python 等)」标「完成」并从 `docs/BACKLOG.md` 移除（若实现另立条目, 两处一并处理）; 本文件移入 `docs/archived/`。
- 文档回写: 根 `README.md` + `README.zh.md`（插件清单与包数）、`AGENTS.md`（第 22 个插件与结构段）、`docs/BACKLOG.md` §4 插件规划表补一行; **包计数与 §4 表的统一**归条目「五个新插件落地时的仓库清单与包计数统一」。
- `security-guard` 侧的登记行归它自己的条目（「登记两个新插件工具的命令参数面（`script_run` / `herdr_pane`）」）, 本任务不重复改。
- 临时文件: `/tmp/dsh-script-*` 残留按「不自动删」口径保留, 已在 README 记明落点与残留责任。
- 遗留: 语言后端二期（bash 打开开关、node / sh）; REPL / 持久 PTY / 交互式驱动（另立条目）; 逐次审批若改为 `ask` 属配置缺省值变更。

## 已裁定的开口项（原「待用户裁定」）

1. **首期语言面**（2026-10-16）：只 Python，bash 后端随首期实现但缺省关闭（决策 2）。
2. **REPL / 状态保持**（2026-10-16）：首期不做（与官方 `run_code` 拒绝持久 kernel 同口径，见 `dsh-tools/README.md:235`），将来要做另立条目。
3. **TUI 侧「跑脚本」模式**（2026-10-16）：不做；将来要做属 TUI 模块条目。
4. **逐次审批**（2026-10-17，用户「缺省和 bash 一致」）：`approval` 缺省 `never`（普通执行不弹审批），要逐次过面板的部署自行改 `ask`（配置项保留）。

仍待裁定：**无**。

## 后续候选条目(本任务不登记, 供后续裁定)

- 持久 REPL / 交互式驱动条目(底床已在 profile: `terminal` + `terminal-bash`, 模型面工具 `tool-bash-persistent` 未挂载).

## 实现记录

- 2026-10-16 用户裁定形态与范围(模型侧工具; 首期只 Python; 单包不拆分; 不做 REPL; 不做 TUI 跑脚本), 已写进"接取范围"与决策 1 / 8 / 9.
- 2026-10-16 用户澄清"`$` 模式是给用户用的, 本插件是给 LLM 用的": 决策 1 / 8 的定位理由按此改写; 决策 4 与决策 6 里"与 `$` 模式同口径 / 同档"的类比去掉(两者是各自独立的实现, 不共享代码与配置, 不做常量收敛); "后续候选条目"删掉对齐那条.
- 2026-10-16 用户要求完整复述要点并确认("可以"): 复述与文档一致, 仅补记本条并修正决策 6 关于 spill 的事实(缝包 `spill` 未挂, 但 `spill-local` + `spill-policy` 已挂).
- 2026-10-17 用户裁定逐次审批缺省「与 bash 一致」(`approval: never`): 决策 7、冻结接口的配置面与「待用户裁定」三处已同步, 该节不再有待裁定项。
- 本任务不写实现代码.

## 偏差

- 计划中"核实宿主是否挂 `terminal-bash`"已完成(未挂载, 详见 S2); 此外**未改任何**包代码与 TUI, 与计划一致.
- 条目原估"第 22 或第 23 个插件"更正为第 22 个(计数依据见 S4), 属调研结论而非偏差.

## 测试与证据

- 官方挂载面: `grep -n "id: tool-bash" -A 2 <dsh 安装树>/dsh-base/cordis.patch.yml` → `267-269` 行, 唯一禁用条件是 `process.platform === 'win32'`; `~/.dsh/profiles/fff/cordis.patch.yml` 无对应禁用行.
- 真机可用性: 本 worktree 会话内调 `bash` 工具执行 `printf 'probe-ok\n'; echo "CWD=$(pwd)"` → 返回 `probe-ok` 与 `CWD=/home/guochang/Projects/dsh-toolset/.worktree/script-interpreter`, **未弹审批**.
- 围栏契约: `dsh-sandbox/lib/types/index.d.ts:141` 的 `abstract confine(argv, policy, signal?) => Promise<ConfinedArgv>`; `dsh-sandbox-policy/lib/types/index.d.ts:88` 的 `resolve(request?) => SandboxExecutionPolicy`.
- PTC 未暴露: `dsh-tools/README.md:64`(mode 默认 `native`), `:233`(非 native 模式需已注册 SDK 渲染器的运行时), `:235`(持久 kernel 在 MVP 被拒).
- 本机依赖: `python3` = `/usr/bin/python3`(Python 3.12.3), `python` = `~/.local/bin/python`, `node` v24.16.0, `bash` 5.2.21, 均在 PATH.
- 本任务未跑构建与测试(无代码改动); 无临时文件残留(`/tmp/dumpfff.*` 已删).

## 收尾

- 回写文档: 本追踪文档(新建); 项目级 `docs/BACKLOG.md` 的条目状态本任务**不写**(接取时已由上一任务标"进行中: 2026-10-16"), 关闭时随实现任务一并处理.
- 遗留项: 「已裁定的开口项」4 项全部落定（末项 2026-10-17）; 「后续候选条目」1 项待用户决定是否登记.
- 本文件**不移入** `archived/`(任务未关闭, 等实现条目完成后随关闭一起归档).
