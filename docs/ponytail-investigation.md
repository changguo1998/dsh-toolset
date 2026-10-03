# 调研：`ponytail`（lazy senior dev mode）与「作为新插件加入本项目」的可行路径

状态：完成（调研）　　日期：2026-10-02　　范围：**只读调研，不写实现**
来源：`~/GithubRepos/ponytail`（v4.10.3，MIT，`@dietrichgebert/ponytail`）

## 一、它是什么

一句话：**「懒资深工程师」人格包** —— 用提示词 + 钩子 + 技能，逼 Agent 写**最少、最短、能跑**的代码（宣传：代码量 −54%（极端 −94%）、成本 −20%、速度 +27%）。

核心是一份**决策阶梯**（`AGENTS.md`）：动手前逐级停在第一级成立的判据上 ——

1. 要不要做（YAGNI）→ 2) 本仓已有可复用？→ 3) 标准库能做？→ 4) 平台原生特性覆盖？→ 5) 已装依赖解决？→ 6) 能写成一行？→ 7) 才写最少代码。
   配套规则：不加未请求的抽象/依赖/样板；删除优于新增；无聊优于聪明；文件越少越好；修 bug 修根因；**最短 diff 胜出**（但必须先理解问题）。

## 二、它的接入形态（实测仓内文件）

| 形态 | 文件 | 说明 |
|---|---|---|
| Gemini CLI 扩展 | `gemini-extension.json` | `{name, version, contextFileName: "AGENTS.md"}` —— 把 `AGENTS.md` 当上下文注入 |
| Claude / Codex / Copilot / Cursor 钩子 | `hooks/*.json` + `hooks/ponytail-*.js` | 激活、模式跟踪、配置、指令注入、运行时（JS） |
| 命令面 | `commands/*.toml`（`ponytail` / `-audit` / `-debt` / `-gain` / `-help` / `-review`） | 斜杠命令式入口 |
| 技能面 | `skills/` | 供 Agent 技能体系加载 |
| MCP 服务 | `ponytail-mcp/` | 独立 MCP server（可被任意支持 MCP 的宿主挂载） |
| 其它宿主 | `plugin.json` / `plugin.yaml` / `opencode.json` / `pi-extension/` | OpenCode / pi 等适配 |
| 安装脚本 | `scripts/`、`after-install.md` | 安装/喂给宿主 |

**结论**：它不是 cordis 插件、也不是 DSH bundle；是**跨宿主的提示/技能/钩子/MCP 包**。

## 三、加入本项目的三条候选路径

| 路径 | 做法 | 代价 | 评价 |
|---|---|---|---|
| **a. 封装为 `@dsh-toolset/*` 插件** | 新包 `ponytail/`：`cordis.patch.yml` + `dsh.bundle`；用 `rule-engine` 或自注册注入 **AGENTS.md 阶梯文本**（做成规则/注入），命令面用 TUI 斜杠命令或包内工具暴露 | 中（1-2 天）：需把「提示注入」落到 DSH 契约（rule-engine 注入 / skill 装载），不做钩子搬运 | **推荐**：本仓已有 `rule-engine`（规则注入）与 `skill` 体系，阶梯文本天然是「注入物」；不需引入 JS 依赖 |
| **b. 挂载其 MCP 服务** | profile 里配 `ponytail-mcp` 为 MCP server（`dsh-mcp-client` 已内置），工具名前缀 `mcp__*` 需进 `unknownToolAllowlist` | 小（0.5 天）：改 profile + allowlist；但**不注入人格/阶梯**（只是工具） | 备选：想用它的 MCP 工具而非提示时 |
| **c. 仅借鉴、不引入** | 把「决策阶梯」写进本仓 `AGENTS.md`/skill（已有 `karpathy-guidelines` 与之高度重叠） | 极小（0.5 h） | 最小代价；若只想要「少写代码」的效果，本仓现有 skill 已覆盖大半 |

**重叠提示**：本仓已装 `karpathy-guidelines`（简单优先/外科手术式改动/目标驱动）与 `i-have-adhd`（输出形态），与 ponytail 的阶梯**理念重叠**；ponytail 的增量主要是**钩子化的强制激活**与 `-audit` / `-debt` / `-gain` 命令面。

## 四、建议（供后续条目决策）

1. 若要**效果**（少写代码）：选 **c**，把阶梯 7 条并入现有 skill/AGENTS（半小时）。
1. 若要**可切换的模式 + 命令面**：选 **a**，新包只做「提示注入 + 斜杠命令」，**不搬** `hooks/*.js`（DSH 无该钩子面）。
1. 若要**它的 MCP 工具**：选 **b**，并把 `mcp__ponytail__*` 加进 `unknownToolAllowlist`。

## 五、未做 / 待确认

- 未读完全部 `docs/`、`skills/`、`benchmarks/`（只读结构与入口文件）；未评估 `ponytail-mcp/` 的具体工具面。
- 未做与 `rule-engine` 注入格式的对照（下一步若走 a 需先读 `rule-engine/docs/DESIGN.md` 与 `skills/` 装载契约）。
- 未落地任何改动（本条目为调研）。
