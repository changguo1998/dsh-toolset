# 本仓插件复用官方包审计（接取条目：`docs/BACKLOG.md`「本仓插件复用官方包审计」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按用户 2026-10-02 裁定「本项目的插件也尽量使用官方包而不是自己造新的」，盘点本仓 18 个包（TUI + 17 插件）与官方包（基线 `0.2.0-rc.2`，已挂 102 个官方行）的重叠，逐项给出**改用 / 保留 / 并存**结论与理由，并列出可执行的复用改造点。产出落 `docs/ARCHITECTURE-REUSE.md`。

## 调研（2026-10-02）

- **官方能力面基线**：`docs/host/HOST-PACKAGES.md`（包 → 服务字典，0.2.0 口径）+ `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`（消费面零 diff 的逐项判定）+ 本机安装树（277 个 `dsh-*`）的描述扫描（按 digest / context / memory / rule / guard / title / workflow / job / goal / edit 十类关键词找官方对应面）。
- **官方没有对应物的关键结论**（三处扫描均为空或只命中无关包）：
  - **无「文件摘要 / 结构视图」类包**（`digest` 关键词只命中 `compaction-basic` / `session-turn-outline`，都不是文件摘要）；
  - **无「持久记忆 / 知识库 / 检索」类包**（`memory` 关键词零命中）；
  - **无「哈希锚定编辑」类包**（`edit` 关键词命中的是 `tool-fs` / `tool-str-replace-editor`，均为文本级编辑）。
- **官方有、我们正在重叠的面**：`session-stats` + `session-turn-outline`（投影）与 `context-report`；`spill` / `spill-policy` / `compaction-tool-result-pruner` 与 `output-compress`；`tool-fs` / `tool-str-replace-editor` 与 `hash-edit`；`session-title-llm` 与 `session-title-cutoff`；`commands` + `workflow` 与 `command-template`；`sandbox-policy` / `permission-presets` / `experimental-auto-review` 与 `security-guard`；`hook-protocol` / `hooks-*` 与 `rule-engine`；`workflow` / `tool-workflow` / `tool-todo` / `plan-mode` 与 `task-engine`。
- **已复用的官方面**（审计要写清，避免「重复造轮子」的误判）：`ctx.tools` 注册面、`ctx.subagents`（task-engine / command-template 的 subagent 后端）、`ctx.workflowEngine`（workflow 后端）、`ctx.ptcRuntime`（command 后端）、`ctx.sessionProjections`（context-report）、`ctx.sessionTitle`（cutoff 注册 provider）、`ctx.goals` + `ctx.userQuestions`（goal-contract / task-engine human RET）、`ctx.approval`、`ctx.lsp`（code-map 语义层）、`ctx.jobs`（TUI）、`ctx.sessionQuery`（TUI / session-channel 复用读面）、`ctx.skills`（rule-engine 技能面）、`loadHost('@deepseek-ai/dsh-session-title-llm')`（session-title-cutoff 复用官方生成策略）、`session/steps` 事件面（rule-engine / knowledge-base / output-compress）。

## 决策

- **D1（审计口径）**：判据三条——① 能力是否重合（同一诉求）；② 官方是否有等价物；③ 我们是否已在复用官方底座。三者交叉后给「改用 / 保留 / 并存」。
- **D2（结论分布）**：**改用 0 项**（没有任何本仓包的整体能力被官方完整覆盖）；**保留 12 项**（官方无等价物）；**并存 6 项**（与官方面部分重叠，但诉求或模型面不同）。
- **D3（并存项的边界要写清）**：重叠即写「谁负责哪一段」，否则模型侧会出现「两套同类工具」的选择成本问题（先例：`fs_digest.signatures` 与 `ast-tools.outlineFile`）。
- **D4（可执行改造点不新立编号条目）**：本次审计产出的复用改造点写入 `docs/ARCHITECTURE-REUSE.md` 的「可执行改造清单」，并汇总进 `docs/BACKLOG.md` §「未立项观察项」（不打断当前按序执行的条目队列；用户择时决定是否立项）。
- **D5（不挂的官方面也写进文档）**：`tool-str-replace-editor`（与既有 `read`/`edit`/`hash-edit` 争模型面）等「可挂但不该挂」的包，在审计文档里给出判定，供挂载面第二批参考。

## 计划改动文件清单

- `docs/ARCHITECTURE-REUSE.md`（新，主产出）
- `docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理；§「未立项观察项」追加审计产出的改造点）
- 本追踪文档（唯一过程记录）

## 实现记录

1. 产出 `docs/ARCHITECTURE-REUSE.md`：18 包结论总表（改用 0 / 保留 12 / 并存 6）+ 保留项共同理由 + 并存项边界表 + 已复用官方面（按代码实测）+ 可执行改造清单（A-E）+ 「可挂但不该挂」+ 复现命令 + 修订记录。
1. 索引与观察项：`README.md` / `README.zh.md` 文档索引补该文件；`docs/BACKLOG.md` §「未立项观察项」追加审计产出的改造点与三条新观察项。
1. 子代理审阅 → 修正（见下）→ 复核结论「有条件通过」的 10 条问题全部修入。

## 审阅（子代理，2026-10-02）

**结论：有条件通过** → 已按修正重写产出。审阅者独立复现了 6 项检查（三根支点、结论分布、§3 复用面逐项、并存边界、改造清单可行性、漏项扫描），推翻/修正了以下事实，均已写入 `docs/ARCHITECTURE-REUSE.md` §7：

| 原结论 | 修正 | 依据 |
|---|---|---|
| 「官方 `edit` 无陈旧校验」 | 官方**有**文件级读后改前 + 版本守卫（`fs-observation-policy` 已挂载，`FS_STALE_VERSION`） | 包描述 / README、`dsh-fs-local/lib/index.js:888` |
| 「官方无检索类包」 | 官方**有**会话日志 FTS5 检索（`session-query-sqlite`，已挂载、缺省未开启） | 包描述、base patch `:145-152` |
| 「§3 已复用官方面」凭印象 | 8 处声称复用但代码里没有（`rule-engine`→`skills`、`security-guard`→`approval`、`metric-loop`→`sessionProjections`、`task-engine`→`ptcRuntime` 等）→ 按代码实测重写，并补 4 处漏记（`tokenMeter` ×2、`ptcRuntime` reflect、TUI 的 `agentPresets`/`settings`） | 逐包 grep |
| 「`output-compress` 可能双重截断」 | **不存在**（我们不回写事件，只以 spill 为上游输入） | `output-compress/src/{hooks,trigger}.ts` |
| 「`metric-loop` 官方只有 schedule」 | 官方还有 `tool-ralph` / `goal-round-driver`（均已挂载） | `HOST-PACKAGES.md`、base patch |
| 改造 C 落点 `experimental-schedule-bundle` | 应为 `@deepseek-ai/dsh-schedule`（bundle 是 Web 组合包装）；且会新增模型工具面 | bundle 自述 + `metric-loop/src/engine.ts:227` |
| 改造 E 落点 `HOST-PACKAGES.md` | 该文件是生成物，会被重生成覆盖 → 改落 BACKLOG 观察项 / `profiles/example` 注释 | `HOST-PACKAGES.md` §6 |
| `code-map`「已复用 `ctx.lsp`」 | LSP 三件套**不随包分发** → 该路径当前**不可达**（缺省走 structural 回落） | `HOST-PACKAGES.md` §4、安装树实查 |

补充：`client-ui-*` 计数（53 而非 62）、`ui-schedule` 实为 `client-ui-schedule`、「`loadHost`」表述改为「按约定路径解析并动态 import 官方模块」。

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理；其余条目重编（Markdown 结构视图 → #1，ast-tools 模型侧工具 → #2，md-logic → #3，md-map → #4，usage 口径 → #5，命令模板终态 → #6，executor 隔离 → #7，STATUS 对齐 → #8）。
- 审计产出的改造点（A-E）与三条新观察项落在 `docs/BACKLOG.md` §「未立项观察项」（**未**新立编号条目——避免打断按序执行的队列，用户择时决定是否立项）。
- 本追踪文档移入 `docs/archived/`。
