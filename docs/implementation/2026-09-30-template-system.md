# 模板体系（接取条目：docs/BACKLOG.md「模板体系」）

状态：实现　　开启：2026-09-30　　关闭：
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

1. **入口形态（2026-09-30 修订：统一前缀）**：只注册一条 `playbook` 命令（子命令 `list` / `show` / `reload` /
   `<模板> [参数]`），模板不再各自占命令名（减少命名空间占用；原「每模板一条命令」设计作废）。
   实现：`ctx.commands.register({name, description, input, handler}) → disposer`；`CommandInvocation.rawInput` = 模板参数；`CommandResult{kind:'success' |'error', text}`）——命令经宿主注册表出现在 TUI 补全（`ctx.commands.list(agent)`）。
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

- 2026-09-30：新包 `command-template/`（`src/{types,frontmatter,args,registry,steps,subagent,host,main}.ts`）；
  双源目录加载、YAML 子集解析（零依赖，显式拒绝流式集合）、参数展开（`$ARGUMENTS` / `$1..$9` /
  `{{stepId}}`）、步骤执行（prompt 注入 / agent 一次性子代理 / bestOf + judge 裁判）、
  命令注册（每模板一条 + `/tpl list|show|reload`）与只读服务面 `commandTemplate`。
- 2026-09-30：`templates/` 五族范例（code-review / deep-research / multi-perspective /
  adversarial-review / codebase-audit）；装配与文档：`scripts/install.sh`（canonical_pkgs）、
  `AGENTS.md`（计数与名单）、根 `README.md` / `README.zh.md`（插件表 + 目录树 + 计数）、包 `README.md`。
- 2026-09-30（用户并入 #60）：入口改为统一前缀 `playbook`（`/playbook <模板> [参数]` + list/show/reload），
  移除 `/tpl`；`reservedNames` 语义改为保留子命令名；测试改入口分派用例；check/build/test 8/8 ✓。
- 2026-09-30（真机第三轮观察，待处理）：两笔 `code-review` 命令**都没有 `command/done`**（旧命令名
  `cmd-db9ca86f-3` 与 `/playbook` 版 `cmd-8c6397fa-2`），TUI 里两个子代理显示为不活动：
  `774a2cbc` 以 `flush on a closed handle` 结束（已死），`c57b192e` 停在第 23 步（无 step/end）。
  疑点：① 命令被取消/子代理死亡后，我们的 runner 是否总能拿到终态并返回（否则命令悬挂）；
  ② `stepTimeoutMs`（缺省 600s）触发的 abort 是否真的中止了子代理。属本任务缺陷，收尾前需修或立条目。
- 2026-09-30（真机第二轮调整）：`/playbook list` 通过；`code-review` 首个子代理跑到第 23 步（模板提示
  鼓励工具探索，成本高）→ 用户裁定取消并收紧：模板改为「只允许读取指定文件、禁止全仓搜索、工具调用
  下限化」；`list` 输出改为子命令写法（`playbook <模板>`）；模板文件不进 `format`（YAML front-matter /
  块标量会被格式化器扰动，按注释 YAML 例外的同口径处理）。
- 2026-09-30（真机第一轮）：`/tpl list` 通过（5 模板列出）；`/code-review` 报
  `step_failed：子代理未正常结束（failed：error）`。子会话日志定位根因：
  `session event "subagent/descriptor" carries non-JSON-serializable data` ——
  `provider.start` 请求漏了宿主要求的 `descriptor`（`{version, mode:"one-shot", provider, label?}`，
  版本号运行时从宿主 `SUBAGENT_DESCRIPTOR_VERSION` 读取，缺省 3）。已补 descriptor 并重跑
  check/build/test（8/8）；待真机复测。
- 计划偏差（记录）：模板放**包内** `command-template/templates/`（而非仓库根 `templates/`）——
  随包发布更自洽（`files` 含 templates），用户目录不变；`agent` 步骤经宿主 `ctx.subagents`
  provider（`provider.start` + `settleRun`），宿主包按 `$DSH_HOME` 运行时解析，不新增依赖。

## 测试与证据

- `npm --prefix command-template run check` ✓；`build` ✓；`npm run test` **8/8** ✓
  （frontmatter 解析与错误路径 / args 展开 / 双源覆盖与坏模板隔离 / 步骤执行（注入 + 串链 + bestOf 裁判 +
  失败码）/ 服务注册与 `/tpl` 运行）。
- 全仓 `npm run check` 待跑（收尾前补）。
- 真机：待人工验证（重启后 `/tpl list` 应列出随包 5 个模板；跑一个 prompt 型模板验证注入；
  跑一个 agent 型模板验证一次性子代理与模型覆盖）。

## 过程中新增条目（用户 2026-09-30 口述）

- 项目 #59 slash 命令命名规范：不用缩写（盘点 + 改名清单 + 兼容策略）。
- 项目 #60 模板体系统一入口 → **已并入本任务**（用户 2026-09-30 裁定）：入口 = `/playbook`，条目已从
  BACKLOG 移除。
- TUI #53 `/help` 输出按普通文本显示（不要信息提示蓝）。
- 项目 #61 rule-engine 的用户提示（`[rule-engine] warn: …`）显示在输入区、不在历史区；期望进活动区并可回溯（或改走会话 notice 通道）。

## 收尾

（待补）
