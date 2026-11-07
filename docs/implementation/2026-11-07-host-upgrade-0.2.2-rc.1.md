# 更新参考宿主版本到 0.2.2-rc.1 并升级本机安装树（接取条目: docs/BACKLOG.md「更新参考宿主版本到 `0.2.2-rc.1` 并升级本机安装树」）

状态: 规划　　开启: 2026-11-07　　关闭:
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改。
本文件同时承接上一任务（`docs/archived/2026-11-07-host-rc-interface-review.md`）遗留的 5 项跟进条目, 见「承接条目」。

## 目标

1. 仓库内所有现行 `0.2.1-rc.5` 版本引用抬到 `0.2.2-rc.1`（脚本 / smoke 门槛 / 根 devDep 与锁 / 文档基线）。
2. 本机全局 `dsh` 升级到 `0.2.2-rc.1`, 并 `scripts/install.sh --profile fff --sync` 重装主 profile（含伴随 `fff-test`）。
3. 按新安装树复测并重生成 `docs/host/HOST-PACKAGES.md` 的版本口径、包计数与挂载数字。
4. 承接上一任务的 5 项跟进: 本条完成 #3（子代理路由实测）与 #6（fs 口径同步）; #2 / #4 / #5 记为后续（本任务不改插件源码逻辑）。

## 承接条目（原 BACKLOG #2 至 #6, 2026-11-07 汇总进本文件）

> 汇总依据: 用户 2026-11-07 要求「将之前额外添加的条目统一汇总到版本更新任务的追踪文档中」。这五项均由宿主 `0.2.2-rc.1` 复核产出, 原为项目级 BACKLOG 独立条目, 现从 BACKLOG 移除, 只在本文件跟踪。

| 原条目 | 内容 | 本条处理 |
| --- | --- | --- |
| #2 | `agent/request` 弃用迁移（TUI 会话模型切换改走 `agent.model.select()`） | 后续（代码迁移, 不在本条范围） |
| #3 | 核实子代理显式路由在 rc.1 的授权行为 | 本条做（升级后实测） |
| #4 | `apply_patch` 写面覆盖（security-guard 与 escalation-hint） | 后续（代码改动, 本条不启用该工具） |
| #5 | `sessionProjections.stateOf(session, key)` 弃用迁移 | 后续（代码迁移, 不阻塞升级） |
| #6 | `fs-observation-policy` 缺省关闭的文档口径同步 | 本条做（随文档基线更新） |

逐条详情:

- **#2 `agent/request` 弃用迁移**: rc.1 把该事件标弃用（原文「保留给既有监听器, 不要新增监听」）; TUI 在 `TUI/src/app/adapter/dsh.ts:234` 注册监听, 把会话内模型 / 推理档切换应用到请求, `TUI/src/app/adapter/dsh-session.ts:184` 与 `:308` 依赖同一路径; rc.1 上仍可用。期望改走 `agent.model.select({ provider, model, reasoningEffort? })`, 输出上限走 `AgentOptions.maxTokens`, 保留「会话内切换立即生效」与「恢复会话后选择仍生效」, 补用例。优先级 P1。
- **#3 核实子代理显式路由**: rc.1 新增 `/model-selection-settings` 路由授权, 无记录时只允许父路由; 本仓 `command-template/src/subagent.ts:75` 与 `task-engine/src/subagent.ts:221` 通过 `ctx.subagents.start` 传 `{ provider, model }`, 编程式 start 是否同受约束未验证。备注: 若被拒, 二选一 —— profile 记录 `allowedModels`, 或把模板级 / 叶子模型收回到父路由并在两侧 README 写明边界。优先级 P1。
- **#4 `apply_patch` 写面覆盖**: rc.1 的 `tool-fs` 新增 `apply_patch`（参数只有 `input` 补丁文本, 路径写在文本里）; `security-guard/src/tool-registry.ts:12-22` 的 `FILE_TOOLS` / `WRITE_FILE_TOOLS` 未登记, `escalation-hint/src/index.ts:31-32` 未含; rc.1 出厂组合均为 `applyPatch: false`。补齐方式: security-guard 解析补丁文本取路径（或整工具按写类拒绝）, escalation-hint 加提示, 同步 README 覆盖边界。优先级 P2。
- **#5 `sessionProjections.stateOf` 弃用迁移**: rc.1 弃用该读法并打运行时警告; 本仓 `task-engine`（`tokenUsage`）、`context-report`（`sessionStats` / `sessionContext`）、`rule-engine` 用它读宿主投影单元。期望改读领域服务（如 `tokenMeter`）或公开 handle, 迁移后无弃用警告。优先级 P2。
- **#6 `fs-observation-policy` 文档口径同步**: rc.1 的 `dsh-base` 把该行改 `disabled: true`（官方 `write` / `edit` 不再有读后改前与版本守卫）; `hash-edit` / `ast-tools` / `md-logic` 的 README 与 `docs/ARCHITECTURE-REUSE.md` 仍按「base 缺省挂载守卫」表述。本条按实际挂载改口径, 并写明可用 profile patch 恢复。优先级 P2。

后续项（#2 / #4 / #5）在本条关闭时若仍未处理, 按用户指示决定是重新登记到 BACKLOG 还是继续留在归档文档。

## 调研

### 版本引用盘点（2026-11-07, `grep -c '0.2.1-rc.5'`）

| 文件 | 处数 | 性质 |
| --- | --- | --- |
| `scripts/install.sh` | 3 | 头注释、`dsh_version_default`、`--help` |
| `scripts/test-install.sh` | 7 | 假 `dsh` 版本串与版本一致性断言 |
| `package.json` | 1 | 根 `devDependencies` 的 `@deepseek-ai/dsh` |
| `goal-contract/smoke/smoke.mjs` / `security-guard/smoke/smoke.mjs` | 3 / 4 | `REQUIRED_VERSION` 与说明 |
| `metric-loop/smoke/smoke.mjs` / `output-compress/smoke/smoke.mjs` | 3 / 2 | `REQUIRED_VERSION` 与说明 |
| `goal-contract/README.md` / `metric-loop/README.md` / `security-guard/README.md` | 1 / 3 / 1 | smoke 前置说明与工具面口径 |
| `README.md` / `README.zh.md` | 2 / 2 | 宿主基线口径 |
| `docs/ARCHITECTURE-REUSE.md` | 3 | 复用审计基线 |
| `docs/STATUS.md` | 1 | 宿主基线行 |
| `docs/host/HOST-PACKAGES.md` | 3 | 标题与版本口径 |
| `e2e/README.md` / `TUI/docs/COMMANDS.md` | 1 / 1 | 根 devDep 钉版与命令口径 |

历史文档（`docs/host/HOST-UPGRADE-*.md`、`docs/archived/**`、`docs/implementation/2026-11-05-request-tuning.md`）中的 `0.2.1-rc.5` 属历史记录, 不改。

### 升级流程（沿用 rc.5 先例）

- 依据: `docs/archived/2026-11-04-host-upgrade-0.2.1-rc.5-install.md`（rc.3 → rc.5 的完整步骤与偏差）。
- 步骤: 全量替换版本串 → `pnpm install`（devDep 抬版, 锁文件重写; pnpm 配置在 `pnpm-workspace.yaml`）→ `pnpm run check` → `npm i -g @deepseek-ai/dsh@0.2.2-rc.1` → `scripts/install.sh --profile fff --sync` → `--dump-config` 复测 → 重算并回写 `HOST-PACKAGES.md` 与 `STATUS.md`。
- 沙箱: 全局安装、`pnpm install`、`install.sh --sync` 都要写工作区外路径, 逐条走 `sandbox_permissions: danger-full-access` 一次性执行并说明理由。

### 升级风险（来自 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md`）

- `dsh-base` 新增 `tool-executor-native` / `tool-executor-ptc` 两行 → profile dump 的 `- id:` 行数会变; 新行必须存在, 否则 `dsh-tools` 无执行器。
- `tools` 行删除 `mode` / `maxParallelSubCalls`: 本仓 profile patch 未配这两字段, 无加载失败风险。
- `fs-observation-policy` 缺省关闭 → 官方写面守卫消失, 属行为变化; 本条不改插件, 仅在文档写明并给恢复方式。
- TUI `agent/request` 与三处投影 `stateOf` 读法在 rc.1 仍可用（弃用 + 警告）, 不阻塞升级。
- 子代理路由授权可能影响模板级 / 叶子模型, 升级后按 #3 实测。
- 树外插件 `session-title-all-prompts-llm` 只依赖 `ctx.sessionTitle` provider 契约, 该契约未变。

## 决策

1. 范围（用户 2026-11-07 裁定）: **仓库引用 + 本机安装树**, 含 `HOST-PACKAGES.md` 重生成; 不改插件源码逻辑。
2. 旧任务处置（用户 2026-11-07 裁定）: 复核任务条目已关闭并提交 `3e4d92a2`。
3. 跟进条目（用户 2026-11-07 裁定）: 原 BACKLOG #2 至 #6 从 BACKLOG 移除, 统一汇总到本文件; 本条做 #3 / #6, #2 / #4 / #5 记为后续。
4. `STATUS.md`: 用户要求「更新参考宿主版本」视为对宿主基线行的更新授权（沿用 rc.5 先例）, 只改该行。
5. 升级前不预先恢复 `fs-observation-policy` 行: 先按 rc.1 出厂形态升级, 行为取舍写入文档交用户后续裁定。

## 规划

1. 仓库内 `0.2.1-rc.5` → `0.2.2-rc.1` 全量替换（17 个现行文件）, 逐文件 diff 复核。
2. `pnpm install` 重写锁文件 → `pnpm run check`。
3. 全局安装 `dsh@0.2.2-rc.1` → `scripts/install.sh --profile fff --sync` → `--dump-config` 自检。
4. 按新树复测包计数与挂载数字, 回写 `HOST-PACKAGES.md` / `STATUS.md`。
5. 承接项: #3 子代理显式路由实测; #6 fs 口径同步（`hash-edit` / `ast-tools` / `md-logic` README 与 `docs/ARCHITECTURE-REUSE.md`）。
6. 验证: `pnpm run check`、`pnpm test`（按需）、`pnpm run test:e2e`（按需）、`sh scripts/test-install.sh`、`pnpm run check:docs`。

计划改动文件清单:

- `docs/BACKLOG.md` — 新条目标〔进行中〕; 原 #2 至 #6 移除（汇总进本文件）; 收尾时移除本条。
- `docs/implementation/2026-11-07-host-upgrade-0.2.2-rc.1.md` — 本追踪文档。
- `scripts/install.sh`、`scripts/test-install.sh` — 默认版本与假版本串。
- `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（按需）— 根 devDep 与锁文件。
- `goal-contract/smoke/smoke.mjs`、`metric-loop/smoke/smoke.mjs`、`output-compress/smoke/smoke.mjs`、`security-guard/smoke/smoke.mjs` — `REQUIRED_VERSION`。
- `goal-contract/README.md`、`metric-loop/README.md`、`security-guard/README.md` — smoke 前置说明。
- `README.md`、`README.zh.md`、`e2e/README.md`、`TUI/docs/COMMANDS.md`、`docs/ARCHITECTURE-REUSE.md`、`docs/STATUS.md` — 版本与基线口径。
- `docs/host/HOST-PACKAGES.md`、`docs/host/DSH-CTX-API.md` — rc.1 口径与计数。
- `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` — 追加「安装树已升级」与实测数字。
- `hash-edit/README.md`、`ast-tools/README.md`、`md-logic/README.md` — #6 口径同步。

明确不做:

- 不改任何插件源码逻辑（`TUI` 的 `agent/request` 迁移、`security-guard` 的 `apply_patch` 登记、投影读法迁移均留后续）。
- 不复核 `0.2.2-alpha` 线; 不改历史对照文档与归档文档里的旧版本字样。
- 不启用 `apply_patch`（保持 rc.1 出厂 `applyPatch: false`）。

## 实现记录

（待写）

## 偏差

（待写）

## 测试与证据

（待写）

## 收尾

（待写）
