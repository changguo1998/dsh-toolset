# dsh-toolset 路线图

> 职责：项目的**方向**与完成判据（本仓 = DSH 进程内集成插件工具集 + 自带终端界面）
> 不负责：进度、排期、条目编号与依赖——见 `docs/BACKLOG.md`（§1 索引、§3 里程碑）
> 过期条件：新增或废弃方向时更新本文；未列入的方向不代表不做，只表示尚未成形

## 1. 定位与边界

- 本仓是 DSH 的**进程内集成插件工具集**加一套自带终端界面（TUI）：能力在本机单用户、进程内生效，经 cordis 服务面与宿主交互。
- 现有基座：TUI + 20 个插件包（任务引擎、知识库、规则注入、代码地图、文件摘要、符号规范、会话通道、Markdown 结构 / 文档地图、模板体系、ponytail 等）；集成契约以各包 `cordis.patch.yml` + `package.json` 的 `dsh.bundle` 为准，包与能力清单见根 `README.md`「组成」。
- 边界（沿用既有裁定）：不做跨机传输、不复用系统 Redis、不做离线消息队列、不引入常驻守护进程；需要时先在 `docs/BACKLOG.md` 立项讨论。

## 2. 方向

> 依据一律用**文档路径**引用（`docs/BACKLOG.md` 的 `#n` 随整理重编，不作跨引用）；已完成项的落点见 `docs/BACKLOG.md` §1 索引与各层 `docs/archived/`。

### A. 工作流能力成为一等公民

- **目标**：把「多步 / 多角色 / 可复用」的工作流，从临时编排变成可声明、可复用、可观测的能力。
- **判据**：模板族可声明并复用（**已落地**：`/playbook` 统一入口 + 五族模板，见 `command-template/README.md`）；命令模板可组合（pre-steps / chain / best-of-N，已支持）；每步可指定模型并记账用量（模型覆盖 + 叶子 `executor` 的 `subagent` / `workflow` / `command` 后端与用量标注**已落地**，见追踪文档 `docs/archived/2026-10-02-task-engine-usage-metric.md`）；需要时能隔离执行（git worktree，**已落地**：`task-engine/README.md`「执行后端与隔离」、追踪文档 `docs/archived/2026-10-02-executor-worktree-isolation.md`）。
- **边界**（2026-09-30 决策）：执行机制（并发 / 隔离 / 模型路由 / 计量）复用宿主 `workflow` / `subagents` / `llm` / `token-meter`；本仓只补「不变量与声明」——task-engine 自研帧栈、拆解门禁、验收与事件溯源，模板负责入口与内容，叶子用 `executor` 声明执行后端（见 `task-engine/README.md`「边界与外包」）。

### B. 会话之间可协作

- **目标**：多个 dsh 会话能互发消息、委托任务、同步状态，并在界面里可读。
- **判据**：消息通道可用（已落地）；会话别名支持可读寻址；委托-回收具备任务语义；插件状态可跨会话共享；界面能显示别名。
- **依据**：`session-channel/README.md`、`session-channel/docs/DESIGN.md`；追踪文档 `docs/archived/2026-09-29-cross-session-intercom.md`、`docs/archived/2026-09-30-cross-session-delegation.md`、`session-channel/docs/archived/2026-09-29-shared-kv.md`。

### C. 会话资产自动沉淀

- **目标**：会话过程里的决策、结论与工具结果自动进入知识库，并被巩固与淘汰。
- **判据**：事件入库具备过滤 / 去重 / 容量 / 隐私边界；记忆能自动提升、合并相似项、淘汰陈旧项。
- **依据**：`memory-base/README.md`、`memory-base/docs/DESIGN.md`、追踪文档 `docs/archived/2026-10-02-knowledge-events-and-memory-consolidation.md`。

### D. 宿主演进与文档资产

- **目标**：宿主演进（新版本、新契约）能被稳定跟进；调研结论沉淀为可复用文档；宿主能力按需接成插件（如 PDF / 文档结构视图）。
- **判据**：升级后有复核机制与记录（`docs/host/`）；规划文档分工明确（方向在本文、进度在 BACKLOG）；宿主能力接入有明确取舍（对照表见 `docs/ARCHITECTURE-REUSE.md`）。
- **依据**：`docs/host/HOST-UPGRADE-*.md`、`docs/ARCHITECTURE-REUSE.md`、`docs/BACKLOG.md` §1 索引。

### E. 界面与输出规范

- **目标**：界面体验与模型输出规范收敛到「确定、可预期」。
- **判据**：符号规范在会话开始即生效（推荐白名单 + 使用标准），且不误伤代码段与引用示例；会话标题随工作进展保持贴切。
- **依据**：`symbol-normalizer/README.md`（规则表）、`session-title-cutoff/README.md`。

## 3. 当前非目标

跨机传输、复用系统 Redis、离线消息队列、常驻守护进程、云端同步。

## 4. 与 BACKLOG 的分工

- 本文：方向、完成判据、依据文档（不写编号状态）。
- `docs/BACKLOG.md`：条目、优先级、依赖、里程碑与进度（§3）；方向落地时在这里拆条目。
