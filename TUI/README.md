# @dsh-toolset/dsh-tui

DSH（DeepSeek Harness）进程内集成的终端 UI 插件。复用 DSH 核心服务（会话、Agent 驱动、审批链等），提供 Web UI / CLI 之外的第三种交互方式，由自研极简渲染层驱动（不依赖 Ink / Solid-TUI / node-pty，运行时唯一依赖 `chalk`）。

```
│ 真实会话流式输出             <- 左侧插件窄条(占位，仅竖线)
│ ……                          <- 右侧对话历史(assistant/chunk)
───────────────────────────── <- 横线分隔行
12:00:00|~/proj|main|—|—|—   <- 系统状态区（无标题、| 分隔；默认前景色，仅路径段蓝色；分隔线灰色；不含推理状态段）
───────────────────────────── <- 横线分隔行
> 输入消息…                   <- 回车发送, Enter 走 agent.followup
```

## 双态启动

`bin/dsh-tui.js` 是 delegating launcher（零第三方依赖，逻辑仅基于 node 内建模块）：

- **真实链路**：目标 profile（默认 `dsh-toolset-tui`，可用 `DSH_TUI_PROFILE` 覆盖）已安装本 bundle 时，bin 委托 `dsh --profile <p>` 启动——profile 树内 cordis 以插件方式调用 `main.ts 的 apply(ctx)`，创建会话/拉起 agent 并组装 renderer+app+real adapter，argv 与退出码原样透传。
- **无 DSH 退化**：无可用 profile 或传 `--demo` 时，运行 mock demo（renderer + app + mock adapter 全栈走通，不触碰 DSH）。

```

dsh-tui            # 双态自动判定
dsh-tui --demo     # 强制 mock demo（无 DSH 依赖）
dsh-tui --help

```

## 界面布局

屏幕自上而下分四区（`layout.ts` 纯函数组装，见 `DESIGN.md`「四区域布局」）：

- **顶部区域**：左侧固定 `PLUGIN_WIDTH=2` 列插件窄条（仅竖线 `│`，无边框无标题，当前为空，插件能力后续实现）；右侧对话历史，按 `historyWidth` 换行，支持滚动（↑/↓/PageUp/PageDown）；顶部/状态/输入三区之间各有横线分隔行（`SEPARATOR_ROWS=2`）。
- **系统状态区**：按可用宽度展示时间、当前目录、git 分支与 dirty 标记、模型、上下文长度、缓存命中率；内容过宽时溢出到多行并压缩顶部区域（上下文长度与缓存命中率无数据源时为 `—` 占位；模型默认 `—`，`/model` 切换本会话后更新且不落盘）。`StatusTicker` 合并节流读取（5s 一次，一次 tick 批量查 cwd/git/time，避免高频 fork 子进程）。
- **输入区**：符号代表模式、颜色代表状态。符号 4 式：`>` 一般文本（直接发送；agent 工作中则入队等待）、`!` 打断（先打断再发送）、`$` shell（当前仅符号展示，提交同普通消息）、`/` slash 命令（自动补 `/`，文本无需手输 `/`）。输入框为空时按符号键切换（`>` 键不参与、同符号幂等），Esc 退回 `>`，符号记住上次输入模式。颜色 3 态：绿=上个命令成功等待、黄=任务进行中、红=上个命令失败等待。占位提示固定「Type a message…」；审批弹窗时该区更高。
- **会话流**：模型正文位于历史区左侧、右缘与用户块左缘对称留白（左右交错，留空列数默认 4，可经 `messageGutter` 配置）；用户消息本地回显为**整体靠右的收缩块**（块内左对齐、右缘贴历史区右缘），用户输入与回答之间空一行；reasoning 仅显示最新 4 行，首条正文或 turn 结束后消失。真实链路下 reasoning（思考）按打字机节奏放缓显示，正文回复即时展示（思考放完后再铺正文；思考初始约 120 字符/秒，收到正文后剩余思考自动加速到 200 字符/秒再铺正文，每个 turn 结束后回落初始速度；`streamTypewriter` 开启；mock demo 保持原速；回合开始时先画分隔线、turn 结束不再画）。思考以缩进层级展示（无前缀文字），仅保留最新几行。模型正文渲染终端 markdown 子集（只作用于最终回答，思考过程不渲染）：行内 `**加粗**`、`*斜体*`、`***粗斜***`（同一段粗体+斜体）、`~~删除线~~`、`__下划线__`、`` `行内代码` ``（主题专用灰底：暗色深灰/浅色浅灰）、`[文字](url)` 链接（蓝色下划线，无点击交互）、`<https://…>` 自动链接（蓝色下划线）、`![alt](url)` 图片（占位显示 `[alt]` 与 URL）、反斜杠转义 `\*`/`\#`/`\\` 等（转义后的标点按普通文本、不触发样式；`^上标^`/`~下标~`/`_单下划线_` 暂不解析保持原样）；块级 fenced 代码块（```` ```lang ```` 灰底补齐到行宽、语言标签灰斜体、块内不解析 markdown）、`# 标题`（去 `#`、青粗体）、`> 引用`（单层灰竖线前缀、正文灰色不加斜体、正文开头残留的 `>` 自动隐藏）、`- [ ]`/`- [x]` 任务列表（未完成灰 / 已完成勾选灰可辨识 + 正文灰删除线）、`-`/`*`/`+` 无序列表（统一显示 `•` 圆点）/ `1.` 有序列表（数字保留）、`---` 分隔线（灰色横线）。未闭合/嵌套/歧义标记按普通文本原样保留（不误删内容）；嵌套格式（多层引用、嵌套列表等）暂不支持。
- **turn 分隔**：每个回合开始时先插入横线分隔行（上一轮内容 → 分隔线 → 新回合内容），流式输出实时合入历史；turn 结束不再画线。

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

## profile 配置（主题与流式显示）

- **内置主题**：`BlueDark`（`dark`，默认）与 `YellowBright`（`light`）两套 truecolor 配色；`/theme`（无参 toggle）仅切换当前会话，不落盘。
- 在 profile 的 `cordis.patch.yml` 中给 `dsh-tui` 节点加 `config` 即可配置以下项（缺省/非法值回退默认，非法值会在启动时告警）：

```yaml
- id: dsh-tui
  name: '@dsh-toolset/dsh-tui'
  config:
    theme: light            # dark | light（默认 dark）
    streamTypewriter: true  # 打字机总开关（默认 true：真实链路放缓流式正文显示）
    streamCharsPerSecond: 120   # 思考打字机流速，字符/秒（默认 120；收到正文后加速到 200、turn 结束回落；合法域 1..2000）
    thinkingMaxLines: 4     # thinking/reasoning 最大显示行数（默认 4，合法域 1..50，超出折叠）
    messageGutter: 4        # 用户块左缘/回复右缘对称留空列数（默认 4，合法域 0..20）
```

配置在 profile 启动时解析，改后需重启 `dsh --profile <p>` 生效。说明：`streamCharsPerSecond`/`thinkingMaxLines` 只在 `streamTypewriter: true` 时生效（mock demo 不经此配置）；`messageGutter` 同时作用于用户块左缘与回复右缘（交错对称）；`thinkingMaxLines` 计的是历史逻辑行（终端换行前），超出的思考行折叠为提示行；`streamCharsPerSecond` 按码点切分，不会拆断 emoji/CJK。

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
| `Esc` | 退回一般输入模式（提示符回 `>`）；打断请切 `!` 模式提交 |
| `Tab` | 标签页切换（预留，多会话基建落地后实现；当前提示占位） |
| `Ctrl+L` | 强制整帧重绘（绕过 delta 优化） |

## 退出契约

进程生命周期归 renderer：`close()` / SIGINT / SIGTERM 先恢复终端再退出；退出码随底层（`dsh` 委托场景透传，demo 场景 renderer 自行 exit）。

> 按键退出：`Esc` 与 `Ctrl+C` 不再触发退出（避免误触丢会话）；请用 `/quit` 命令退出。系统信号（SIGINT/SIGTERM）仍正常处理。
