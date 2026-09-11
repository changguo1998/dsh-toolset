# @dsh-toolset/herdr-integration

DSH（DeepSeek Harness）与 [herdr](https://github.com/Jungod1121/herdr) 面板集成插件（热身插件，零运行时依赖）：agent 状态经 unix socket 上报 herdr 面板，并桥接 blocked 事件（包含 ask-user 提问等待、approval 审批等待、turn 阻塞等待三类信号源）。

协议仿 pi 原生扩展（`~/.pi/agent/extensions/herdr-agent-state.ts` / `herdr-ask-user-question.ts`，仅协议对齐、代码重写）：

- 环境变量握手：`HERDR_ENV=1` + `HERDR_SOCKET_PATH` + `HERDR_PANE_ID` 缺一即禁用；
- 传输：unix socket（Windows 命名管道），换行分隔 JSON 行；
- `pane.report_agent_session`：上报当前会话引用（`agent_session_id`，id 优先、path 兜底）；
- `pane.report_agent`：上报状态 `working | blocked | idle`（附单调 `seq` 与 `message`）；
- 发送：独立连接、写一行等响应；首档超时（默认 500ms）失败后按固定 1500ms 补一次；
- 状态队列：串行 drain，同刻多条状态合并为最新一条（后到覆盖），不丢最终态。

## 功能

- **状态上报**：订阅 `agent/status`（`AgentStatus = 'idle' | 'running'`），根 agent（`ctx.agents.roots()`）转移时上报：
  - `running` → `working`；`idle` → `idle`；无根 agent → `idle`；
  - 启动时同步既有根 agent 并上报 `pane.report_agent_session`（首次 `session_start_source: startup`；会话切换如 resume 再次上报）。
- **blocked 事件桥（所有阻塞都上报 blocked）**：观察型 waterfall 监听 + `session/event` 订阅，pending 期间上报 `blocked`、沉降后解除：
  - `approval/request` → `blocked`（message `waiting for approval`）；
  - `user-questions/request`（ask_user_question 工具）→ `blocked`（message `waiting for user`）；
  - `session/event` → `turn/end`（`reason` 为 `blocked`，字符串或 `{kind:'blocked'}` 联合形）→ `blocked`（message `waiting for input`），由下一次 `turn/start` 解除（turn 生命周期闭环）；
  - 多来源并发阻塞各自计数，全部解除才释放；blocked 优先于 working（与 pi 原生 `desiredState` 语义一致）。

## 作为 bundle 挂载

1. 创建/进入一个 profile，加依赖并声明 bundle（仿 `TUI/README.md` 的 `link:` 方式，勿用 `file:`）：

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "@dsh-toolset/herdr-integration": "link:<本包路径>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@dsh-toolset/herdr-integration"
      ]
    }
  }
}
```

2. 核对组合树（本地 `link:` 依赖无需重新安装）：

```sh
dsh --profile <p> --dump-config   # 应出现 - id: herdr-integration 行
```

3. 在 herdr 面板内启动 dsh（`HERDR_ENV` 等握手环境变量由 herdr 提供）：

```sh
dsh --profile <p>
```

### 加载顺序注意（重要）

本插件的 blocked 桥是**观察型 waterfall 监听者**：它必须在真实答案者（如 `@dsh-toolset/dsh-tui` 的问答应答者）**之前**注册，否则请求已被下游认领，观察者收不到事件。多个 bundle 时请把本 bundle 排在 dsh-tui **之前**：

```jsonc
"bundles": [
  "@deepseek-ai/dsh-base",
  "@dsh-toolset/herdr-integration",   // 先于 dsh-tui
  "@dsh-toolset/dsh-tui"
]
```

## 配置

在 profile 的 `cordis.patch.yml` 中给 `herdr-integration` 节点加 `config`：

```yaml
- id: herdr-integration
  name: '@dsh-toolset/herdr-integration'
  config:
    source: herdr:dsh      # 面板来源标识（默认 herdr:dsh）
    agent: dsh             # agent 标识（默认 dsh）
    attemptTimeoutMs: 500  # 首档发送尝试等待响应超时 ms（默认 500，与 pi 原生一致）
```

缺省/非法值回退默认；仅 `source`/`agent`/`attemptTimeoutMs` 三项可配。

## 构建 / 测试

```sh
npm run build  # tsc → dist/
npm run check  # tsc --noEmit 类型检查
npm run test   # node --test 单测（握手/协议/状态机/插件行为）
```

- `files` 发布字段覆盖 `dist/`、`README.md`、`cordis.patch.yml`；`cordis.patch.yml` 由 `package.json` 的 `dsh.bundle.patch` 引用。
- DSH 契约对齐仓库根 `DSH-CTX-API.md`（agent/status、approval/request、user-questions/request、agents.roots()）。

## 约束与边界

- 只跟踪**根 agent**（与 pi 原生 `rootSession` 语义一致）：子 agent（subagent/jobs）状态不翻转面板展示。
- **`agent_session` 仅对官方集成可见（herdr 上游设计）**：herdr 服务端只接受固定官方列表（`herdr:pi/pi`、`herdr:claude/claude` 等）的会话引用，dsh 不在其中时 `pane.report_agent_session` 会被静默丢弃（协议返回 ok）。**状态上报不受此门控**：任何 agent 的 `working`/`blocked`/`idle` 均可在面板可见（已实测）。插件仍按协议发送会话消息，若 herdr 后续将 dsh 纳入官方列表即自动生效。
- 会话引用仅上报 `agent_session_id`（DSH `Session.id`）；`agent_session_path`（会话文件路径）需 persistence 服务暴露路径后可作为增强，当前不配置。
- 在非 herdr 环境（握手环境变量不全）运行时插件静默空转，无任何副作用。

## 端到端验证脚本

`scripts/verify-herdr.mjs` 用真实 `HerdrClient` 对当前 herdr 服务（`HERDR_SOCKET_PATH`）上报状态，供 `herdr api snapshot` 核实面板：

```sh
node scripts/verify-herdr.mjs blocked "waiting for user"   # 上报 blocked + message
node scripts/verify-herdr.mjs working                      # 上报 working
node scripts/verify-herdr.mjs idle                         # 上报 idle
node scripts/verify-herdr.mjs session                      # 仅上报 pane.report_agent_session
herdr api snapshot    # 核实 pane 的 agent_status / agent
```
