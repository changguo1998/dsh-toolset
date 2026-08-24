# @dsh-toolset/dsh-tui

DSH（DeepSeek Harness）进程内集成的终端 UI 插件。复用 DSH 核心服务（会话、Agent 驱动、审批链等），提供 Web UI / CLI 之外的第三种交互方式，由自研极简渲染层驱动（不依赖 Ink / Solid-TUI / node-pty，运行时唯一依赖 `chalk`）。

```
┌─ plugin ───┐ 真实会话流式输出                 <- 左侧插件窄条(占位)
│            │ ……                              <- 右侧对话历史(assistant/chunk)
└────────────┘
 时间 12:00:00 · 目录 ~/proj · git main · 模型 — · 状态 idle · ctx — · cache —   <- 系统状态区
❯ 输入消息…                                   <- 回车发送,Enter 走 agent.followup
```

## 双态启动

`bin/dsh-tui.js` 是 delegating launcher（零第三方依赖，逻辑仅基于 node 内建模块）：

- **真实链路**：目标 profile（默认 `dsh-toolset-tui`，可用 `DSH_TUI_PROFILE` 覆盖）已安装本 bundle 时，bin 委托 `dsh --profile <p>` 启动——profile 树内 cordis 以插件方式调用 `main.ts 的 apply(ctx)`，创建会话/拉起 agent 并组装 renderer+app+real adapter，argv 与退出码原样透传。
- **无 DSH 退化**：无可用 profile 或传 `--demo` 时，运行 mock demo（renderer + app + mock adapter 全栈走通，不触碰 DSH）。

```
dsh-tui              # 双态自动判定
dsh-tui --demo       # 强制 mock demo（无 DSH 依赖）
dsh-tui --help
```

## 界面布局

屏幕自上而下分四区（`layout.ts` 纯函数组装，见 `DESIGN.md`「四区域布局」）：

- **顶部区域**：左侧固定 `PLUGIN_WIDTH=14` 列插件窄条（占位框，当前为空，插件能力后续实现）；右侧对话历史，按 `historyWidth` 换行，支持滚动（↑/↓/PageUp/PageDown）。
- **系统状态区**：横向一行展示时间、当前目录、git 分支与 dirty 标记、模型、推理状态、上下文长度、缓存命中率（后三者无数据源时为 `—` 占位）。`StatusTicker` 合并节流读取（5s 一次，一次 tick 批量查 cwd/git/time，避免高频 fork 子进程）。
- **输入区**：`❯` 提示符 + 硬件光标；审批弹窗时该区更高。
- **turn 分隔**：每个对话 turn 结束后插入横线分隔行，流式输出实时合入历史。

## 作为 bundle 挂载（在 DSH profile 中使用）

1. 创建/进入一个 profile，把本包加为依赖并声明 bundle（参见示例 profile `~/.dsh/profiles/dsh-toolset-tui`）：

```jsonc
// <profile>/package.json
{
  "dependencies": { "@dsh-toolset/dsh-tui": "file:<本包路径>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsh-toolset/dsh-tui"] } }
}
```

1. 安装依赖并核对组合树：

```sh
cd <profile> && pnpm install
dsh --profile <p> --dump-config        # 应出现 - id: dsh-tui 行
```

1. 启动（需要 DEEPSEEK_API_KEY 与真实终端）：

```sh
dsh --profile <p>
```

从 npm 分发的正式安装形态为 `dsh plugin --profile <p> add <包名>`（待发布后使用），本地开发期用 `file:` 依赖即可。

## 构建 / 测试

```sh
pnpm build    # tsc → dist/（无 bundler，Node CLI）
pnpm check    # tsc --noEmit 类型检查
pnpm test     # node --test 全量（renderer 解码 + adpater fake-ctx 单测）
pnpm demo     # 构建后跑 mock demo
```

- `files` 发布字段覆盖 `dist/`、`bin/` 等；`cordis.patch.yml` 由 `package.json` 的 `dsh.bundle.patch` 引用。
- 事件契约与归一化映射见仓库根 `DSH-CTX-API.md` 与 `src/…/adapter/dsh.ts` 文件头。

## Slash 命令

以 `/` 开头的输入按 slash 命令处理（不走 `agent.followup`，不进入模型历史/会话记录）：

- **渲染相关命令 → 本地小命令表**（app 层直接处理，不经 adapter）：
  - `/help` — 显示本地命令帮助
  - `/clearscreen`（简写 `/cls`）— 清空显示缓冲（只清 UI，不动会话上下文）
  - `/quit` — 关闭 renderer 退出
- **其他功能命令 → commands 注册表**（官方 `dsh-commands` 机制）：输入路由到 `adapter.runCommand` → `ctx.commands.execute(agent, line)`，结果/错误经 `notice` 事件展示在 UI 缓冲。未命中注册表 → 提示未知命令（官方 fail-close 策略，绝不把 slash 行发给模型）。
- demo 模式无 commands 注册表，非本地 `/xxx` 回提示。

## 按键

| 按键 | 行为 |
| --------------------------- | -------------------------------------------------------------------------- |
| `↑` / `↓` | 滚动 1 行 |
| `PageUp` / `PageDown` | 滚动 10 行 |
| `Home` / `End` | 回到底部 / 跳到顶部 |
| `←` / `→` | 输入框光标移动 |
| `Backspace` | 删除光标前字符 |
| `Enter` | 提交输入（普通文本 → agent；`/` 开头 → slash 命令） |
| 可打印字符（含 CJK） | 插入输入框 |
| 终端粘贴（bracketed paste） | 插入粘贴文本 |
| `y` / `n` | 审批弹窗确认 / 拒绝 |
| `Esc` | 打断当前思考/turn（真实链路 `agent.cancel({kind:'user'})`；demo 提示忽略） |
| `Tab` | 标签页切换（预留，多会话基建落地后实现；当前提示占位） |
| `Ctrl+L` | 强制整帧重绘（绕过 delta 优化） |

## 退出契约

进程生命周期归 renderer：`close()` / SIGINT / SIGTERM 先恢复终端再退出；退出码随底层（`dsh` 委托场景透传，demo 场景 renderer 自行 exit）。

> 按键退出：`Esc` 与 `Ctrl+C` 不再触发退出（避免误触丢会话）；请用 `/quit` 命令退出。系统信号（SIGINT/SIGTERM）仍正常处理。
