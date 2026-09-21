# @dsh-toolset/herdr-integration

DSH（DeepSeek Harness）与 [herdr](https://github.com/Jungod1121/herdr) 面板集成插件（零运行时依赖）：agent 状态经 unix socket 上报 herdr 面板，并桥接 blocked 事件（ask-user 提问等待、approval 审批等待、turn 阻塞等待三类信号源）。

## 能力

- **状态上报**：订阅 `agent/status`，按根 agent（`ctx.get('agents').roots()`）的实时状态推导并上报 `working` / `blocked` / `idle`；启动时同步既有根 agent 并强制上报一次。同状态 + 同 message 不重复发送（去抖）。

- **blocked 事件桥**：三类来源各自计数，任一 pending 即上报 `blocked`，全部解除才回落：

  | 来源 | 触发 | message |
  | --- | --- | --- |
  | `approval/request` | 审批请求 pending | `waiting for approval` |
  | `user-questions/request` | ask_user_question 提问 pending | `waiting for user` |
  | `session/event` | `turn/end` 且 `reason` 为 `blocked`（字符串或 `{kind:'blocked'}`） | `waiting for input` |

  前两者是**观察型 waterfall 监听**（`begin → await next() → finally end`，不认领请求、不影响真实答案者）；第三类由下一次 `turn/start` 解除。

- **会话上报**：首次见到根 agent 的会话或会话 id 变化（如 resume）时发 `pane.report_agent_session`，首次带 `session_start_source: "startup"`。

- **退出释放**：`dispose` 与进程 `exit` 时发 `pane.release_agent`（退出路径用同步子进程尽力送达），避免 dsh 退出后面板残留本 agent。

- **协议**：unix socket（Windows 为 `\\.\pipe\<path>`），换行分隔 JSON 行；`pane.report_agent_session` / `pane.report_agent` / `pane.release_agent` 三个 method，`seq` 单调递增（起点 `Date.now()*1000`），会话引用参数 id 优先、path 兜底。

- **发送策略**：每次请求独立连接、写一行后等响应，失败按固定 1500ms 补一次；状态发送串行 drain，发送期间到达的新状态覆盖待发项（同刻多条只发最新，`blocked > working > idle`）。

## 配置

在 profile 的 `cordis.patch.yml` 中给 `herdr-integration` 节点加 `config`（三项均可选，只有 `null`/`undefined` 回退默认，不做合法性校验）：

```yaml
- id: herdr-integration
  name: '@dsh-toolset/herdr-integration'
  config:
    source: herdr:dsh      # 面板来源标识（默认 herdr:dsh）
    agent: dsh             # agent 标识（默认 dsh）
    attemptTimeoutMs: 500  # 首档发送等待响应超时 ms（默认 500）
```

环境变量握手（由 herdr 提供）：`HERDR_ENV=1`、`HERDR_SOCKET_PATH`、`HERDR_PANE_ID` 缺一即禁用。

## 使用示例

1. 在 profile（`~/.dsh/profiles/<p>`）的 `package.json` 加 `link:` 依赖并声明 bundle（勿用 `file:`）：

```jsonc
{
  "dependencies": { "@dsh-toolset/herdr-integration": "link:<本包路径>" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@dsh-toolset/herdr-integration",
        "@dsh-toolset/tui"
      ]
    }
  }
}
```

2. 在 herdr 面板内启动：`dsh --profile <p>`；可用 `dsh --profile <p> --dump-config` 核对出现 `- id: herdr-integration`。

1. 端到端验证（先 `npm run build`，脚本直接 import `dist/`）：

```sh
node scripts/verify-herdr.mjs blocked "waiting for user"   # 位置参数：state [message]
node scripts/verify-herdr.mjs working
node scripts/verify-herdr.mjs idle
node scripts/verify-herdr.mjs session                      # 仅上报 pane.report_agent_session
herdr api snapshot                                         # 核实 pane 的 agent_status / agent
```

### 加载顺序

blocked 桥必须在真实答案者（如 `@dsh-toolset/tui` 的问答应答者）**之前**注册，否则请求已被下游认领、观察者收不到事件——因此 profile 的 `bundles` 数组要把本 bundle 排在 tui 之前（见上面示例）。

## 边界与限制

- 只跟踪**根 agent**：子 agent（subagent / jobs）的状态不翻转面板展示。
- 会话引用只上报 `agent_session_id`（DSH `Session.id`）；`agent_session_path` 需要宿主暴露会话文件路径，当前不配置。
- 不在 herdr 环境内（握手变量不全）时插件静默空转，不注册任何监听、无副作用。
- 发送失败静默丢弃（两次尝试后放弃），不影响会话；状态为内存态，进程退出即丢。
- 被阻塞的 turn 依赖后续 `turn/start` 解除阻塞；会话中途放弃时不主动解除。

## 测试

```sh
npm run build   # tsc -p tsconfig.json → dist/
npm run check   # tsc -p tsconfig.json --noEmit
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'（35 例）
npm run watch   # tsc -p tsconfig.json --watch
```

35 例单测（state 9 + herdr 10 + main 16），覆盖握手判定、协议报文与队列合并、状态推导、插件行为（含失败降级与退出释放）。
