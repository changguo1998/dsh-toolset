# script-interpreter（模型侧脚本解释器）

DSH 进程内集成插件。给**模型**一个执行脚本的入口（`script_run`）：把脚本正文经 stdin
交给本机解释器，收 stdout / stderr / 退出码并回填上下文。主功能是**按语言自动探测并切换
执行环境**：`languages` 不配置时逐语言探测解释器，探到即进可切换列表（缺省 python / node / sh）。

- **服务对象**：LLM。TUI 的 `$` 模式是给人用的本地 shell 模式，两者各自独立实现，
  不共享代码与配置（2026-10-16 用户裁定）。
- **与官方 `tool-bash` 的分工**：只是执行命令的话官方 bash 就够了（含沙箱围栏 / 提权审批 /
  后台作业 / spill 输出），本包的差异化在「按语言探测并切换解释器」，故 `bash` 后端
  **不参与自动探测**，要启用需显式写进 `languages`。
- **不做**：REPL / 跨调用状态保持 / 持久 PTY / 交互式驱动 / `sandbox_permissions` 提权参数。

## 工具面

唯一注册项 `script_run`（参数面照官方 bash 工具镜像，去掉提权与后台作业两项）：

| 参数 | 必填 | 口径 |
| --- | --- | --- |
| `script` | 是 | 脚本正文；空串报错。经 stdin 交给解释器，不落临时脚本文件 |
| `description` | 是 | 5 至 10 词，界面展示用；空串报错 |
| `language` | 否 | 取值限于已启用的语言（schema 的 `enum` 即该表：缺省为自动探测到的语言）；缺省 = 启用的首个 |
| `workdir` | 否 | 缺省 = 沙箱策略解析出的工作区根（普通会话即会话 cwd）；相对路径按该根解析 |
| `timeoutMs` | 否 | 缺省 30s，上限 10min（超过上限按上限执行，非正数报错） |

传未启用的语言（如 `bash`，它不参与自动探测）→ 明确报错并列出可用语言，**不静默回落**。
参数校验先于能力检查（先报「参数不合法」，再报「解释器缺失」）。

## 配置

| 配置项 | 缺省 | 说明 |
| --- | --- | --- |
| `languages` | 未配置 = 自动探测 | 显式给出时严格按此表（可收窄，或启用不参与自动探测的 `bash`）；空数组 = 不启用任何语言 |
| `pythonPath` | 未配置 | Python 解释器路径覆盖；等价环境变量 `SCRIPT_PY_INTERPRETER` |
| `bashPath` | 未配置 | Bash 解释器路径覆盖（`bash` 需显式写进 `languages` 才启用） |
| `nodePath` | 未配置 | Node 解释器路径覆盖；等价环境变量 `SCRIPT_NODE_INTERPRETER` |
| `shPath` | 未配置 | POSIX sh 解释器路径覆盖；等价环境变量 `SCRIPT_SH_INTERPRETER` |
| `approval` | `"never"` | 逐次审批：`never`（与官方 bash 一致）或 `ask` |
| `timeoutMs` | `30000` | 缺省超时（毫秒），上限 600000 |
| `maxOutputChars` | `100000` | 单条流保留的输出上限（字符） |
| `spillPrefix` | `"dsh-script-"` | 溢出落盘的根目录前缀（路径分隔符会被净化成 `-`） |

解释器探测顺序（逐语言）：显式配置 → 环境变量 → `PATH` 候选（`python3` → `python` / `node` /
`sh`）→ 常见绝对路径。显式配置或环境变量**配了却不可执行时不再回落**（避免静默跑错解释器）。
探测结果写进 apply 日志；**缺失时不隐藏工具**：显式配置的语言即使探测失败也照常注册，
调用时返回含安装指引的错误。自动探测模式下未命中的语言不进 `enum`（装好解释器后下次装配出现），
命中一个都没有时才不注册工具并告警。`sh` 没有统一的版本开关，故不做版本探测。

**python 另按工作区探测（execute 期）**：每次调用在拿到工作目录之后，python 的探测链在
「环境变量」与「`PATH`」之间插入两项 —— ① 工作区 `.venv/bin/python`（含 `python3` 候选）；
② 无 `.venv` 但工作区是 uv 项目（有 `pyproject.toml` / `uv.lock`）且 `PATH` 有 `uv` 时，
经 `uv run -- python -c "import sys; print(sys.executable)"` **解析真实解释器路径**后执行
（单次上限 20s，超时就回落；`uv` 首次运行可能自动创建 `.venv` / 拉取解释器，属 uv 自身行为，
本包不创建虚拟环境、不改 `sys.path`）。装配期探测结果始终作为回落：工作区探测未命中就用它。

## 执行与围栏

每次执行前：`ctx.sandboxPolicy.resolve()` 取模式与工作区根 → `ctx.sandbox.confine()` 包一层 argv → spawn。三条口径：

- 围栏模式下拿不到可强制后端（`confine` 抛错）→ **fail-closed**：返回 `SANDBOX_UNAVAILABLE`，脚本**未执行**，绝不退回无围栏路径；
- `ctx.sandbox` / `ctx.sandboxPolicy` 缺失（极简 profile）→ 不围栏执行，但**结构化结果值**的 `sandbox.unavailable` 如实标注「未围栏」与原因（不静默）；装配时另在装载日志（`ctx.logger`）里告警一次，回执正文不加提示行（见下节口径）；
- `danger-full-access` → 按策略不围栏（这是解析出的策略，不是能力缺失），结果值带 `mode`，回执不加行、也不标 `unavailable`。

围栏事实判定按宿主 `dsh-sandbox` 的语义复刻（本包不 import 宿主包）：失败运行的 stderr 命中后端 `denialSignatures` → 标 `denied`（`[sandbox: file access denied under <mode> mode]`）；命中 `runnerFailureRules` → 判为运行器自身失败（`SANDBOX_UNAVAILABLE`，命令没跑）。

## 宿主接入

`inject` 只声明 `["tools"]`（工具面是硬依赖）；`sandbox` / `sandboxPolicy` / `approval` 是
**可选服务**，一律经 `ctx.get(name)` 受保护读取 —— cordis 对**未 inject** 的服务属性直读会抛
`cannot get property "<name>" without inject`，直读会在加载期把宿主炸掉；极简宿主没有 `ctx.get`
时退回 `try { ctx[name] } catch`（抛错即视为该服务不可用）。`tests/index.test.ts` 与
`tests/tool.test.ts` 用 Proxy 桩模拟该守卫钉住这条契约。

## 回执

顺序与官方 bash 同构：stdout → 独立 `[stderr]` 段 → 各标记各占一行：

```
<stdout>
[stderr]
<stderr>
[sandbox: file access denied under read-only mode]     # 仅围栏拒绝时
[interpreter: /path/to/.venv/bin/python]              # 仅解释器被工作区环境切换时
[timed out after 30000ms]                              # 仅超时时
[killed by signal: SIGTERM]                            # 被信号杀死时
[exit code: 1]                                         # 正常退出且非零时
```

- 非零退出码是**脚本的结果**，不是工具错误；超限时保留**尾部**（`maxOutputChars`），该流正文后紧跟 `[output truncated; full output: <路径>]`；无正文时回执 `(no output)`；
- `[sandbox: ...]` 只用于**围栏拒绝**；「围栏能力缺失」（没有 `ctx.sandbox` / `ctx.sandboxPolicy`）只落在结果值 `sandbox.unavailable`，不在回执里占行 —— 每次都多一行会稀释真正的标记（超时 / 退出码）；
- `[interpreter: <path>]` 只在**解释器被工作区环境切换**（进了项目 `.venv` / `uv`，或解释器路径与装配期默认不同）时占一行，提示模型这轮跑在哪个解释器上；未切换时结构化结果值的 `interpreter` 字段恒在；
- 逐次失败（参数非法 / 解释器缺失 / 审批未过 / 围栏不可用）是**预期失败值**（`{ error, code }`），回执渲染成 `script_run 失败（<code>）：<error>`。

## 超时与取消

超时 = `SIGTERM` → 宽限 1s → `SIGKILL`，作用对象是**进程组**（`detached` + `kill(-pid)`），
脚本起的子进程不会留成孤儿。调用方的取消信号走同一条终止路径。stdin 写完脚本即 EOF。

## 溢出落点与残留

仿官方 `spill-local`（决策 6）：

- 根 = `mkdtemp(<tmpdir>/<spillPrefix>XXXXXX)`（缺省 `/tmp/dsh-script-XXXXXX/`，0700），
  进程内**惰性建一次**（没有溢出就不建目录）；
- 其下按会话分桶 `session-<sha256(sessionId) 前 12 位>/`（0700）；无会话 id 落
  `session-agentless/`；
- 每次溢出新建一个 **0600** 文件，stdout / stderr 各一份；
- **不自动删**（可审计），残留交给 `/tmp` 生命周期 —— 不自造清理策略。

## 审批

`approval: "never"`（缺省，2026-10-17 用户裁定「与 bash 一致」）：普通执行不弹审批。

`approval: "ask"` 时每次执行前调 `ctx.approval.request({ agent, toolName: "script_run", callId, reason, signal })`，由宿主服务写 `approval/asked` + `approval/decided` 审计对；
只有 `allowed-once` 才执行，其余结果（含 `rejected` / `cancelled` / `unavailable`）返回
`APPROVAL_DENIED`。缺 `ctx.approval` 或没有调用方 agent 时 **fail-closed**
（`APPROVAL_UNAVAILABLE`）。

## 实现落点

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | `apply` 装配：配置解析与钳位、自动探测集合、逐语言探测、注册 `script_run`、装载日志 |
| `src/types.ts` | 公共类型 + 宿主面结构替身（沙箱 / 策略 / 审批 / 工具面） |
| `src/probe.ts` | 解释器探测（显式配置 → 环境变量 → python 工作区 `.venv` / `uv` → PATH → 绝对路径；不回落；`versionArgs` 为空则跳过版本） |
| `src/langs/python.ts` | Python 后端（`python3 -u -`） |
| `src/langs/node.ts` | Node 后端（`node -`；参与自动探测） |
| `src/langs/sh.ts` | POSIX sh 后端（`sh -s`；参与自动探测） |
| `src/langs/bash.ts` | Bash 后端（`bash -s`；不参与自动探测，需显式配置） |
| `src/sandbox.ts` | 策略解析、`confine`、fail-closed、拒绝 / 运行器失败判定 |
| `src/run.ts` | spawn、stdin 送脚本、超时与进程组清理、尾部截断、溢出落盘 |
| `src/render.ts` | 回执渲染（全函数，畸形值不抛） |
| `src/tools.ts` | `script_run` 定义与执行顺序（校验 → 语言 → 超时 → workdir → 解释器（python 按工作区重探测）→ 审批 → 围栏 → 执行 → 事实） |

## 测试

| 文件 | 覆盖 |
| --- | --- |
| `tests/index.test.ts` | bundle 契约、配置回退与钳位、`languages` 三态（自动 / 显式 / 空）、注册与降级、不注册官方工具名 |
| `tests/probe.test.ts` | 探测顺序、不回落、版本读取、可执行判定、node / sh 后端候选、python `.venv` / `uv` 工作区探测（两态 + 优先级） |
| `tests/sandbox.test.ts` | 策略解析四态、`confine` 三态、`SANDBOX_UNAVAILABLE`、拒绝 / 运行器失败判定 |
| `tests/run.test.ts` | 真实 Python 执行、stderr / 退出码、cwd、超时、取消、进程组清理、截断与落盘（0600 / 分桶） |
| `tests/tool.test.ts` | schema 与 `script` 键对拍、参数校验顺序、语言 / 解释器降级（含 node / sh 指引）、按 `language` 切换、node / sh 真实执行、python 有 / 无 `.venv` 两态真实执行与回执标记、审批三态、沙箱四态、回执渲染 |

```sh
npm --prefix script-interpreter run check   # 类型检查
npm --prefix script-interpreter run test    # 单包测试（缺对应解释器时相关用例 skip）
```

## 状态

实现与用例已按设计文档的「实现前冻结的接口」落地。**跨包的硬拒层登记不在本包**：
`security-guard` 的 `PLUGIN_COMMAND_TOOLS.script_run = { commandKeys: ["script"] }` 归
`security-guard` 自己的条目（本包只保证参数名就是 `script`，`tests/index.test.ts` 与
`tests/tool.test.ts` 钉住该键名）。实现计划与裁定见项目级
`docs/archived/2026-10-16-script-interpreter-design.md`（已归档的调研与决策记录）。
