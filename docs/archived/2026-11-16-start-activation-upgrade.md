# 子代理委派改走 `startActivation()` + 升级 `0.2.2-rc.3`（接取条目：`docs/BACKLOG.md` §2 合并条目）

- 登记：2026-11-16
- 状态：进行中
- 合并说明：2026-11-16 用户裁定把 BACKLOG §2 既有条目「子代理委派改走 `startActivation()`」扩为「代码修复 A + 安装脚本升级 B + 升级后收尾 C」一次取出完成；宿主安装（工区外全局装 + profile 重装）由用户修改完成后**手动执行 `scripts/install.sh`** 完成，本任务不改工区外内容。

## 目标

1. 把本仓三处仍按宿主旧 `ctx.subagents.start(name, request)` 调用的代码迁到 `startActivation(spec)`（rc.1 起服务面已无 `start`），保留超时 / 取消 / `dispose` 结算口径与子代理用量计量。
2. 把 `scripts/install.sh` 默认宿主版本抬到 `0.2.2-rc.3`（含安装工具测试一致性），真机安装由用户执行。
3. 升级后收尾中不依赖宿主的过时口径更正（D9 的 `engines.node`、profile 账号包名注释）；依赖宿主的数字口径（对照文档 §12、HOST-PACKAGES 重生成、security-guard 工具面清单）留到用户执行安装后。

## 计划改动文件清单

- `task-engine/src/host.ts`（`SubagentsLike` 改 `startActivation` + 新增 `AgentsLike`）
- `task-engine/src/subagent.ts`（`runChildOnce` 改 `startActivation`、经 `agents.get(childId)` 取子会话计量）
- `task-engine/src/executor.ts`（注释同步）
- `task-engine/tests/assemble.ts` / `index.test.ts` / `semantic.test.ts` / `clock.test.ts`（假 subagents 改 `startActivation` + 假 `agents` 面）
- `task-engine/scripts/executor-smoke.mjs`（假 subagents 改 `startActivation` + 假 `agents` 面）
- `command-template/src/subagent.ts`（`startActivation`、去 `settleRun`、`pickProvider` 去 `list`、`buildOneShotSpec`、`textOfOutcome`）
- `command-template/tests/subagent.test.ts` / `assemble.ts` / `clock.test.ts` / `integration/plugin.test.ts`
- `TUI/src/app/adapter/dsh-panels.ts`（`/council`）、`TUI/src/app/adapter/types/agent.ts`（`SubagentsLike`）、`TUI/src/app/adapter/types/adapter-contract.ts`、`TUI/src/app/runtime/commands-host.ts`
- `TUI/tests/adapter.dsh.test.ts`（council 三个用例）
- `scripts/install.sh`（默认版本 → rc.3）
- `package.json`（D9 `engines.node` → `>=24.9.0`）
- `profiles/example/cordis.patch.yml`（D9 账号包名注释）
- 文档同步：`command-template/README.md` / `docs/DESIGN.md`、`task-engine/docs/DESIGN.md`
- 追踪文档 `docs/archived/2026-11-16-start-activation-upgrade.md`（本文）、`docs/BACKLOG.md`

## 调研结论（宿主 `/startActivation` 面）

- rc.3 服务面 `SubagentRuntime`：**无 `start(name, request)`、无 `list()`**；一次性运行走 `startActivation(spec)`（选项平铺：`provider / label / prompt / parent / signal / delivery / outputSchema? / agentOptions? / name? / childId?`，`parent` 为**必填**精确存活 Agent），返回 `SubagentActivation`（`childId` + `result: Promise<SubagentResult>` + `dispose()`，**不再带 `localAgent.session`**）。
- `SubagentResult.stopReason` 为 `completed / aborted / error / max-tokens / refusal`；`output` / `structured?` / `diagnostic?` 字段与旧面一致 → 终态判定与文本提取逻辑基本不变。
- **`settleRun` 已从 `@deepseek-ai/dsh-subagent` 移除**（command-template 原依赖它收尾）；改直接 `await run.result`（与 task-engine 同法）。
- **`toolFilter` 能力位在 rc.3 移除**（官方 tool-subagent 改为 `agentPreset` 选人设/工具面）；spawn 能力位为 `agentOptions / agentPreset / outputSchema / depthLimit` 全 true。本仓裁决 run 的工具面收窄因此恒走「能力缺失 → 降级 + 告警」，与旧宿主无此能力位时一致，不构成新退化。
- 计量子会话：`sessionProjections.snapshot/stateOf` 只接受 **Session 对象**；`startActivation` 只回 `childId`，故经 `ctx.agents.get(childId).session` 解析（**须在 `dispose()` 前取**，dispose 注销子 Agent）。
- TUI 本机 base 只挂 provider `spawn`（默认名），`/council` 原用 provider `"one-shot"`（rc.1 起即不存在）→ 一并改为 `"spawn"`。
- 宿主账号平台包 rc.3 改名：`@deepseek-ai/dsh-deepseek-account-platform` → `@deepseek-ai/dsh-deepseek-account`（`packages/credentials/deepseek-account`，去 `-platform` 后缀）。

## 实现记录

- 2026-11-16（A 代码修复）：task-engine `host.ts` / `subagent.ts` / `executor.ts` 迁 `startActivation` + `agents` 取会话；command-template `subagent.ts` 迁 `startActivation` + 去 `settleRun` + `pickProvider` 去 `list` + `buildOneShotSpec` + `textOfOutcome` 适配 `SubagentResult`；TUI `/council` 迁 `startActivation(provider=spawn)`。同步更新四包测试假面与 executor-smoke、三份文档注释。
- 2026-11-16（B 安装脚本）：`scripts/install.sh` 默认版本 `0.2.2-rc.1` → `0.2.2-rc.3`（3 处）；`scripts/test-install.sh` 124 项通过。
- 2026-11-16（C 不依赖宿主的过时口径）：根 `package.json` `engines.node` → `>=24.9.0`（宿主要求 Node ≥24.9）；`profiles/example/cordis.patch.yml` 账号平台包名注释去 `-platform` 后缀。
- 2026-11-16（版本串/文档抬版，用户裁定「更新文档与版本串，宿主导部分仍待装」）：根 `package.json` devDep `@deepseek-ai/dsh` → `0.2.2-rc.3`；`tool-surface/package.json` 依赖 `@deepseek-ai/dsh-tools` → `0.2.2-rc.3`（+ README）：四个 smoke 的 `REQUIRED_VERSION` 与头部注释 → `0.2.2-rc.3`（security-guard / metric-loop / output-compress / goal-contract）；`README.md` / `README.zh.md` 的「当前升级对照」指针与文档索引 → `0.2.2-rc.3`；`e2e/README.md`、`goal-contract/README.md`、`metric-loop/README.md` 的 smoke 宿主要求 → `0.2.2-rc.3`；`docs/BACKLOG.md` 头部基线声明 → `0.2.2-rc.3`（升级中注记）。**pnpm-lock.yaml（根 / tool-surface）未同步抬版**——随实际 rc.3 安装一并重生成（宿主导）。

## 验证

- `pnpm run check`：全仓 41 包类型检查全绿。
- `pnpm run test`：`task-engine` 203 例、`command-template` 48 例全绿；`command-template/tests/integration` 12 例全绿（手动跑）。
- `pnpm -w run test:tui`：TUI 1892 例全绿。
- `scripts/test-install.sh`：124 项通过。
- `pnpm run check:docs`：待跑（格式化后）。
- 真机验收：**未做**——须在用户安装 `0.2.2-rc.3` 后，一次性覆盖子代理执行 / 模板步骤 / `/council` 与版本切换（升级前置，决策项 7 = b）。

## 未尽事项（依赖宿主安装，用户执行后补）

- **真机验收**：用户安装 `0.2.2-rc.3` 后，一次性覆盖子代理执行 / 模板步骤 / `/council` 与版本切换（升级前置，决策项 7 = b）。
- `docs/host/HOST-UPGRADE-0.2.2-rc.3.md` §12 安装树实测数字补写。
- `docs/host/HOST-PACKAGES.md` §1/§2 行清单与计数按 rc.3 安装树重生成。
- `security-guard/README.md` 工具面清单重生成（重跑 `tool-surface-check` 枚举 rc.3 宿主活跃工具），并登记 `wait_agent` / `office_*` / `user_terminal_*` 与 `interrupt_agent` 出厂关闭口径（对照文档 §10 #2/#3）。
- **pnpm-lock.yaml（根 / tool-surface）重生成到 rc.3**（随安装一并做；当前清单已抬版、锁文件仍 rc.1）。

## 2026-11-16 二轮（宿主已装 rc.3 后的收尾）

- 用户已执行安装：全局宿主 `0.2.2-rc.3`（安装树 `@deepseek-ai` 337 / `dsh-*` 326，`dsh-base` 0.2.2-rc.3）；fff profile `pnpm install` 确认 up-to-date；`--dump-config` 曾因**本会话沙箱**（workspace-write 拦 `~/.dsh` 写）报 EROFS，danger-full-access 下实测得 883 行 / 152 个 `- id:`（官方 110 / 本仓 42；无条件 `disabled: true` 8、条件 8 → 官方活跃 **102**）；profile bundles 42；dump 首行 `patch: entry "ponytail" not found`（fff patch 残留 ponytail 条目，install.sh 保留既有 patch 所致，不致命）。
- `HOST-UPGRADE-0.2.2-rc.3.md` §12 已补写安装树数字；`pnpm run check` 在 rc.3 类型上 41 包全绿（tool-surface 对 `dsh-tools@0.2.2-rc.3` 类型核验通过）；`tool-surface` 测试 14/14。
- 锁文件：根 `pnpm-lock.yaml` 与 `tool-surface/pnpm-lock.yaml` 已重生成到 rc.3（permissions 下 `pnpm install --lockfile-only` / `CI=true pnpm install` 物化）。
- `HOST-PACKAGES.md`：头部 / 版本口径 / rc.3 增量注记 / 新增「rc.3 挂载复测」行 / 文末采集注记已按 337/326 与 dump 更新（官方活跃 102）。
- `security-guard/README.md`：`interrupt_agent` 行改到 `dsh-tool-subagent-control` 并注明出厂关闭；新增 rc.3 复核注记（`tool-surface-check` 实测 36 包 / 60 工具、无新增写面缺口）。
- 版本串/抬版（二轮）：根 devDep、tool-surface dep、4 个 smoke、README 指针、BACKLOG 基线、e2e/README、goal-contract/README、metric-loop/README 已抬到 rc.3。
- 真机验收（`/council`、task-engine 子代理、`/agents` 按名寻址）：**留用户真机确认**（§12 第 3 项），本会话未跑 TUI 实机会话。
- fff patch 的 `ponytail` 残留条目：建议后续 `--force` 重装或手动删该 patch 段（记录，不属本任务改动面）。
