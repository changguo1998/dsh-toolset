# 插件开发状态追踪

> 本表只记状态，不记细节：功能与边界见各包 `README.md`，未完成项见 `DEVELOPMENT-BACKLOG.md`；已完成的实施清单归档在 `archive/`（如 `TUI-REFACTOR-TASKS.md`、`TUI-COMMANDS-TASKS.md`），仅作历史记录，不是现状来源。
> 状态取值：未开始 / 进行中 / 阻塞 / 完成 / 已取消 / 暂缓。状态变化时更新本表。
> 单测数为 `npm test` 实测值（`node --test` 用例数）。

## 总览

- `TUI/` 终端界面包已完成：排版重构（Box 模型）、排版缓存与绘制合帧、主题调色板可配置化、P2 命令扩展与自动清理空会话等；现状口径见 `TUI/SPEC.md`、`TUI/IMPLEMENTATION.md`、`TUI/README.md`（重构任务清单已完成并归档：`archive/TUI-REFACTOR-TASKS.md`）。
- 12 个插件全部完成并合入 main：herdr-integration、task-engine、knowledge-base、goal-contract、metric-loop、output-compress、fs-digest、hash-edit、ast-tools、security-guard、code-map、context-report。
- `rate-guard` 已取消（不迁移）：pi 侧已移除，能力由 pi 核心 provider-retry 内建 + 扩展 provider-guard 承接；dsh 侧一般退避由官方 `llm-retry` 覆盖，决策见 `archive/PI-DSH-FEATURE-COMPARISON.md` §5.1（归档调研）。
- 剩余 P2 插件（workflow-ext / web-ext / session-broker / command-template）与内容资产未开始。
- 宿主基线：本地安装 dsh `0.1.5-rc.2`。官方包总量（240 个）、分类说明与 fff 挂载清单（82 个）见 `HOST-PACKAGES.md`；该基线内**无 worktree 隔离包、无跨会话消息包**（对应待办 #15 / #30）。

## 状态表

| 插件 | 阶段 | 状态 | 备注 |
|------|------|------|------|
| herdr-integration | P1 | 完成 | herdr 面板桥：agent 状态上报 + ask-user/approval/turn 三类 blocked 事件桥接，35 单测 |
| task-engine | P0 | 完成 | Frame 状态机、decompose/implement/stop/status 工具族、机械+语义门禁、RET 三级路由、fan-out 就绪池，42 单测 |
| knowledge-base | P0 | 完成 | sources/chunks 两张基表 + 两张 FTS5 虚表（porter/trigram，external content 影子表，共 4 张表）、两级写策略与淘汰提升、持久记忆 CRUD，39 单测 |
| goal-contract | P1 | 完成 | interview 式 Done-when 契约起草，落 dsh-goal 事件源并回读比对，35 单测 |
| metric-loop | P1 | 完成 | 指标循环引擎与计划续排（plateau / 轮数 / 时间 / token 边界、cadence 唤醒），35 单测 |
| output-compress | P1 | 完成 | 大输出确定性摘要 + 切片索引入 knowledge-base 共享库，42 单测 |
| fs-digest | P1-P2 | 完成 | outline/signatures/pruned 三模式文件摘要，42 单测 |
| hash-edit | P1 | 完成 | LINE:HASH 锚定读写编辑（stale 整批拒绝），43 单测 |
| ast-tools | P1 | 完成 | ast-grep 搜索/替换/大纲/规则执行，27 单测 |
| security-guard | P1-P2 | 完成 | 危险命令黑名单 + 敏感文件保护策略层，37 单测 |
| code-map | P2 | 完成 | 结构索引（符号表 + import 图）+ callers/callees/cycles/impact + 项目/模块报告，14 单测；首版边界：引用为候选（无 LSP 语义层）、callees 文件级、索引惰性构建，见 `code-map/DESIGN.md` |
| context-report | P2 | 完成 | 会话上下文/用量报告：host-only 投影 `sessionContext`（回合/步、模型与工具墙钟、首 token、token 分桶）+ `context_report` 工具（三档 detail）+ `contextReport` 服务，42 单测；边界：客户端快照无本 key、上下文构成待宿主公开读面，见 `context-report/README.md` |
| TUI 扩展 | P2 | 完成（P2 部分） | 命令面：7 项纯 TUI 命令、A1-A5（/task /guard /memory /loop /contract）、/workflows、/council、/search；另有声音提醒、/verbose 两态、会话自动清理（`session.autoCleanEmpty`，默认开）等。C6/C7 裁定维持排除、C8 /review 裁定搁置；现状口径见 `TUI/COMMANDS.md`、`TUI/COMMANDS-SPEC.md`（实施清单已完成并归档：`archive/TUI-COMMANDS-TASKS.md`） |
| rate-guard | P2 | 已取消 | 不迁移，见总览 |
| workflow-ext | P2 | 未开始 | |
| web-ext | P2 | 未开始 | |
| session-broker | P2 | 未开始 | |
| command-template | P2 | 未开始 | |
| 内容资产 | P2 | 未开始 | workflow 模板 + skill 内容 |

依赖关系（影响排期）：workflow-ext（未建包）依赖 task-engine 的契约与执行器面；output-compress 依赖 knowledge-base；code-map 经 `link:` 依赖 `@dsh-toolset/ast-tools`（profile 挂载 code-map 时必须同时挂载 ast-tools）；goal-contract / metric-loop 与其余包独立（goal-contract 的 goal 面来自宿主 dsh-goal，不经 task-engine）。
