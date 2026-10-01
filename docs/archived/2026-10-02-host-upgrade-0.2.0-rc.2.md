# 官方 0.2.0-rc.2 对照汇总（接取条目：`docs/BACKLOG.md`「官方 0.2.0-rc.2 对照汇总（接口 / 工具变更）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

对本机基线 `dsh 0.1.7-rc.2`，产出相对新版 `0.2.0-rc.2` 的变更汇总（接口面 / 工具面 / 破坏性变更与我们的落点），落 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`；同时刷新 `docs/host/HOST-PACKAGES.md` 的官方包清单与挂载标记。

口径：官方源码只读（`~/GithubRepos/deepseek-harness`，本地 checkout = `dsh-v0.2.0-rc.2`）；两侧都取 **tag**，不用工作区（避免 master 漂移）：

- OLD = tag `dsh-v0.1.7-rc.2`（commit `477b4f4205`，2026-09-24）
- NEW = tag `dsh-v0.2.0-rc.2`（commit `639ed01539`，2026-09-29）

## 调研（2026-10-02 采集，全部只读）

### 区间规模

| 指标 | 值 |
|---|---|
| commits | 448（其中触碰 `packages/` 的 286，非 merge 提交 307） |
| 文件 / 行 | 1638 文件、`+52,060 / -82,531` |
| 源码包 | 321 → 325（public 312 → 316，private 9 → 9） |
| 新增包 | 4（`otel`、`client-product-analytics`、`client-ui-settings-session-log`、`experimental-schedule-bundle`） |
| 删除 / 改名 / 移目录 | 0 / 0 / 0 |

### 官方自带目录（本次对照的主证据源）

官方仓库新增/维护了四份生成式目录，直接给出「工具面 / 服务面 / 事件面 / 持久化面」的权威清单，比上一版逐包 grep 更可靠：

- `docs/tool-catalog.md`（模型可见工具 → 包 → 服务 → 事件）
- `docs/capability-seams.md`（服务 seam / core / bundle 表 + 依赖图）
- `docs/event-producer-consumer.md`（事件生产 / 消费矩阵）
- `docs/persistence-catalog.md`（持久化类型与 shape hash）
- `docs/upgrade-guide/v0.1.7-rc.2/*`（本次唯一的官方迁移指南目录，两份）

### 关键采集结果

- **工具面**：模型可见工具 65 → 65，**零增删**；只有 4 条描述变更（`ask_user_question`、`bash` / `pwsh` 的删除/移动路径安全文案、`cordis_inspect_query` 客户端超时语义）。**审阅后修正**：`mode: timed` 不是模型可见参数，而是官方 `tool-ask-user` 行的 Cordis config（缺省 `legacy`）；切 timed 才多出 `timeout` 参数并换 schema——默认组合下该工具 schema 两侧零 diff。
- **服务面**：`super(<ctx>, '<name>')` 口径 130 → 132，新增 `otel`、`productAnalytics`，**无删除、无改名**。
- **事件面**：声明事件 89 → 89，零增删；变化只在消费者集合（`user-questions` 新消费 `agent/inbox/claimed|discarded` 与 `session/event`；`product-analytics` 消费 `session/event`）。
- **我方消费的服务**：`tools` / `agents` / `sessions` / `jobs` / `subagents` / `commands` / `userQuestions` / `goals` / `sessionTitle` / `sessionProjections` / `sessionQuery` / `skills` / `settings` / `permissionPresets` / `approval` / `workflowEngine` / `ptcRuntime` / `web` / `agentPresets` / `lsp` / `agentDefaultModel` / `profileContext`——逐个包的 `src`（或 provider 文件）/ 在区间内**只有 `package.json` 版本号 1 行 diff**（即实现零变化），例外四个：`core/session`（`repair.ts` 重做）、`interaction/user-questions`（timed 模式 + 投影）、`core/agent-loop`（失败步补写合成 `tool/result`，**活路径**，落在我方 5 处 `tool/result` 消费上）、`settings`（仅新增测试）。
- **装配契约**：`util/package-manifest` 仅版本号 → `dsh.bundle` 契约未变；`vendor/include` **零 diff** → `cordis.patch.yml` 方言未变；`boot/app-boot/src/profile.ts` 仅 `OPTIONAL_BUNDLES` 增 `@deepseek-ai/dsh-experimental-schedule-bundle`；启动必需条目表（`index.ts`）未动。
- **组合面**：`bundle/base` 新增一行 `- id: otel`（→ 我们升级后自动多挂 `dsh-otel` 一个包）并把 `session-telemetry-otel` 的 exporter URL 换为 `dsh-otel-collector.deepseeksvc.com`、加 `maxRequestBytes: 4000000`；`bundle/web-app` 移除 schedule 三行（仅 Web 面，我们不用）。
- **持久化**：`SESSION_FORMAT_VERSION` 两版都是 **4**（无格式升级）；`persistence-catalog` 变更集中在 `MessageSource` 联合新增 `user-question-reply` 及随之变化的 `Message[]` / `user/message` / `developer/message` / `agent/inbox/spliced` / `session/title-llm-request` 类型哈希。
- **CLI / 运维面**：`apps/cli` 改动集中在 Desktop 保留 profile（`desktop`）与 plugin-manager 抽取，`--profile` / `plugin` 语义对我们无变化；`plugin-manager` / `hmr` 的 `src` 净零 diff（只动 tests / README / `package.json`）且我们本就未挂载。

### 途中发现（不在本条目范围，记此并交条目 #2）

- **`schedule` 面不在我们的组合里**：官方 4 个 `schedule_*` 工具（`schedule_create` / `_delete` / `_list` / `_update`）两版都在 catalog 内，但既不在 `dsh-base`（两版都没有 schedule 行）也不在 fff profile 的 bundles / patch 里；`metric-loop` 的 `scheduleHint()`（`src/engine.ts:227`）却让模型「用宿主 `schedule_create` 排下次唤醒」——该工具在当前 TUI 组合下不存在。0.1.7 → 0.2.0 只把 schedule 从 Web 组合搬进 optional bundle，**不改变本仓现状**（既有问题，非本次升级引入）。
- **`ask_user_question` timed 模式**（官方 `tool-ask-user` 行的 config，缺省 `legacy`；开启后该工具才多出 `timeout` 参数并换 schema）：默认仍是阻塞语义，我们不需要改代码；但 timed 模式引入的 `ctx.sessionProjections` 新单元 `userQuestions` 与会话日志新消息来源 `user-question-reply` 是「会话日志新增一类消息」，将来若采用 timed 模式需处理迟到回复。

## 决策

- **D1（对照口径）**：两侧都锁定 tag（`dsh-v0.1.7-rc.2` / `dsh-v0.2.0-rc.2`），并以官方生成式目录（tool-catalog / capability-seams / event-producer-consumer / persistence-catalog）为主证据、`git diff --shortstat` 逐包为辅证；每条结论给出可复现命令（新文档 §6）。
- **D2（工具面结论）**：工具集零增删 → 不新增「工具面回归清单」；只把 4 条描述变更记入文档（其中 `ask_user_question` 的默认 schema 两侧零 diff（timed 是官方行的 config，不是模型参数））。
- **D3（我方落点结论）**：本仓 17 包**无需改代码**（消费的服务面实现零 diff）；升级待做的只有部署面（宿主安装、`scripts/install.sh` 默认版本、profile 依赖）与文档面。
- **D4（宿主升级本身不并入本条目）**：安装 `0.2.0-rc.2` 与真机验证是独立动作（涉及仓库外操作、重启、回滚预案），本条目只产出对照文档；据此**新增 BACKLOG 条目**「宿主升级到 0.2.0-rc.2 的执行与验证」，并把它排在条目 #2（挂载面扩张）之前。
- **D5（`HOST-PACKAGES.md` 刷新范围）**：只改「有变化的部分」——标题版本、口径行、采集时间、与上位版本差异行、§2 新增 4 包所在分组与小计、§1 已挂载说明中 base 新增 `otel` 行的提示；**不重排全表**（283 行逐行重写无增量信息，且挂载集合的完整实测归条目 #2 步骤①）。
- **D6（排除项）**：`docs/host/DSH-CTX-API.md`、`AGENT-COMPOSITION.md` 本次不改（前者是跨插件接口笔记、区间内我方消费面无变化；后者的 preset 结论在 0.2.0 未被推翻——`agent-preset` 家族仍未进 base）。

## 计划改动文件清单

- `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`（新，主产出）
- `docs/host/HOST-PACKAGES.md`（定点刷新，见 D5）
- `docs/BACKLOG.md`（本条目开工标「进行中」→ 关闭时清理；新增「宿主升级执行」条目，见 D4）
- 本追踪文档（唯一过程记录）

## 审阅（子代理，2026-10-02，用户流程要求：决策后先审阅再继续）

**结论：有条件通过 → 复核通过。** 审阅者只读复现了 10 项检查（工具 / 事件 / 服务面集合、17 包消费面逐包 diff、组合面、装配契约、会话格式、包清单、`schedule` 发现、区间漏项扫描），核心结论全部成立；提出的问题与漏项已全部修入产出文档：

| 类型 | 内容 | 处理 |
|---|---|---|
| 事实修正 | `mode: timed` 是官方 `tool-ask-user` 行的 config（缺省 `legacy`），不是模型可见参数；切 timed 才多出 `timeout` 并换 schema | 已改（主文档 §0 / §3.4、`HOST-PACKAGES.md` §4/§5、本文件） |
| 事实修正 | `plugin-manager` / `hmr` 的 `src` 零 diff（区间内特性被 revert），原文「有实现改动」不成立 | 已改（§3.5 两行、§4 第 7 行） |
| 事实修正 | 证据路径 `packages/vendor/include` 不存在（空验证）→ 应为仓根 `vendor/include` | 已改（§3.5） |
| 事实修正 | `sessionProjections` 消费方只有 `context-report`（`rule-engine` 只 inject `agents` / `sessions`） | 已改（§3.2） |
| 事实修正 | `sandbox-windows-acl` 是既有包（非本次新增），新增的是它作为 `ctx.skills` provider 的角色 | 已改（§3.1） |
| 漏项补充 | `core/agent-loop` 失败步补写合成 `tool/result`（**活路径**，8 文件 +333/-16），落在我方 5 处 `tool/result` 消费上 | 已补（§0 第 3 条、§3.2 新增行、§3.7 新条、§4 第 6 行、§5 真机复现项） |
| 漏项补充 | 消费服务清单缺 `agentDefaultModel` / `profileContext`；§3.3 缺 `loader/volatile-update` 消费者；§3.6 缺 `- id: ui-settings-session-log`；§5 缺 fff 硬钉版本 `session-title-all-prompts-llm: 0.1.7-rc.2` | 已补 |
| 格式 | §3.4 / §3.5 表格内竖线未转义（会破表） | 已转义为 `\|`，审阅者复扫三份文档确认仅此两处 |

复核结果：10 条逐项「已修好」，新增内容抽验准确（含 5 处 `tool/result` 消费行号逐个命中），**无新引入问题**；另有 5 条低优先残留（note 引用、括注精确度、追踪文档同步等）也已一并修完。

## 实现记录

1. 采集：以两侧 tag 为基准，用官方生成式目录（tool-catalog / capability-seams / event-producer-consumer / persistence-catalog）做集合 diff，用 `git diff --shortstat` 逐包确认我方消费面实现变化（结论：只有版本号）。
1. 产出 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`（体例对齐 0.1.7 版）：摘要 3 项验证 + 服务 / 事件 / 工具 / 装配 / 配置 / 持久化逐面判定 + 官方重大更新 + 影响清单 + 复现命令 + 未确认项。
1. 刷新 `docs/host/HOST-PACKAGES.md`：标题与口径行升到 `0.2.0-rc.2`、采集时间、与 0.1.7 的差异行、§2 新增 4 包（客户端 UI 2 + 基础设施 2：`otel`、`experimental-schedule-bundle`）、服务索引 +2（84 → 86）、§4/§5 结论同步；**未重排全表**（全量挂载实测归条目 #2 步骤①）。
1. 子代理审阅 → 修正 → 复核通过（见上节）。
1. 登记新条目「宿主升级到 0.2.0-rc.2 的执行与验证」（D4），并写入 §1 已完成索引。

## 证据

- 产出：`docs/host/HOST-UPGRADE-0.2.0-rc.2.md`、`docs/host/HOST-PACKAGES.md`（刷新 26 处）。
- 复现命令：新文档 §6（工具 / 事件 / 服务集合 diff、逐包 diffstat、组合面 diff、升级指南清单）——其中工具名 `comm -3` 实测为空、两侧各 65 项；`packages/core/tools` 等消费面 diff 实测为「1 文件 1 行 = 版本号」。
- 审阅：子代理两轮（首轮 5 问题 + 5 漏项；复核 10 项全通过、无新问题）。

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理（同批登记新条目，编号沿用：新条目为 #1，其余 2-11 不变）。
- 本追踪文档移入 `docs/archived/`。
- 未确认项（npm dist-tags 采集、`schedule_*` 真机可用性、timed 模式客户端行为、`repair.ts` 行为差异、事件载荷字段级差异、Web/Desktop 面、性能基线）记于新文档 §7，随升级执行条目复核。
