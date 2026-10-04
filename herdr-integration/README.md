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

- **发送策略**：每次请求独立连接、写一行 JSON 后等响应（收到响应数据即视为送达，对端关闭/超时/出错视为失败）；首档等待上限 `attemptTimeoutMs`（默认 500ms），失败**立即**补发一次（该次等待上限固定 1500ms），两次都失败即静默丢弃。状态发送串行 drain（同刻在途 ≤1 条），发送期间到达的新状态覆盖待发项（同刻多条只保留最新一条；优先级由状态推导保证：`blocked > working > idle`）。

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
- 发送失败静默丢弃（最多两次尝试），不影响会话；状态为内存态，进程退出即丢；`exit` 路径的 `release` 走同步子进程尽力送达（3s 超时）。
- **无长连接 / 无重连退避 / 无心跳**：每次上报都是一次短连接，失败只补发一次；面板若漏收某条状态，本插件不会补齐——要等下一次状态变化才再发。
- **单 pane、无跨进程同步**：状态只报给握手得到的 `HERDR_PANE_ID` 这一个 pane；多个 dsh 进程 / 多个 pane 各自独立上报，插件不做合并或协调。
- **是观察者，不是应答者**：不认领 `approval/request` / `user-questions/request`，也不改变判定结果（真实答案者是 TUI 等上游）；本插件只据此翻转 `blocked` 展示。
- 宿主面锚点：事件名与作用域语义对齐基线为 dsh 0.1.2-rc.1，0.1.7 / 0.2.0-rc.2 复核未变（`docs/host/HOST-UPGRADE-0.1.7-rc.2.md` §3.3、`docs/host/HOST-UPGRADE-0.2.0-rc.2.md` §3.3）；升宿主时复核这三类事件与 `agents.roots()`。
- 被阻塞的 turn 依赖后续 `turn/start` 解除阻塞；会话中途放弃时不主动解除。

## 目录结构

```text
src/herdr.ts              # 协议客户端：握手读取、三个 method 的报文、两次尝试、状态队列
src/state.ts              # 纯函数推导：BlockTracker（多来源计数）+ desiredState
src/main.ts               # 插件入口：事件订阅、blocked 桥、会话 / 状态上报、dispose 与 exit 释放
scripts/verify-herdr.mjs  # 端到端验证脚本（import dist/，供 herdr api snapshot 核对面板）
tests/                    # node --test 单测（state / herdr / main）
cordis.patch.yml          # bundle 挂载行（无注释，加载顺序见上文「加载顺序」）
package.json              # dsh.bundle 契约 + build / check / test / watch
```

本包为轻量包：无 `docs/` 目录，能力面与边界以本 README 为准。宿主面依据见根 `docs/host/DSH-CTX-API.md`（§1 事件载荷、§3 审批应答链、§4 Agent 注册表与 `agent/status`）；项目文档索引见根 `README.md`。

## 测试

```sh
npm run build   # tsc -p tsconfig.json → dist/
npm run check   # tsc -p tsconfig.json --noEmit
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'（35 例）
npm run watch   # tsc -p tsconfig.json --watch
```

35 例单测（state 9 + herdr 10 + main 16），覆盖握手判定、协议报文与状态队列合并、状态推导（并发阻塞计数与 `blocked` 优先级）、插件行为（会话切换、子 agent 忽略、观察者 waterfall 的阻塞与解除、dispose 释放）。
