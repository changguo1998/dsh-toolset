# herdr pane 交互式命令扩展（接取条目：docs/BACKLOG.md「基于 herdr 的交互式命令扩展（herdr pane 读写）」）

状态：规划　　开启：2026-10-16　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
接取范围（按条目标题列出，不写 BACKLOG 编号）：docs/BACKLOG.md「基于 herdr 的交互式命令扩展（herdr pane 读写）」。
本轮范围：先只做**调研与决策**（不写实现代码、不改包代码）；2026-10-16 已获用户放行（含可选动作），实现待本轮文档检查通过后开始。

## 目标

把 herdr 的 pane 当作**可控伪终端层**：新建 pane、向 pane 注入文本与按键、读取 pane 屏幕、等待输出，使需要「屏幕状态 + 按键时序」的交互式命令（TUI 程序、REPL、安装器、需要应答的命令）可被程序化驱动；并回答条目「接取时裁定」的七个问题（能力面 / 形态与共包 / 降级 / 生命周期 / 取屏与等待 / 安全边界 / 与相邻条目的分工）。

非目标（本轮）：不做实现；不对 herdr 提需求；不改 `herdr-integration` 现有行为；不做 TUI 面板。

## 调研

来源标注：**实测** = 本机只读命令的真实输出；**官方技能** = `herdr --skill` 输出的官方 agent 指南；**schema** = `herdr api schema --json`（protocol 22 / schema_version 1）；**仓库** = 本仓文件与文档。

### 1. 本机环境与版本（实测）

- herdr 二进制：`/home/guochang/.local/bin/herdr`（`herdr --version` → `herdr 0.9.5`）。
- `herdr status`：client / server 均 0.9.5，protocol 22，`endpoint_compatible: yes`，socket `/home/guochang/.config/herdr/herdr.sock`。
- 握手环境变量（本会话 `env` 实测，比 `herdr-integration/README.md:42` 记的三项多三项）：`HERDR_ENV=1`、`HERDR_SOCKET_PATH`、`HERDR_PANE_ID`、`HERDR_TAB_ID`、`HERDR_WORKSPACE_ID`、`HERDR_BIN_PATH=/home/guochang/.local/bin/herdr`。
- 本 dsh 进程跑在 `HERDR_PANE_ID=wT1:p1` 的 pane 内；`herdr pane list` 实测列出 14 个 pane，元素含 `pane_id` / `tab_id` / `workspace_id` / `cwd` / `agent` / `agent_status` / `revision` / `scroll` 等字段。

### 2. 能力面：创建 / 发送 / 读取齐备（实测 + schema）

`herdr pane --help` 列出 25 个子命令；`herdr api schema --json` 的 `request.oneOf` 共 **102 个 socket method**（其中 `pane.*` 35 个、`agent.*` 12 个、`events.*` 2 个）。逐项对照如下（**核实**列写明核实方式）：

| 需求 | CLI 面 | socket method | 核实 |
| --- | --- | --- | --- |
| 新建 pane | `herdr pane split [PANE_ID] [--pane ID] [--current] --direction right\|down [--ratio F] [--cwd PATH] [--env K=V] [--focus\|--no-focus]` | `pane.split` | 帮助已读；**未执行创建**（避免改动用户布局） |
| 注入文本 | `herdr pane send-text <ID> <TEXT>` | `pane.send_text` | 帮助已读；未执行 |
| 注入按键 | `herdr pane send-keys <ID> <KEY>...`（`esc` 为规范名、`escape` 亦收） | `pane.send_keys` | 帮助已读；未执行 |
| 文本 + Enter | `herdr pane run <ID> <COMMAND>...`（帮助注明 = 发送文本并回车，一次调用） | 组合（`send_text` + `send_keys`） | 帮助已读；未执行 |
| 取屏 | `herdr pane read <ID> --source visible\|recent\|recent-unwrapped\|detection [--lines N] [--format text\|ansi] [--raw]` | `pane.read`（参数 `strip_ansi` 缺省 true；结果含 `revision` / `truncated`） | **实测**：本 pane `--source visible --lines 5` 与外部 shell pane `--source recent-unwrapped --lines 4` 均返回纯文本 |
| 等输出 | `herdr pane wait-output <ID> (--match TEXT\|--regex PATTERN) [--source] [--lines N] [--timeout MS] [--raw]` | `pane.wait_for_output` | **实测**两种形态：命中（成功 JSON，含 `matched_line` 与 `result.read`），`--timeout 400` 未命中 → stderr `{"error":{"code":"timeout","message":"timed out waiting for output match"}}`，exit 1 |
| 关闭 pane | `herdr pane close <pane_id>` | `pane.close` | 帮助已读；未执行 |
| 列表 / 详情 | `herdr pane list [--workspace ID]` / `get <id>` / `current` / `layout [--pane]` / `process-info [--pane\|--current]` | 同名（`pane.list` / `get` / `current` / `layout` / `process_info`） | **实测**：`list` / `get` / `current` / `layout`（area 与 splits）/ `process-info`（`foreground_processes`、`shell_pid`） |
| 归属标记 | `herdr pane rename <pane_id> [LABEL]` | `pane.rename` | **schema**：`PaneInfo.label` 为可空字段；未执行 rename |
| 事件推送 | 无 CLI 包装 | `events.subscribe` / `events.wait`（另有 `pane.output_matched` / `pane.agent_status_changed` 等事件） | **schema**；本方案未使用 |

补充实测事实：

- **错误形态统一**：`herdr pane get wT1:p999` → stderr `{"error":{"code":"pane_not_found","message":"pane wT1:p999 not found"},"id":"cli:pane:get"}`，exit 1；官方技能另记「CLI 语法错 exit 2」。
- **`pane read` 的 CLI 输出是纯文本，不带 JSON 信封**（故 CLI 路径拿不到 `revision` / `truncated`）；`pane wait-output` 与 `pane list` 等返回 JSON 信封。
- **对调用者所在 pane 做匹配会自命中**：在 dsh 自己的 pane 上跑 `pane wait-output wT1:p1 --match "zz-absent-zz"` 立即「命中」，命中的是 dsh 界面里回显的本次命令行文本。→ 取屏/匹配不应以调用者 pane 为目标。
- 另有 `pane focus/resize/zoom/swap/move/neighbor/edges/scroll/input/clear/edit_scrollback/report-metadata` 与 `agent list|get|read|send-keys|prompt|wait|start|...`（驱动「被 herdr 识别的 agent」，本条目不需要）、`tab/workspace/worktree` 面；`--machine` / `--session` 可指向其它服务器或命名会话（本条目不使用）。
- 官方技能（`herdr --skill`，与本方案直接相关的口径）：以安装的二进制为语法权威；`--no-focus` 用于后台工作；用 `--current` / 显式 pane id / 唯一 agent 名，不依赖别的客户端焦点；ID 从 JSON 响应里解析；**不要关闭不是自己创建的 pane/tab/workspace/session**；`read` 的 source 选择（`visible` 视口 / `recent` 含软换行 / `recent-unwrapped` 拼接软换行、日志与转录首选 / `detection` 检测用底缓冲）；`--format ansi` 仅在需要颜色证据时用；alternate-screen 的行不进普通 scrollback。

**结论**：条目需要的六项能力（建 pane、发文本、发按键、取屏、等输出、关 pane）herdr 0.9.5 **全部具备**，CLI 与 socket 双面可用；**缺的只有两处小事**——CLI 的 `pane read` 不返回 `revision`（socket 有，可用文本比对替代）、没有「批量关闭某次运行创建的 pane」命令（本地登记 + 逐个 `close` 即可）。**无需向 herdr 提需求，也无需自建底层。**

### 3. 形态与包划分

- 仓库既有的模型侧工具先例：`ast-tools`（`ctx.tools.register(def)`，def = `{ name, description, parameters, execute(args, exec), output{schema, render} }`，`ast-tools/src/tools.ts:1-6`、`ast-tools/src/index.ts:161-178`）、`md-logic`（单工具 + action 分派）。工具第二参数 `exec` 带 `agent` / `callId` / `signal`（`dsh-tools/lib/index.js:3299-3313`）。
- 仓库既有的「库面 + 工具面」双出口先例：`ast-tools`（`index.ts` 库面、`tools.ts` 工具面）；包间直接依赖已有先例（`memory-base/package.json:33` → `md-logic`、`code-map/package.json:14` → `ast-tools`、`md-map/package.json:14` → `md-logic`）。
- 新包接线面（按最近一次新包 `md-table-check` 的提交面）：根 `package.json`（check / build 两链）、`scripts/test-parallel.sh`（`default_pkgs`）、`scripts/install.sh`（`canonical_pkgs`）、`AGENTS.md`（模块清单与计数）、`README.md` / `README.zh.md`（插件清单）、包自身文件、以及 profile 挂载（本机用户侧 + 仓库 `profiles/example/` 可选）。

### 4. 非 herdr 环境的降级口径

- 现有 `herdr-integration` 口径：握手三变量缺一即**静默空转**，不注册任何监听、无副作用（`herdr-integration/src/herdr.ts:73-86`、`herdr-integration/README.md:83`）。
- 反面对照先例：`ast-tools` 在二进制缺失时**注册降级工具**（调用返回含安装指引的错误，`ast-tools/src/index.ts:161-172`），口径是「能力可发现、调用即报错」。
- 二者差异的根因：`ast-tools` 的缺失是**本机可修**（装 ast-grep 即可），而「不在 herdr 环境内」是**运行位置决定的**——注册一个必然失败的工具只会让模型反复试错并污染工具面。

### 5. pane 生命周期与残留

- 创建返回新 pane id（官方技能：读 `.result.pane.pane_id`，不要从界面顺序推断）；`herdr pane list` 的 `label` 字段可作**归属标记**（`pane rename`）；pane id 关闭后不复用（官方技能）；`pane close` 会结束该 pane 内的进程。
- 现存残留风险有两类：dsh 正常退出（可由插件主动清理）与 dsh 崩溃 / 被 `kill -9`（插件来不及清理，只能靠标记事后识别）。
- 现有退出兜底先例：`herdr-integration` 的 `releaseSync()` 用 `spawnSync` 在 `process.exit` 回调里尽力送达（`herdr-integration/src/herdr.ts:167-180`），3s 超时——pane 关闭可复用同一形态。

### 6. 取屏与等待判定

- 等待由**服务端**完成：`pane wait-output` 先搜既有输出再轮询，支持字面量/正则，可选 `--timeout`（缺省无限等）——不需要自建轮询循环，也不需要 socket 事件订阅。
- 「屏内容不再变化」的静默判定：CLI 路径无 `revision`，用**两次读取文本比对**（间隔 ≥ `settle_ms`，连续相同即判稳，外层 `timeout_ms` 兜底）。
- 取屏 source 的语义差异见 §2 官方技能条目；alternate-screen 程序（vim / htop）的 `recent-unwrapped` 可取性**未实测**（官方技能只说 alternate-screen 行不进普通 scrollback）。

### 7. 安全边界（宿主接口与既有先例）

- 宿主审批链：`tools/pre-execute` 是**可重排 waterfall**，监听器可返回 `{kind:"ask", reason}`，宿主随后经 `ctx.approval.request({agent, toolName, callId, reason, signal})` 路由到审批 UI（`dsh-tools/lib/index.js:3226` 的 `serviceAsk`；`docs/host/DSH-CTX-API.md:83-91`）；无审批服务 / 无 agent 时**fail-closed**（`dsh-tools/lib/index.js:3439-3458`）。另有单调守卫 `ctx.tools.guard`（waterfall 之后、后注册者不能翻盘），`security-guard` 挂在它上面（`security-guard/README.md:5`）。
- `security-guard` 的覆盖是**显式白名单**：官方文件/命令工具 + 两张插件登记表（`PLUGIN_FILE_TOOLS` / `PLUGIN_COMMAND_TOOLS`），未登记的工具名缺省**不拦**，且明确要求「新增插件工具需按真实参数面在对应登记表登记」（`security-guard/README.md:22`）；另有服务面 `ctx.get('guard').inspectCommand(command, source)`（`security-guard/src/index.ts:783`）。
- TUI `$` 模式的先例：不经模型、不占审批链，但执行前**主动复查一次** `guard.inspectCommand(command, "tui:$")`，命中即不执行；guard 缺失 / 抛错则告警一次后照常执行（fail-open，`TUI/src/app/local-shell.ts:1-12`）。
- **本插件的特殊性**：命令在 herdr 服务端的 pane 里执行，跑在 dsh 进程之外，**不受 dsh 的文件沙箱约束**；因此不能指望沙箱兜底，必须显式设计闸门（guard 复查 + 目标 pane 归属 + 可选审批）。
- 官方 bash 工具的口径可作参照：命令执行**不逐次审批**，只有请求更宽沙箱权限时才走 `ctx.approval`（`dsh-tool-bash/README.zh.md:68,102`）。

### 8. 与相邻条目的分工

- **TUI `$` 模式**（`TUI/src/app/local-shell.ts`）：人用、非交互、不经模型、占不到 pane；与本插件不重叠。
- **条目「脚本语言解释器插件（bash / python 等）」**：一次性非交互执行，收 stdout / stderr / 退出码；本插件只解决「需要屏幕状态与按键时序」的场景；二者不重叠（一条命令能跑完的用解释器，需要看屏幕/按键的用 pane）。
- **条目「基于 tmux 的交互式命令扩展（模拟交互式命令执行）」**：目标同构、底床不同（tmux vs herdr）。两包若共用，需要先抽底床抽象层，而两条目正在不同 worktree 并行推进——共用会让两边互相阻塞并把抽象做在信息最少的时候。
- **条目「同事模型群组的编排协议」**（其底床依赖 tmux / herdr 两个交互式命令扩展之一）：需要一个可编程的底床面（建/发/读/等/关）。本包**导出库面**即可供其 `link:` 依赖直接调用，不必经模型工具。

## 决策

决策项 1　herdr 控制通道

- a) 全走 `herdr` CLI 子进程（`spawn` 参数数组，不拼 shell 字符串）
- b) 全走 unix socket 协议（扩展现有 `src/herdr.ts` 那类客户端）
- c) 混合：缺省走 CLI，仅在 socket 有优势处走 socket
- d) 自建底层（直接写终端/绕过 herdr）

**~~选定 a~~ → 选定 c**（2026-10-16 用户裁定：按 CLI 为主的混合方案，socket 有优势的项用 socket，否则用 CLI；原「全走 CLI」的初稿结论被取代，理由与划分记在下）。

划分依据：socket 相对 CLI 的**硬优势只有一处** —— `pane.read` 返回 `revision` / `truncated`，而 CLI 的 `pane read` 只输出纯文本；其余维度或平手（错误形态 / 原子提交 / 大输出 / 多服务器），或 CLI 占优（参数校验失败更早、漂移面更浅、退出清理天然同步、代码与测试面更薄）。安全面 socket 略优（无子进程、无 PATH 依赖），但 CLI 侧用 `HERDR_BIN_PATH` 钉死绝对路径 + argv 数组（不过 shell）即可抵消，不构成改走 socket 的理由。

逐动作划分表（2026-10-16 用户确认的定稿版）：

| 动作 | 通道 | 落地形态 | 额外信息 | 依据 | 实现落点 | 首期 |
| --- | --- | --- | --- | --- | --- | --- |
| `create` | CLI | `herdr pane split --current --direction <right/down> --cwd <path> --no-focus`，取 `.result.pane.pane_id` | 新 pane id | 平手，socket 无独有信息 | `cli.ts` + `actions.ts` | 必需 |
| `create` 选方向 | CLI | `herdr pane layout --pane <caller>` 读宽高 | area / splits | 平手 | `cli.ts` + `actions.ts` | 必需 |
| `list` | CLI | `herdr pane list [--workspace]` | pane 摘要与 label | 平手 | `cli.ts` + `actions.ts` | 必需 |
| `read` | **socket** | `pane.read {pane_id, source, lines, format, strip_ansi}` | `revision` / `truncated` | socket 唯一硬优势 | `socket.ts` | 必需 |
| `wait` 的 match / regex | CLI | `herdr pane wait-output <id> --match / --regex --timeout` | 成功信封内已含 `read` 与 `revision` | 平手，服务端轮询两侧同源 | `cli.ts` + `actions.ts` | 必需 |
| `wait` 的 stable | **socket** | 反复 `pane.read`，相邻两次 `revision` 相同即判稳 | `revision` | 派生自 read 的硬优势，CLI 只能比文本 | `socket.ts` + `actions.ts` | 必需 |
| `send_text` | CLI | `herdr pane send-text <id> <text>` | 无 | 平手 | `cli.ts` + `actions.ts` | 必需 |
| `send_keys` | CLI | `herdr pane send-keys <id> <key>...`（herdr 侧先校验全部按键） | 无 | 平手 | `cli.ts` + `actions.ts` | 必需 |
| `run` | CLI | `herdr pane run <id> <command>`（文本 + Enter 一次提交） | 无 | 平手，socket 的 `pane.send_input` 更灵活但首期不需要 | `cli.ts` + `actions.ts` | 必需 |
| `close`（工具调用） | CLI | `herdr pane close <pane_id>` | 无 | 平手 | `cli.ts` + `actions.ts` | 必需 |
| `close`（退出清理） | CLI | `spawnSync(herdr, ["pane","close",id])` | 同步送达 | CLI 胜，socket 要手写内联子进程 | `main.ts` + `registry.ts` | 必需 |
| 标归属 | CLI | `herdr pane rename <id> <label>` | label | 平手 | `cli.ts` + `registry.ts` | 可选（**已纳入**） |
| 进程探活 | CLI | `herdr pane process-info --pane <id>` | `foreground_processes` / `shell_pid` | 平手 | `cli.ts` + `actions.ts` | 可选（**已纳入**） |

「可选」两行按 2026-10-16 用户裁定（「可选的也做」）**一并纳入首期**，故动作集为十个：`create | list | read | wait | send_text | send_keys | run | label | info | close`（其中 `label` 即标归属、`info` 即进程探活）。

CLI 仍为**缺省通道**：新增动作若两侧皆可，一律先走 CLI，保持实现面与测试面最小。

决策项 2　产出形态

- a) 模型侧工具（同时导出库面供其它包复用）
- b) TUI 命令 / 面板
- c) 仅测试基底（给冒烟与集成测试用）
- d) a + b

**选定 a**。理由：驱动的发起方是 agent（条目期望「可被程序化驱动」）；人在 herdr 里有原生界面与 CLI，再包一层 TUI 命令是重复投入；测试基底不可取——仓库测试与 CI 不保证 herdr 存在（现有冒烟用 `script` 分配 PTY，`TUI/demo/smokePty.mjs:1-20`），把测试绑到 herdr 会把偶发外部依赖引进门禁。库面同时导出，供编排类插件与真机验证脚本直接调用（对齐 `ast-tools` 的双出口）。

决策项 3　包划分

- a) 新建独立包 `herdr-pane`（`@dsh-toolset/herdr-pane`），与 tmux 条目各自成包
- b) 与 tmux 条目共用一个「双底床」包
- c) 并入现有 `herdr-integration` 包

**选定 a**。理由：本包带执行面与安全闸门，`herdr-integration` 的定位是「观察者、不是应答者」的轻量状态桥（`herdr-integration/README.md:85-87`），并入会把它变成执行插件并搅混两份边界；与 tmux 共包需先抽底床抽象，而两条目正在不同 worktree 并行，共用会互相阻塞且抽象信息不足。**约定最小共性**（不强制对方采纳）：动作名对齐 `create / list / read / wait / send_text / send_keys / run / close`，工具名按底床前缀（本包 `herdr_pane`）。两条目都落地后，抽公共层另立条目。**用户 2026-10-17 认可独立成包**（问共包问题时答「都可以」）—— 维持「只约定动作名、不建公共层」的口径。

决策项 4　工具面粒度

- a) 单个工具 `herdr_pane` + `action` 分派
- b) 每个动作一个工具（`herdr_pane_split` / `..._read` / …）
- c) 两个工具（只读 / 写类分开）

**选定 a**。理由：十个动作共享同一套参数与归属规则，单条描述即可讲清选择成本与安全边界（对齐 `ast_query` / `md_logic` 的既有风格），工具面上下文占用最小；写类动作的闸门由 `action` 值判定，不依赖工具名。

决策项 5　非 herdr 环境的降级

- a) 不注册工具（与 `herdr-integration` 的空转口径一致），只记一行日志
- b) 注册降级工具（调用返回含指引的错误，对齐 `ast-tools`）
- c) 注册但标为不可用 / 需确认

**选定 a**。理由：不在 herdr 内是运行位置决定的、本机不可修，注册必然失败的工具只会诱使模型反复试错并污染工具面；与同族插件 `herdr-integration` 的既有口径保持一致。判定用握手三变量（`HERDR_ENV=1` + socket 路径 + pane id），另以 `HERDR_BIN_PATH` 兜底定位二进制（PATH 找不到时用它）。

决策项 6　目标 pane 的选择与归属

- a) 写类动作缺省只作用于**本插件创建并登记**的 pane；读类动作可读任意 pane；缺省永不使用「当前聚焦 pane」
- b) 允许任意 pane（缺省取调用者 / 聚焦 pane）
- c) 只允许操作调用者自己所在的 pane

**选定 a**。理由：c 不可行——在 dsh 自己所在 pane 里跑交互式程序会毁掉 TUI 会话（实测也证明该 pane 的回显会污染匹配，见 §2）；b 会误伤用户或其它 agent 的 pane（官方技能明确要求不依赖别的客户端焦点、不动不是自己创建的东西）。a 同时给「读」留了观察能力（只读、无副作用）。

决策项 7　生命周期与残留清理

- a) 缺省在 dsh 退出时关闭本次创建的 pane（配置可关），创建时打 label 便于事后识别；崩溃残留靠 label 识别 + 显式 close
- b) 退出保留（只登记，靠显式 close）
- c) 退出关闭全部相关 pane（含非本插件创建）

**选定 a**。理由：驱动方一退出，被驱动的 pane 就没有了控制者（b 会稳定留下孤儿 pane 与孤儿进程）；c 违反官方技能「不要关闭不是自己创建的 pane」。label（如 `dsh-pane`）让崩溃残留可被 `list` 与人工一眼识别；关闭走 `spawnSync` 尽力送达（对齐 `herdr-integration/src/herdr.ts:167-180` 的退出兜底），只针对登记过的 pane。**用户 2026-10-17 认可缺省关闭**（答「都可以」）—— `closeOnExit` 缺省 `true`，要保留现场供退出后查看的部署把它置 `false`，残留靠 label 与显式 `close` 清理。

决策项 8　取屏口径

- a) 缺省 `--source recent-unwrapped --lines 120 --format text`（剥 ANSI）；TUI 程序改用 `visible`；`ansi` 仅在需要颜色证据时
- b) 缺省 `visible`
- c) 缺省全历史 + ANSI

**选定 a**。理由：`recent-unwrapped` 是官方技能给日志与转录的首选（软换行已拼接，便于匹配与阅读）；alternate-screen 程序必须看视口，故保留 `visible`；默认剥色避免把转义序列灌进模型上下文。渲染上限另设（默认 200 行 / 16000 字符，超出截断并提示用 `lines` / `source` 收窄）。

决策项 9　等待与稳定判定

- a) 服务端 `wait-output`（字面量 / 正则）+ `stable` 静默模式（两次读取文本比对，`settle_ms` 缺省 400），缺省 `timeout_ms` 30000，超时返回结构化结果而非抛错
- b) 只做 `match`
- c) 自建轮询 + socket `revision` 判稳

**选定 a**。理由：服务端等待已覆盖「等某个提示出现」这一主场景，且先搜既有输出、无自建轮询的竞态；`stable` 覆盖「程序输完了但没有固定标记」的场景（本条目与「同事模型群组的编排协议」都需要）；c 要引入 socket 通道并自建轮询，收益仅一个 `revision` 字段。**随决策项 1 更新（2026-10-16）**：`stable` 的判稳改用 socket `pane.read` 的 `revision`（相邻两次读取 `revision` 相同即判稳，`settle_ms` 间隔 + `timeout_ms` 兜底；取不到 `revision` 时回退文本比对）；`match` / `regex` 仍走 CLI `wait-output`（其成功信封内已含 `read` 与 `revision`）。

决策项 10　安全闸门

- a) 三闸并用：执行前 `guard.inspectCommand(text, "herdr-pane:<action>")` 复查（同 TUI `$` 口径，guard 缺失 / 抛错则告警一次后照常）+ 在 `security-guard` 的插件命令工具登记表登记本工具的命令参数键 + 越界动输入走宿主审批（`tools/pre-execute` 返回 `{kind:"ask"}`）
- b) 只靠 `security-guard` 登记（宿主侧硬拒层）
- c) 每次调用都过审批（`always`）

**选定 a**。理由：本插件的命令跑在 dsh 沙箱之外（见 §7），必须有显式闸门；a 的三层各自覆盖不同失败面——guard 复查兜住「策略层命中」（与 TUI `$` 同源文案）、登记表让宿主在派发前就能拦（仓库既有约定要求登记）、审批只在越界时打断人（c 会让每次建 pane 都弹审批，实际不可用）。审批用宿主既有的 `ask` 门（`dsh-tools/lib/index.js:3226`）而不是自己调 `ctx.approval`：审批对（`approval/asked` / `approval/decided`）由宿主写入、无审批服务时自动 fail-closed。

决策项 11　审批缺省档与配置面

- a) `requireApproval: "foreign"`（缺省）——只对**非本插件创建**的 pane 动输入 / 关闭时审批；`"always"` / `"never"` 可选
- b) 缺省 `"always"`
- c) 缺省 `"never"`

**选定 a**。理由：缺省动作面已限定在自建 pane（决策项 6），此时与官方 bash 工具同级（命令执行不逐次审批，`dsh-tool-bash/README.zh.md:68`）；一旦要动用户的 pane，打断一次是应该的。`never` 保留给信任场景（此时仍有 guard 硬拒层与归属限制），`always` 保留给高敏场景。**用户 2026-10-17 认可缺省 `foreign`**（问「审批缺省是?」后答「可以」）—— 三档语义保持; 要更高约束的部署把 `requireApproval` 改成 `always`（每次弹）或 `never`（从不弹，仍有 guard 与归属限制兜着）。

决策项 12　沙箱模式联动（会话处于 `read-only` 时拒绝写类动作）

- a) 首期不做，记为二期候选
- b) 首期做（订阅 `session/event` 的 `sandbox/mode` 折叠当前模式）

**选定 a**。理由：会话初始模式在无事件时无从判定（`sandbox/mode` 是会话事件、不是可查询服务，`docs/host/DSH-CTX-API.md:140`），猜错就是把闸门做成误拦或空设；首期先用「归属 + guard + 审批」三闸覆盖，待实现时确认模式事件的实际时序后再评估（届时另立条目或并入二期）。

决策项 13　文档形态

- a) 首期按**轻量包**：`README.md` + `docs/BACKLOG.md`，不写 `DESIGN.md`
- b) 首期即写 `docs/DESIGN.md`

**选定 a**。理由：能力面、边界与安全分档可在一份 README 讲清，尚无跨组件协议 / 状态机 / 时序契约（`AGENTS.md`「结构与约定」的 DESIGN 口径）；若二期加入会话模式联动或事件订阅面，机制变厚再补。

## 规划

### 实现前冻结的接口（消费方按此写）

**工具面**：单个模型侧工具 `herdr_pane`，`action` 取 `create | list | read | wait | send_text | send_keys | run | label | info | close`（写类动作用 `action` 值判闸门，不按工具名）。参数与必填：

| 动作 | 参数 | 通道 |
| --- | --- | --- |
| `create` | `direction?`（按 `pane layout` 宽高自动选 `right` / `down`）· `cwd?`（缺省继承进程 cwd）· `label?`（缺省配置 `label`） | CLI |
| `list` | `workspace?` | CLI |
| `read` | `pane_id`（必填）· `source?`（缺省 `recent-unwrapped`）· `lines?`（缺省 120）· `format?`（缺省 `text`） | **socket** |
| `wait` | `pane_id`（必填）· `match?` / `regex?`（二选一）或 `stable?` · `settle_ms?`（缺省 400）· `source?` / `lines?` · `timeout_ms?`（缺省 30000） | CLI（`match` / `regex`）· **socket**（`stable`） |
| `send_text` | `pane_id`（必填）· `text`（必填） | CLI |
| `send_keys` | `pane_id`（必填）· `keys`（必填，如 `["ctrl+c"]`） | CLI |
| `run` | `pane_id`（必填）· `command`（必填，文本 + Enter 一次提交） | CLI |
| `label` | `pane_id`（必填）· `label?`（缺省写配置值；空串表示清除） | CLI |
| `info` | `pane_id`（必填） | CLI |
| `close` | `pane_id`（必填）· `force?`（需 `allowForeignPanes: true`） | CLI |

**配置面**（六键）：`requireApproval`（`foreign` 缺省 / `always` / `never`；**2026-10-17 用户认可保持 `foreign`**）· `allowForeignPanes`（缺省 false）· `closeOnExit`（缺省 true；**2026-10-17 用户认可**）· `label`（缺省 `dsh-pane`）· `timeoutMs`（单次 CLI 调用上限，缺省 10000）· `renderLimit`（缺省 200 行 / 16000 字符）。

**非 herdr 环境**：**不注册工具**，只记一行日志；判定用握手三变量（`HERDR_ENV=1` + socket 路径 + pane id），`HERDR_BIN_PATH` 作 PATH 兜底。

**归属与生命周期**：写类动作缺省只作用于**本插件创建并登记**的 pane（缺省永不使用聚焦 pane），读类可读任意 pane；退出时关闭本次创建的 pane（`closeOnExit`），创建成功后自动打一次 label 便于识别崩溃残留；关闭走 `spawnSync` 尽力送达，只针对登记过的 pane。

**取屏与回执口径**：缺省 `recent-unwrapped` / 120 行 / `text`（剥 ANSI；TUI 类程序用 `visible`）；`read` 回执带 `revision` 与 `truncated`，`info` 回执带 `foreground_processes` / `shell_pid`；herdr 错误信封归一为 `{code, message}`；输出按 `renderLimit` 截断并提示用 `lines` / `source` 收窄。`output.schema` 的具体字段名以实现时定稿为准。

**安全三闸**（闸①的判定语义 2026-10-17 第二轮写明，与 `security-guard` 的服务面签名 `inspectCommand(command, source?): string | null` 对齐）：① 执行前 `ctx.get("guard")?.inspectCommand(text, "herdr-pane:<action>")` 复查 —— **返回 `null` = 放行；返回字符串 = 命中，按 deny 回执处理（不执行、把该字符串作为回执来源行附上）**；服务缺失 / 无该方法 / 调用抛错 → 告警一次后**照常执行**（fail-open，与 TUI `$` 模式同口径，见 `TUI/src/app/local-shell.ts:8`、`:245-270`）。**这条复查是本包自己的本地加固，不构成对 `security-guard` 的要求**（两侧的共同契约只有闸②的登记表）；② `security-guard` 登记 —— `PLUGIN_COMMAND_TOOLS.herdr_pane = { commandKeys: ["command", "text"], commandPaths: ["keys[]"] }`（**2026-10-17 订正**：原写 `commandKeys: ["command", "text", "keys"]`，但 `security-guard` 任务的实测结论是 `commandKeys` 会静默忽略数组值，数组参数必须走 `commandPaths`）；③ 越界动输入走宿主审批（`tools/pre-execute` 返回 `{kind: "ask"}`），不用 `ctx.approval`。

### 任务拆分（实现阶段）

1. 包骨架与接线：`package.json`（`dsh.bundle` 契约）、`tsconfig.json`、`index.ts`、`cordis.patch.yml`、`LICENSE`、`.gitignore`、`docs/BACKLOG.md`；根 `package.json`（check / build 两链）、`scripts/test-parallel.sh`、`scripts/install.sh`、`AGENTS.md`、`README.md`、`README.zh.md`。
2. 库面（不依赖宿主，可单测）：握手判定（三变量 + 二进制定位）、CLI 薄封装 `runHerdr(args, {timeoutMs})`（spawn 参数数组、stdout / stderr 解析、退出码归一）、**socket 读通道**（单请求连接、`pane.read` 报文与响应解析、`id` 生成、超时）、十个动作的参数校验与 argv / 报文拼装、结果解析（`pane list` / `split` / `wait-output` 信封 / 错误信封 / socket `PaneReadResult`）。
3. 归属与生命周期：进程内登记表（pane id → `{ label, createdAt, agentRef? }`）、label 命名、`closeOnExit` 与退出兜底（`spawnSync`）、单 pane 操作串行化。
4. 安全闸门：`tools/pre-execute` 监听器（按 `action` 与归属返回 `{kind:"ask", reason}`）、执行前 `guard.inspectCommand` 复查、`security-guard` 登记表登记（跨包）。
5. 工具面：`herdr_pane` 定义（`parameters` JSON Schema、`output.schema` 与 `render`）、选择成本与安全边界写进 `description`。
6. 测试：单测（注入 fake runner 与假时钟）+ 真机验证脚本 `scripts/verify-herdr-pane.mjs`（对齐 `herdr-integration/scripts/verify-herdr.mjs` 的做法：`import dist/`、人工跑、不进 CI）。
7. 文档与回写：包 `README.md`（能力 / 参数 / 安全分档 / 降级 / 归属与残留口径）、`herdr-pane/docs/BACKLOG.md`、必要时 `AGENTS.md` 与根 README 清单同步。

### 工具面（首期动作与关键参数）

单工具 `herdr_pane`，`action` 取 `create | list | read | wait | send_text | send_keys | run | label | info | close`；关键参数：

- `create`：`direction?`（缺省按 `herdr pane layout` 的宽高自动选 `right` / `down`，对齐官方技能的几何规则）、`cwd?`（缺省继承 dsh 进程 cwd）、`label?`（缺省 `dsh-pane`）。
- `list`：无参（或 `workspace?`），返回 pane 摘要与本插件登记标记。
- `read`：`pane_id`、`source?`（缺省 `recent-unwrapped`）、`lines?`（缺省 120）、`format?`（缺省 `text`）—— **走 socket**（`pane.read`，拿 `revision` / `truncated`；报文的 `source` 用下划线写法 `recent_unwrapped`，与 CLI 的连字符写法需映射；`format=ansi` 时同时置 `strip_ansi: false`，与 CLI `--format ansi` 对齐，具体语义实现时复核）。
- `wait`：`pane_id`、`match?` / `regex?`（二选一，走 CLI `wait-output`）、或 `stable?`（静默模式，走 socket 读 + `revision` 判稳）、`settle_ms?`（缺省 400）、`source?` / `lines?`、`timeout_ms?`（缺省 30000）。
- `send_text`：`pane_id`、`text`；`send_keys`：`pane_id`、`keys`（如 `["ctrl+c"]` / `["esc"]` / `["up"]`）；`run`：`pane_id`、`command`（文本 + Enter）。
- `label`（可选动作，已纳入）：`pane_id`、`label?`（缺省写 `label` 配置值；显式空串表示清除），只对自建 pane 生效；`create` 成功后自动打一次。
- `info`（可选动作，已纳入）：`pane_id`，返回 `foreground_processes` / `shell_pid`（用于判「命令是否还在跑」）。
- `close`：`pane_id`、`force?`（关非本插件创建的 pane；需配置 `allowForeignPanes: true`）。

配置面（`cordis.patch.yml` 的 `config`）：`requireApproval`（`foreign` 缺省 / `always` / `never`）、`allowForeignPanes`（缺省 false）、`closeOnExit`（缺省 true）、`label`（缺省 `dsh-pane`）、`timeoutMs`（单次 CLI 调用上限，缺省 10000）、`renderLimit`（行 / 字符上限，缺省 200 行 / 16000 字符）。

`security-guard` 登记形态（**2026-10-17 订正**）：`PLUGIN_COMMAND_TOOLS.herdr_pane = { commandKeys: ["command", "text"], commandPaths: ["keys[]"] }` —— 数组参数 `keys` 走 `commandPaths`（`commandKeys` 静默忽略数组值，见 `security-guard` 任务的实测）；参数名与上面一致。

### 计划改动文件清单

新增（包 `herdr-pane/`）：

- `package.json`、`tsconfig.json`、`index.ts`、`cordis.patch.yml`、`README.md`、`LICENSE`、`.gitignore`
- `src/main.ts`（插件入口：握手判定、工具注册、审批门、退出清理）
- `src/cli.ts`（herdr CLI 薄封装：env 解析、spawn、超时、错误归一）
- `src/socket.ts`（socket 读通道：单请求连接、`pane.read` 报文与响应、超时与错误归一）
- `src/actions.ts`（八动作的参数校验、argv 拼装、结果解析；纯函数）
- `src/registry.ts`（归属登记、label、closeOnExit 清单）
- `src/policy.ts`（审批档与归属判定、guard 复查接线；纯函数）
- `src/tools.ts`（`herdr_pane` 定义与 `render`）、`src/types.ts`
- `tests/cli.test.ts`、`tests/socket.test.ts`、`tests/actions.test.ts`、`tests/registry.test.ts`、`tests/policy.test.ts`、`tests/main.test.ts`、`tests/tool.test.ts`
- `scripts/verify-herdr-pane.mjs`
- `docs/BACKLOG.md`

修改（接线，四处）：

- 根 `package.json`（check / build 链各加一段）、`scripts/test-parallel.sh`（`default_pkgs`）、`scripts/install.sh`（`canonical_pkgs`）

修改（文档清单，两处）：

- `AGENTS.md`（插件清单与包计数）、`README.md` + `README.zh.md`（插件清单一节）

跨包（一处，实现时随计划一并请批）：

- `security-guard/src/index.ts`（`PLUGIN_COMMAND_TOOLS` 登记 `herdr_pane` 的命令参数键）+ `security-guard/tests/` 对应用例 + `security-guard/README.md` 登记表口径一行

仓库外（本机 profile，需用户确认后做）：

- `~/.dsh/profiles/fff/package.json`（`link:` 依赖 + `bundles`）与 `~/.dsh/profiles/fff/cordis.patch.yml`（挂载行）；仓库模板 `profiles/example/` 可选同步

本任务（文档）：

- 本文件 `docs/implementation/2026-10-16-herdr-pane-design.md`；`docs/BACKLOG.md`（条目注记）

### 明确不做的部分

- 不做 TUI 命令 / 面板；不做测试基底依赖（不进 CI 门禁）。
- 不支持 `--machine` / `--session`（跨服务器 / 命名会话目标）；不碰布局类动作（`focus` / `resize` / `zoom` / `swap` / `move` / `scroll` / `input`）；不驱动「被 herdr 识别的 agent」面（`herdr agent prompt|wait|start`）。
- 不用 socket 事件订阅面（`events.subscribe` / `events.wait`）；不做沙箱模式联动（决策项 12）。
- 不改 `herdr-integration` 现有行为（含其握手判定与空转口径）；不抽 tmux / herdr 公共层（另立条目）。
- 不做残留 pane 的后台清理守护（属「后台常驻守护机制」条目范围）。

### 验收（细化）

1. 机械门禁：`npm run check`、`npm run build`、`npm run test`（全仓 23 个包 = TUI + 22 个插件）exit 0。
2. 单测（注入 fake CLI runner、fake socket 与假时钟，不依赖真机 herdr）：
   - 握手判定：三变量缺一 → `register` 未被调用（fake ctx 断言）+ 一行日志；
   - argv / 报文拼装：十动作各自 argv 与 socket 报文（含 `--no-focus`、`--source recent-unwrapped`、`--lines`、`--format`、`--match` / `--regex`、`--timeout`、`rename` 的 label、`process-info`）；
   - 结果解析：`list` / `split` / `wait-output`（成功信封）/ 错误信封（stderr JSON + exit 1）/ socket `pane.read` 响应（含 `revision` / `truncated`）五类；
   - 归属判定：未登记 pane 的 `send_*` / `run` / `close` 被拒（回执含放行方式），登记后可执行；
   - 等待：`match` 命中（CLI 信封）；超时（`code=timeout`）返回结构化超时结果而非抛错；`stable` 静默判定三例（`revision` 持续变化不收敛 / `revision` 相同收敛 / 超时兜底）；socket 读通道两例（响应分片到达的 framing、socket 错误信封）；
   - 截断：超 200 行或 16000 字符 → 截断并给收窄提示；
   - 审批档：`foreign` 下对未登记 pane 的输入产出 `{kind:"ask"}`（fake `tools/pre-execute` 捕获）；`never` / `always` 行为各一例。
   - 可选动作：`label` 对自建 pane 打标 / 清空、对非自建 pane 被拒；`info` 解析 `foreground_processes` 与 `shell_pid`，pane 不存在时返回结构化错误。
3. 真机（人工确认，dsh 跑在 herdr pane 内）：`create` → `run` 起一个交互式程序（如 `python3 -i`）→ `send_text` / `send_keys` → `wait`（match 提示符）→ `read`（`visible`）→ `close`；`herdr pane list` 核对 label 与 pane 数；期间调用者 pane 的焦点不被抢走（`--no-focus` 生效）。
4. 残留：正常退出后 `herdr pane list` 无本次创建的 pane；`kill -9` dsh 后残留 pane 仍带 label，可被新进程的 `herdr_pane list` 与人工识别并关闭。
5. 降级：`env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_PANE_ID dsh --profile fff` 启动的工具清单里没有 `herdr_pane`。
6. 安全：黑名单命令（如 `rm -rf /`）经 `herdr_pane run` 被 guard 拦（回执与 bash 工具同源）；`allowForeignPanes` 关闭时对他人 pane 的输入被拒；越界输入在审批面板出现且拒绝后不执行。

### 估时（细化）

0.5 天包骨架与接线；0.6 天库面（握手 + CLI 封装 + socket 读通道 + 十动作 + 解析）；0.25 天归属与生命周期；0.25 天安全闸门（含 `security-guard` 登记与其用例）；0.5 天单测；0.25 天真机验证脚本、人工确认与文档回写；0.15 天可选动作（`label` / `info`）与其用例。合计约 **2.5 天**（2.25 至 2.75 天区间，取决于 `security-guard` 登记与真机验证是否顺；比全 CLI 方案多约 0.25 天用于 socket 读通道，另 0.15 天为可选动作）。

### 实现阶段的验证口径（怎么跑）

「验收（细化）」列的是**验什么**，这里列**怎么跑**：

- **单测**：`npm --prefix herdr-pane run test` —— 七个用例文件（`cli` / `socket` / `actions` / `registry` / `policy` / `main` / `tool`），注入 fake runner 与假时钟；socket 侧注入连接器或起本地假 socket，不依赖真 herdr；断言 argv 与报文拼装、错误信封归一、归属与审批档判定、非 herdr 环境下不注册。
- **机械**：根 `npm run check` + `npm run build` + `npm run test` 三件全绿；`scripts/install.sh --dry-run` 的清单含本包。
- **真机**：在 herdr 管理的 pane 内启动 `dsh --profile fff`，执行 `node herdr-pane/scripts/verify-herdr-pane.mjs`（`import dist/`、人工跑、不进 CI）—— 只用自己创建的 pane，逐动作验证（`create` → `read` → `send_text` → `wait` 的 `match` 与 `stable` → `run` → `info` → `label` → `close`），并确认退出时自建 pane 被关闭；在 herdr 之外启动时确认工具不出现。
- **不做**：不依赖别的客户端焦点、不动非自建 pane；不把真机脚本接进 CI（herdr 不保证存在）；不验 `format=ansi` 的颜色语义（留实现时复核）。

### 收尾动作（实现完成时）

- 条目「基于 herdr 的交互式命令扩展（herdr pane 读写）」标「完成」并从 `docs/BACKLOG.md` 移除；本文件移入 `docs/archived/`。
- 文档回写：根 `README.md` + `README.zh.md`（插件清单与包数）、`AGENTS.md`（包数与结构段的插件列表）、`docs/BACKLOG.md` §4 插件规划表补一行；**包计数与 §4 表的统一**归条目「五个新插件落地时的仓库清单与包计数统一」。
- 跨包登记：`security-guard` 侧那行归条目「登记两个新插件工具的命令参数面（`script_run` / `herdr_pane`）」，本任务只保证键名与 `commandPaths: ["keys[]"]` 形态一致。
- 途中发现两项**已登记**为条目「修正 `docs/BACKLOG.md` §5 对 herdr pane 外部问题取证位置的指向」与「核正条目 5（Docker 交互插件）的〔进行中〕标记」，均归各自条目，本任务不代改。
- 残留口径：正常退出按 `closeOnExit` 关闭自建 pane；崩溃残留靠 label（缺省 `dsh-pane`）识别 + `list` 查看 + 显式 `close`，README 记明。
- 与 tmux 条目的「最小共性」只是动作名约定，本任务**不建公共层**；两条目都落地后若要抽公共层，另立条目。

### 已裁定的开口项（原「剩余待用户裁定项」）

1. **放行实现**（2026-10-16）：按本决策实施，可选动作 `label` / `info` 一并做。
2. **审批缺省档**（2026-10-17「可以」）：维持 `foreign`。
3. **是否与 tmux 条目共包**（2026-10-17「都可以」）：维持独立成包，只约定动作名；将来抽公共层另立条目。
4. **退出时关闭自建 pane**（2026-10-17「都可以」）：维持 `closeOnExit: true`（可配置关）。
5. **途中发现是否立条目**（2026-10-17）：已办，两项均已登记（见下）。
6. **优先级 P2 → P1**（2026-10-17「后面再说」）：**延后未定** —— 若「同事模型群组的编排协议」优先，本条目宜上调 P1。

### 途中发现（两项均已登记为条目，2026-10-17）

- 「修正 `docs/BACKLOG.md` §5 对 herdr pane 外部问题取证位置的指向」—— §5 原写取证在 `TUI/docs/BACKLOG.md`，实际在 `TUI/docs/STATUS.md:12` 与 `TUI/docs/archived/2026-09-27-herdr-pane-size-external-issue.md`。
- 「核正条目 5（Docker 交互插件）的〔进行中〕标记」—— 该标记的归属待核（不在 2026-10-16 注记的接取清单里，也无对应 worktree），本轮未代改。

## 实现记录

- 2026-10-16：本文件建立（调研 + 决策 + 规划三节）。本轮**未写任何实现代码**，未改包代码，未改 `herdr-integration`。
- 2026-10-16：用户裁定通道口径 → **CLI 为主的混合**（socket 有优势处才用 socket）。已同步更新：决策项 1（原「全走 CLI」标记为被取代，补划分表）、决策项 9（`stable` 改用 socket `pane.read` 的 `revision` 判稳）、任务拆分与工具面（`read` / `stable` 走 socket、其余走 CLI）、计划改动文件清单（加 `src/socket.ts` 与 `tests/socket.test.ts`）、验收单测项、估时（2 天 → 2.25 天）、待裁定项 1。
- 2026-10-16：调研用命令（全部只读）——`herdr --version` / `herdr --help` / `herdr pane --help` / `herdr pane <sub> --help`（split / close / read / send-text / send-keys / wait-output / run / get / list / process-info）/ `herdr api --help` / `herdr api schema --json` / `herdr status` / `herdr --skill` / `herdr pane list` / `herdr pane current` / `herdr pane get wT1:p1`（含不存在 id 的错误形态）/ `herdr pane layout --pane wT1:p1` / `herdr pane process-info --pane wSP:p1` / `herdr pane read wT1:p1 --source visible --lines 5` / `herdr pane read wSP:p1 --source recent-unwrapped --lines 4` / `herdr pane wait-output wSP:p1 --match "zz-absent-zz" --timeout 400`。
- 2026-10-16：用户放行实现（「可以，先按照这个实现，可选的也做」）。据此把决策项 1 的汇总表换成**逐动作 7 列划分表**（动作 / 通道 / 落地形态 / 额外信息 / 依据 / 实现落点 / 首期），并把两个可选动作纳入首期：`label`（`pane rename` 标归属，`create` 后自动打一次）、`info`（`pane process-info` 进程探活）——动作集由八个变十个。同步更新：决策项 4 理由、任务拆分第 2 条、工具面动作表与参数、验收单测项（argv / 报文拼装与可选动作断言）、估时（2.25 → 2.5 天）、待裁定项 1（已裁定）。本轮仍**只改文档，未开始写代码**（等文档检查）。

## 偏差

- 计划「尽量在本机核实 herdr 的实际命令面」：**只核到只读命令**。写类动作（`split` / `send-text` / `send-keys` / `run` / `close` / `rename`）一律未执行——避免改动用户当前的 pane 布局与其它 agent 的 pane。这些动作的语法来自 `--help` 输出与官方技能文档，实测留到实现阶段的真机验证（见「验收」第 3 条）。
- 计划「非 herdr 环境下的行为」：**未实测** `herdr` CLI 在缺少握手变量时的行为。官方技能明确要求「不在 herdr 管理的 pane 内时不要检视或控制会话」，故未在环境外调用 CLI；插件的降级判定只依赖握手变量（决策项 5），不依赖此点。
- 计划「alternate-screen 程序取屏」：**未核实**（需要真起 `vim` / `htop`，属写类操作）。
- 文档已按仓库约定用 `format` 格式化（首轮按当次任务要求未跑，后随提交前格式化补上）。
- `HERDR_BIN_PATH` 的语义**未核实**（herdr 官方技能未提及；本机观测到该变量指向二进制绝对路径，方案中仅作 PATH 兜底使用）。

## 测试与证据

本轮为文档产出，无代码改动，故无机械门禁（`check` / `build` / `test` 均未跑，也无必要）；证据是调研所用的只读命令及其输出（见「实现记录」与 §1 至 §8 的逐条标注）：

- herdr 版本与协议：`herdr --version` → 0.9.5；`herdr status` → client / server 0.9.5、protocol 22、`endpoint_compatible: yes`。
- pane 面：`herdr pane --help` → 25 个子命令；`herdr api schema --json` → 102 个 socket method（含 `pane.split` / `pane.send_text` / `pane.send_keys` / `pane.read` / `pane.wait_for_output` / `pane.close` / `events.subscribe` / `events.wait`）。
- 取屏：`herdr pane read wT1:p1 --source visible --lines 5` 与 `herdr pane read wSP:p1 --source recent-unwrapped --lines 4` 均返回纯文本（后者为外部 shell pane 的提示符行）。
- 等待：`herdr pane wait-output wSP:p1 --match "zz-absent-zz" --timeout 400` → stderr `{"error":{"code":"timeout",…}}`，exit 1；另一次在本 pane 的匹配「命中」了自身回显（见 §2，成为决策项 6 的证据）。
- 错误形态：`herdr pane get wT1:p999` → stderr `{"error":{"code":"pane_not_found",…}}`，exit 1。
- 归属字段：`herdr api schema --json` 的 `PaneInfo.label` 与 `PaneRenameParams.label`（决策项 7 的标记依据）。
- 残留检查：`git status` 仅本文件与 `docs/BACKLOG.md` 注记（提交前复核）。

## 收尾

- 回写：无（本轮不改 `DESIGN.md` / `README.md` / `ROADMAP.md`；新增包文档留待实现阶段）。
- 遗留项：实现未开始（已放行，等接取）；与 tmux 条目的共包问题已裁定维持独立；优先级 P2→P1 延后未定；「途中发现」两项已登记为条目。
- 归档：**未归档**（追踪文档留在 `docs/implementation/`，任务未关闭）。
- BACKLOG 清理：不适用（条目仍为进行中，未标完成、未移除）。
