# 模板体系（接取条目：docs/BACKLOG.md「模板体系」）

状态：规划　　开启：2026-09-30　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把「多步 / 可复用」的提示词流程做成可声明资产：① 共用模板格式（steps / model / args / 触发词 /
输出落点）；② 入口 = slash 命令模板（pre-steps / chain / best-of-N + 模板级模型选择）；
③ 内容 = pattern 五族（deep-research / code-review / multi-perspective / adversarial-review /
codebase-audit）。执行机制复用宿主（commands / workflow / subagents / llm），本仓只补声明与入口。

## 调研

- **宿主命令面**（已核对 TUI 侧用法）：`ctx.commands.list(agent)` → `CommandDescriptor[]`
  （name/description，TUI 启动时拉取一次用于补全）；`ctx.commands.execute(agent, line, [], signal)`
  执行整行（含参数）；注册面 `ctx.commands.register`（官方 `command-*` 包使用；精确签名实现时从
  profile 官方包核对）。TUI 路由：本地 `LOCAL_COMMANDS` 优先，未命中转发宿主注册表（`runCommand`）。
- **执行面**：`workflow`（模型面工具 + `workflow-ptc` 引擎，脚本内 `agent()`/`pipeline()`/`parallel()`）、
  `subagents` 面、`llm`（`agent-default-model`，默认 `deepseek-flash`；会话词汇表有 `model/selection` 事件）。
- **模板资产现状**：仓库内没有模板目录/加载器；参考 `pi-prompt-template-model`（对比文档 §3.4）。
- **边界（既定）**：执行机制复用宿主；模板只做「声明 + 入口 + 内容」，不新建执行器；
  与 task-engine 的接口 = 模板可选产出顶层契约（叶子 `executor` 声明属 #58，不在本任务范围）。

## 决策

用户 2026-09-30 裁定：

1. **范围**：①②③ 全做（格式 + 入口 + 五族内容）。
1. **存放**：双源——仓库 `templates/`（随包提供）+ 用户 `~/.dsh/command-templates/`（本地新增 / 覆盖，
   同名以用户为准）。
1. **模板级模型**：仅本次调用生效（不改会话默认；无副作用、可预测）。
1. **best-of-N**：裁判模型（多候选并行 → 裁判步选最佳）。

实现者补充（调研已核对，落进规划）：

1. **入口形态**：新包 `command-template` 用宿主命令面注册（`ctx.commands.register({name, description, input, handler}) → disposer`；`CommandInvocation.rawInput` = 模板参数；`CommandResult{kind:'success' |'error', text}`）——命令经宿主注册表出现在 TUI 补全（`ctx.commands.list(agent)`）。
1. **命令粒度**：每条模板注册为独立 slash 命令（如 `/review`、`/deep-research`），另注册 `/tpl` 管理
   命令（`list` / `show <name>` / `reload`）。
1. **步骤类型（v1 两种）**：`prompt`（把展开后的文本注入当前会话，无模型覆盖）、`agent`（一次性子代理
   运行，`provider`/`model` 覆盖仅作用于该次运行）。
1. **模型覆盖实现**：子代理 `AgentOptions` 默认为父会话 provider/model，声明处显式覆盖（实现时核对
   `ctx.subagents` 一次性运行入口与 `ctx.llm` 直调面）。

## 规划

任务拆分：A 模板格式与加载器 → B 命令入口与执行器 → C 五族模板内容 → D 装配与文档。

计划改动文件清单：

1. `command-template/src/types.ts`：模板格式类型（`TemplateSpec` / `StepSpec` / `RunOptions`）与错误码。
1. `command-template/src/frontmatter.ts`：模板文件解析（YAML front-matter + 正文步骤；纯函数）。
1. `command-template/src/registry.ts`：双源扫描（仓库 `templates/` + `~/.dsh/command-templates/`，
   同名用户优先）、抓取/重载、按名解析。
1. `command-template/src/args.ts`：参数展开（`$ARGUMENTS` / `$1..$n` / 缺参错误）。
1. `command-template/src/steps.ts`：步骤执行（`prompt` 注入当前会话；`agent` 一次性子代理；`chain`；
   `best-of-N` 并行 + 裁判步；`pre-steps`）。
1. `command-template/src/main.ts`：cordis 入口（`inject: ["commands","agents","sessions","subagents"]`；
   注册每个模板命令 + `/tpl`；防御降级；`provide("commandTemplate")` 只读查询面）。
1. `command-template/tests/*.test.ts`：frontmatter / args / registry（双源优先级）/ steps（mock 子代理与
   注入）/ 命令注册（含 `/tpl`）/ 降级路径。
1. `templates/`：五族各一份（`deep-research.md` / `code-review.md` / `multi-perspective.md` /
   `adversarial-review.md` / `codebase-audit.md`），薄模板（结构 + 步骤 + 模型建议），流程内容可后续迭代。
1. 装配与文档：`scripts/install.sh`（canonical_pkgs 增 `command-template`）、根 `README.md` +
   `README.zh.md`（插件表 / 文档索引 / 计数）、`docs/ROADMAP.md` §2.A 判据回写、`command-template/README.md`。
1. 本追踪文档；`docs/BACKLOG.md` 状态（关闭时移除条目）。

**明确不做**：不实现执行器（用宿主 subagents / workflow）；不做模板市场 / 分享 / 版本管理；
不改 TUI 命令面（模板命令经宿主注册表自动出现在补全）；不在本任务实现叶子 `executor` 声明（属 #58）。

## 实现记录

（待补）

## 测试与证据

（待补）

## 收尾

（待补）
