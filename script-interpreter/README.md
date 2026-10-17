# script-interpreter（模型侧脚本解释器）

DSH 进程内集成插件。给**模型**一个执行脚本的入口（`script_run`）：把脚本正文经 stdin
交给本机解释器，收 stdout / stderr / 退出码并回填上下文。首期只启用 **Python**。

- **服务对象**：LLM。TUI 的 `$` 模式是给人用的本地 shell 模式，两者各自独立实现，
  不共享代码与配置（2026-10-16 用户裁定）。
- **与官方 `tool-bash` 的分工**：shell 命令归官方 bash（含沙箱围栏 / 提权审批 / 后台作业 /
  spill 输出），本包不注册 bash 工具、不重复该面；只补官方没有的 Python 执行面。
- **不做**：REPL / 跨调用状态保持 / 持久 PTY / 交互式驱动 / `sandbox_permissions` 提权参数。

## 工具面

唯一注册项 `script_run`（参数面照官方 bash 工具镜像，去掉提权与后台作业两项）：

| 参数 | 必填 | 口径 |
| --- | --- | --- |
| `script` | 是 | 脚本正文；空串报错。经 stdin 交给解释器，不落临时脚本文件 |
| `description` | 是 | 5 至 10 词，界面展示用；空串报错 |
| `language` | 否 | 取值限于配置里已启用的语言（schema 的 `enum` 即该表）；缺省 = 启用的首个 |
| `workdir` | 否 | 缺省 = 沙箱策略解析出的工作区根（普通会话即会话 cwd）；相对路径按该根解析 |
| `timeoutMs` | 否 | 缺省 30s，上限 10min（超过上限按上限执行，非正数报错） |

传未启用的语言（如首期传 `bash`）→ 明确报错并列出可用语言，**不静默回落**。
参数校验先于能力检查（先报「参数不合法」，再报「解释器缺失」）。

## 配置

| 配置项 | 缺省 | 说明 |
| --- | --- | --- |
| `languages` | `["python"]` | 启用的语言；bash 后端随包实现但缺省不在表内 |
| `pythonPath` | 未配置 | Python 解释器路径覆盖；等价环境变量 `SCRIPT_PY_INTERPRETER` |
| `bashPath` | 未配置 | Bash 解释器路径覆盖（bash 未启用时不生效） |
| `approval` | `"never"` | 逐次审批：`never`（与官方 bash 一致）或 `ask` |
| `timeoutMs` | `30000` | 缺省超时（毫秒），上限 600000 |
| `maxOutputChars` | `100000` | 单条流保留的输出上限（字符） |
| `spillPrefix` | `"dsh-script-"` | 溢出落盘的根目录前缀（路径分隔符会被净化成 `-`） |

解释器探测顺序：显式配置 → 环境变量 → `PATH`（`python3` → `python`）→ 常见绝对路径。
显式配置或环境变量**配了却不可执行时不再回落**（避免静默跑错解释器）。探测结果写进
apply 日志；**缺失时不隐藏工具**：调用返回含安装指引的错误，插件照常挂载。

## 执行与围栏

每次执行前：`ctx.sandboxPolicy.resolve()` 取模式与工作区根 → `ctx.sandbox.confine()`
包一层 argv → spawn。三条口径：

- 围栏模式下拿不到可强制后端（`confine` 抛错）→ **fail-closed**：返回
  `SANDBOX_UNAVAILABLE`，脚本**未执行**，绝不退回无围栏路径；
- `ctx.sandbox` / `ctx.sandboxPolicy` 缺失（极简 profile）→ 不围栏执行，但回执与结果值
  **如实标注**「未围栏」与原因（不静默）；
- `danger-full-access` → 按策略不围栏（这是解析出的策略，不是能力缺失），回执只带模式。

围栏事实判定按宿主 `dsh-sandbox` 的语义复刻（本包不 import 宿主包）：失败运行的 stderr
命中后端 `denialSignatures` → 标 `denied`（`[sandbox: file access denied under <mode> mode]`）；
命中 `runnerFailureRules` → 判为运行器自身失败（`SANDBOX_UNAVAILABLE`，命令没跑）。

## 回执

顺序与官方 bash 同构：stdout → 独立 `[stderr]` 段 → 各标记各占一行：

```
<stdout>
[stderr]
<stderr>
[sandbox: file access denied under read-only mode]     # 仅围栏拒绝时
[timed out after 30000ms]                              # 仅超时时
[killed by signal: SIGTERM]                            # 被信号杀死时
[exit code: 1]                                         # 正常退出且非零时
```

- 非零退出码是**脚本的结果**，不是工具错误；
- 超限时保留**尾部**（`maxOutputChars`），该流正文后紧跟
  `[output truncated; full output: <路径>]`；
- 无正文时回执 `(no output)`；
- 逐次失败（参数非法 / 解释器缺失 / 审批未过 / 围栏不可用）是**预期失败值**
  （`{ error, code }`），回执渲染成 `script_run 失败（<code>）：<error>`。

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
| `src/index.ts` | `apply` 装配：配置解析与钳位、逐语言探测、注册 `script_run`、装载日志 |
| `src/types.ts` | 公共类型 + 宿主面结构替身（沙箱 / 策略 / 审批 / 工具面） |
| `src/probe.ts` | 解释器探测（四级顺序、不回落、版本读取） |
| `src/langs/python.ts` | Python 后端（`python3 -u -`） |
| `src/langs/bash.ts` | Bash 后端（`bash -s`；随包实现但缺省不启用） |
| `src/sandbox.ts` | 策略解析、`confine`、fail-closed、拒绝 / 运行器失败判定 |
| `src/run.ts` | spawn、stdin 送脚本、超时与进程组清理、尾部截断、溢出落盘 |
| `src/render.ts` | 回执渲染（全函数，畸形值不抛） |
| `src/tools.ts` | `script_run` 定义与执行顺序（校验 → 语言 → 超时 → workdir → 解释器 → 审批 → 围栏 → 执行 → 事实） |

## 测试

| 文件 | 覆盖 |
| --- | --- |
| `tests/index.test.ts` | bundle 契约、配置回退与钳位、注册与降级、不注册官方工具名 |
| `tests/probe.test.ts` | 四级探测顺序、不回落、版本读取、可执行判定 |
| `tests/sandbox.test.ts` | 策略解析四态、`confine` 三态、`SANDBOX_UNAVAILABLE`、拒绝 / 运行器失败判定 |
| `tests/run.test.ts` | 真实 Python 执行、stderr / 退出码、cwd、超时、取消、进程组清理、截断与落盘（0600 / 分桶） |
| `tests/tool.test.ts` | schema 与 `script` 键对拍、参数校验顺序、语言 / 解释器降级、审批三态、沙箱四态、回执渲染 |

```sh
npm --prefix script-interpreter run check   # 类型检查
npm --prefix script-interpreter run test    # 单包测试（无 Python 时相关用例 skip）
```

## 状态

实现与用例已按设计文档的「实现前冻结的接口」落地。**跨包的硬拒层登记不在本包**：
`security-guard` 的 `PLUGIN_COMMAND_TOOLS.script_run = { commandKeys: ["script"] }` 归
`security-guard` 自己的条目（本包只保证参数名就是 `script`，`tests/index.test.ts` 与
`tests/tool.test.ts` 钉住该键名）。实现计划与裁定见项目级
`docs/implementation/2026-10-16-script-interpreter-design.md`。
