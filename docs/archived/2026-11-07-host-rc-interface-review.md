# 宿主仓拉取最新提交并复核最新 rc 的接口更新（接取条目: docs/BACKLOG.md「宿主仓拉取最新提交并复核最新 rc 的接口更新」）

状态: 关闭　　开启: 2026-11-07　　关闭: 2026-11-07
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改。

## 目标

1. 把官方 clone `~/GithubRepos/deepseek-harness` 拉到远端最新 (提交 + tag)。
2. 确认「最新 rc 版本」是哪一版; 若仍是 `dsh-v0.2.1-rc.5`, 记录无 rc 增量并说明 alpha 线前进内容后收尾。
3. 有更新时对比 `dsh-v0.2.1-rc.5..<最新 rc>` 的接口面增量, 给出本仓 37 个插件的影响判定。

## 计划改动文件清单

- `docs/BACKLOG.md` — 本条目标〔进行中〕, 收尾时移除; 途中发现的问题另追加跟进条目。
- `docs/implementation/2026-11-07-host-rc-interface-review.md` — 本追踪文档。
- `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` — 新增对照记录。
- `docs/host/HOST-PACKAGES.md` — 头部版本口径补 rc.1 复核注记 (计数不重生成)。
- `docs/host/DSH-CTX-API.md` — 补 rc.1 复核注记 (逐条研读基线不变)。

明确不做:

- 不改 `docs/STATUS.md` (用户择时更新)。
- 不升级本机 `dsh` 安装树 (属另一件事, 需用户择时)。
- 不复核 `0.2.2-alpha` 线本身 (2026-11-04 用户裁定不立项, 见 `docs/archived/2026-11-04-host-upgrade-0.2.1-rc.5-install.md:39`)。

## 调研

### 最新 rc

- `git fetch --tags origin` 拉回 `8bd073392e..fcc0ad4621` 与**新 tag `dsh-v0.2.2-rc.1`** (`66491b05e3`, 2026-11-04); `master` 已快进到 `fcc0ad4621`。
- 最新 rc = **`dsh-v0.2.2-rc.1`** (0.2.2 线首个 rc); `master` 在其后再走 811 个提交, 但最新 tag 仍为 rc.1。
- 对比区间 `dsh-v0.2.1-rc.5..dsh-v0.2.2-rc.1`: **2623 提交 / 8120 文件 / +392647 −717068** (删除量集中在 `docs/persistence-changes` 的 schema JSON 与 `docs` 重写, 代码面 `packages` +278695/−41179)。
- 包目录 343 → **372** (+30 / −1); `session-persistence-jsonl` 的编码四函数**无漂移**。

### 复核方法

- 指南面: `docs/upgrade-guide` 的 `guide.md` 44 → 98 (+54 目录), 但其中 41 条是 `v0.2.1-*` 的历史回填 (例如 `conditional-tools` 在 rc.5 树内已存在), 版本标签与代码落点**不完全对应**。故以**代码 diff** 为准, 指南只作定位线索。
- 接口面按六类抽样核对: 模型侧工具面 (`tools` / 执行器 / 工具包增删)、会话与工具事件 (全量事件名集合 + 载荷)、进程内服务面 (`super(ctx, '...')` 集合 + 本仓使用面)、`bundle/base` 与覆盖层 patch、包目录计数、`session-paths` 编码四函数。
- 本仓使用面反查: 对 `ctx.tools.register` / `restrict` / `agent/request` / `sessionProjections` / `ctx.fs` / `ctx.subagents` / `ctx.goal` / `ctx.commands` / `ctx.approval` / `ctx.sessionTitle` 逐个核 rc.1 契约。

### 主要结论 (详见 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md`)

1. 工具面重构: `dsh-tools` 拆出 `tool-executor-native` / `tool-executor-ptc`, 删除 `mode` / `maxParallelSubCalls`; `ToolRuntime` 更名 `ToolsService` 但别名保留; `register()` 新增可选 `when`。
2. `agent/request` 在 rc.1 正式标弃用, `Agent.model.select()` 成为模型与推理档的正规入口; `temperature` / `stop` 仍无替代 —— 与暂停条目「回合预算调整」的恢复条件一致。
3. 投影面弃用 `stateOf(session, key)` 与 `cachedSnapshot`, `SessionProjectionStateMap` 撤除; 本仓 3 处读宿主投影的调用会打弃用警告, 功能不变。
4. `fs-observation-policy` 在 base 改 `disabled: true` (官方读后改前守卫默认消失), 新增 `apply_patch` 工具, 但 rc.1 所有出厂组合都保持 `applyPatch: false`。
5. 新增 4 个事件、10 个服务、30 个包; **无事件删除** (rc.5 安装树的 29 个事件名里 28 个仍在, 差的那个 `internal/listener` 是 vendored cordis 的内部派发, 非宿主包事件)。
6. 子代理新增 `/model-selection-settings` 路由授权: 无记录时只允许父路由, 本仓 `ctx.subagents.start` 显式路由是否受限待实机核实。

### 待核实项

- `ctx.subagents.start` 传 `{ provider, model }` 在 rc.1 是否会被 `/model-selection-settings` 拒绝 (影响 `command-template` 模板级模型与 `task-engine` 叶子模型)。指南只写模型侧工具与执行期, 未有 rc.1 安装树可实测。

## 决策

1. 复核深度: a 只读官方指南 → b 指南定位 + 六类接口面代码 diff + 本仓使用面反查 → c 逐文件通读 8120 个文件。**选定 b**: 指南有 41 条回填, 单靠它会误判; 全量通读成本与收益不匹配, 六类面已覆盖本仓全部对外契约。
2. 产出物: a 只写追踪文档 → b 另立 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` 并同步两份 host 注记 → c 连安装树一起升级。**选定 b**: 对照文档是 host 面既有惯例; 升级属破坏性步骤, 用户未授权, 留给独立任务。
3. 途中发现的问题: a 只记本文件 → b 追加 BACKLOG 跟进条目。**选定 b**: 弃用迁移、`apply_patch` 覆盖、文档口径都跨包且超出本条「复核」性质, 按流程交其他 agent。
4. 本机升级时的三个裁定 (是否恢复读后改前守卫、是否启用 `apply_patch`、子代理路由是否记录授权) **本条不裁定**, 写入对照文档 §12 留待升级任务由用户定。

## 规划

已完成:

1. 拉取宿主仓 + 快进 master, 确认最新 rc。
2. 六类接口面 diff + 本仓使用面反查 + 待核实项定位。
3. 写 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md`。
4. `HOST-PACKAGES.md` / `DSH-CTX-API.md` 补 rc.1 复核注记。
5. 追加 BACKLOG 跟进条目 (弃用迁移 / `apply_patch` 覆盖 / 文档口径 / 子代理路由核实)。
6. 验证: `format` 改动文件 + `pnpm run check:docs`。

计划改动文件清单 (终态): `docs/BACKLOG.md`、本追踪文档、`docs/host/HOST-UPGRADE-0.2.2-rc.1.md`、`docs/host/HOST-PACKAGES.md`、`docs/host/DSH-CTX-API.md`。

## 实现记录

- 2026-11-07: 条目标〔进行中〕 + 建本追踪文档 (目标 / 计划改动文件清单)。
- 2026-11-07: `git fetch --tags origin` (沙箱升级权限一次, 写工作区外 `.git`), 拉回 `fcc0ad4621` 与 `dsh-v0.2.2-rc.1`; `git merge --ff-only` 快进 master。
- 2026-11-07: 完成接口面核对, 写对照文档 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` (13 节, 含本仓影响清单与升级前待裁定项)。
- 2026-11-07: `HOST-PACKAGES.md` 头部补 rc.1 注记 (包目录 343 → 372; 安装树未升级, 计数不重生成); `DSH-CTX-API.md` 补 rc.1 复核注记 (基线不变)。

## 偏差

- 上一轮调研记录 (`docs/implementation/2026-11-05-request-tuning.md:25`) 称 `agent/request` 在「0.2.1-rc.5 口径」已标弃用; 本次核安装树 rc.5 的 `dsh-agent/lib/types/runtime-types.d.ts` **无弃用标记**, rc.1 源码才加。已按 rc.1 事实写入对照文档 §4, 不改旧追踪文档。
- 指南版本标签与代码落点不一致 (41 条回填), 已在对照文档 §0 说明口径, 不逐条订正官方文档。
- 指南与代码还有两处事实冲突, 均已按代码写入对照文档: ① `apply_patch` 指南称 headless / sdk / acp / web-standard 已打开, rc.1 代码里全部为 `applyPatch: false`; ② `tool-executor-plugins` 指南标 `v0.2.1-rc.2`, 但执行器包到 `dsh-v0.2.2-alpha.2` 才出现在树内。
- 未做 `0.2.2-alpha` 线复核 (用户 2026-11-04 裁定不立项), 只在「最新 rc」判定里用其 tag 定位。

## 测试与证据

- 拉取: `git fetch --tags origin` 输出 `8bd073392e..fcc0ad4621 master` + 新标签 `dsh-v0.2.2-rc.1`; `git merge --ff-only origin/master` 成功。
- 计数: `git rev-list --count dsh-v0.2.1-rc.5..dsh-v0.2.2-rc.1` = 2623; `git diff --shortstat` = `8120 files changed, 392647 insertions(+), 717068 deletions(-)`。
- 包目录: rc.5 = 343 / rc.1 = 372 (深度 3 的 `packages/<a>/<b>/package.json`); 增删清单见对照文档 §10。
- 事件: 安装树 rc.5 的 29 个事件名逐个 `git grep` 于 rc.1 源码, 仅 `internal/listener` 不在 (属 vendored cordis 的内部派发, 不是宿主包事件); 新增 `fs/delete-intent` / `llm/models-updated` / `schedule/input-invalid` / `schedule/target-archived`。
- 编码: `git diff --stat ... -- packages/session/session-persistence-jsonl/src/format.ts` 为空。
- 文档: `format` 后 `pnpm run check:docs` 通过 (117 篇现行 Markdown / 948 个 `.ts`, 错误 0 / 警告 0)。
- 一致性: 包计数 343 + 30 − 1 = 372 与 rc.1 实测一致; 事件数与「无删除」结论经安装树名单复核。

## 收尾

- 2026-11-07: 用户确认关闭。条目已从 `docs/BACKLOG.md` §2 移除, 本文件移入 `docs/archived/`。
- 途中发现并按流程登记为 `#2` 至 `#6` 的五个跟进条目**暂留在项目级 BACKLOG**; 后续按用户要求汇总到版本更新任务 (`docs/implementation/2026-11-07-host-upgrade-0.2.2-rc.1.md`) 的追踪文档。
- 本次全部改动随关闭提交一次 (docs 面), 之后不再有本任务相关提交。
