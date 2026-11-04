# 宿主升级复核: 0.2.1-rc.5 相对 rc.3 的接口变化（接取条目: docs/BACKLOG.md「宿主升级复核: `dsh` 0.2.1-rc.5 相对 rc.3 的接口变化」）

状态: 关闭　　开启: 2026-11-04　　关闭: 2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改。

## 目标

对比官方 clone `~/GithubRepos/deepseek-harness` 的 `dsh-v0.2.1-rc.3..dsh-v0.2.1-rc.5`, 给出接口面增量与本仓影响判定: 模型侧工具面 / 会话与工具事件 / 进程内服务面 / `bundle/base` patch / 包目录计数 / `session-paths` 编码四函数是否漂移; 顺带核对 `0.2.2-alpha` 线是否已有需提前适配的破坏性变更。

## 调研

### 版本与提交

- 对比源: `git diff dsh-v0.2.1-rc.3..dsh-v0.2.1-rc.5`, **13 个提交**, 388 文件, +776 / −431。
- 同区间提交分两组:
  - rc.3 → rc.4 (`504a01a957` 发布, 2026-10-26): ACP stdout 回归修复 (`41736cdec5` 账号目录诊断改 stderr、`cc4446eecc` MCP 资源列举诊断改 stderr)、web 会话视图 tab 的 tooltip 收敛 (`72624bae95` / `c38265a00e` / `199ffe37ba`)、`940aafcadb` 补 ACP stdout 期望用例。
  - rc.4 → rc.5 (`31cfe2aafe` 发布, 2026-10-29): `534dac8c81` web 思考块渲染定制 (新增升级指南 `v0.2.1-rc.4/reasoning-body-props`)。
- 版本号: 全仓包 `0.2.1-rc.3` → `0.2.1-rc.5`; `package.json` 全量差异**只有版本号字段**(过滤 `"version"` 与 `dsh-*` 依赖版本后为空集, 实测)。
- 包目录数 (深度 3 的 `packages/<a>/<b>/package.json`): rc.3 = **343**, rc.5 = **343** (无增删)。
- 本机安装树: `dsh --version` = `0.2.1-rc.3`; 未升级 (本次只做复核)。

### 接口面四类

| 面 | 变更 | 影响本仓 |
| --- | --- | --- |
| 模型侧工具面 | 无 (无 `tool-*` / `tools` 注册源文件变更) | 无 |
| 会话 / 工具事件 | 无 (`packages/core` / `session` / `host` / `boot` / `interaction` / `compaction` 非 manifest 变更 0 个) | 无 |
| 进程内服务面 | 无 (无 `ctx.provide` 新增 / 收窄) | 无 |
| `bundle/base` patch | 无 (仅版本号) | 无 |

### 有行为含义的两处变更（均不触本仓）

1. **ACP stdout 纪律**: `packages/llm/llm-deepseek-account/src/index.ts` 的 listing `info` 由 `console.info` 改 `console.error`; `packages/mcp/mcp-client/src/connection.ts` 的 `resources/list` 与 `resources/templates/list` 改为**先读服务器能力**: 未声明 `resources` 时直接回空页 `{ resources: [] }` / `{ resourceTemplates: [] }`, 不再让 SDK 写 `console.debug` 到 stdout。前者只换日志流向; 后者对「未声明 resources 的 MCP 服务器」由「SDK 空页 + stdout 噪声」变成「宿主直出空页」, 结果面等价。本仓不挂 `acp` 栈、不挂 `mcp-client`, 无影响。
2. **web 思考块渲染契约**: `packages/client/ui-chat/src/client/contract/slots.ts` 的 `conversation.chat.reasoning.body` 槽 owner props 拆成 `rawText` (原始模型输出) + `text` (显示就绪文本), 新增 `reasoningText()` 剥 `<signature>` 段; `conversation.chat.reasoning.content` Factory 入参收窄为 `text` / `running` / `labels`。官方随发行文升级指南 `docs/upgrade-guide/v0.2.1-rc.4/reasoning-body-props/guide.md`。这是**客户端槽契约**, 只影响 web 扩展与翻译插件 (`packages/experimental/client-ui-cot-translation`); 本仓 TUI 走自有渲染层, 不消费该槽。

### 编码漂移复核

`packages/session/session-persistence-jsonl/src/format.ts` 在 rc.3..rc.5 区间**无 diff** (不在变更文件列表内), `encodeSegment` / `projectKey` / `projectDir` / `sessionDir` 四函数无漂移。

### 0.2.2-alpha 线（顺带核对）

- HEAD `8bd073392e`(2026-11-03) 位于 `dsh-v0.2.2-alpha.3` 之后 **555 个提交**; 包目录 343 → **370** (+27)。
- 该线已有大量升级指南: `v0.2.2-alpha.2` 20 条 (含 `projection-event-frames` / `projection-snapshot-scope` / `projection-released-checkpoint` / `fs-observation-policy-default-off` / `llm-request-purpose-declarations` / `schedule-agent-tools` / `subagent-explicit-reasoning` 等), 另有 `v0.2.1-rc.1` / `v0.2.1-rc.3` 的 16 条 (rc.5 之后才补写进 master, 属文档回填)。
- 判定: 事件 / 投影面已有明确的破坏性改动, 属**独立复核任务**, 不在本条范围内, 已登记新条目。

## 决策

1. 复核深度: a 只看接口面四类 + 编码漂移 → b 逐文件通读 39 个非 manifest 变更 → c 连 alpha 线一起复核。**选定 b**: 非 manifest 变更仅 39 个文件, 通读成本低且能避免漏判; c 超出本条目范围 (alpha 线另立条目)。
2. 口径同步范围: a 只写新对照文档 → b 同时刷 `HOST-PACKAGES.md` 与 `DSH-CTX-API.md` 的版本注记 → c 连 `install.sh` 默认版本与 smoke 门槛一起抬到 rc.5。**选定 b**: 安装树仍是 rc.3, 抬门槛会让脚本与本机状态不一致 (a 会留下过期口径)。
3. 本机是否升级到 rc.5: a 本次一并升级重装 → b 不升级, 另立条目。**选定 b**: 升级安装树属用户择时的破坏性步骤, 与本条目的「复核」性质不同。
4. `STATUS.md` 是否改: a 改基线行 → b 不改。**选定 b**: `WORKFLOW-STANDARD.md` §4.6 规定 `STATUS.md` 由用户择时更新, 流程不自动改。

## 规划

任务拆分:

1. 追踪文档与条目状态（本文件 + `docs/BACKLOG.md`）。
2. 新对照文档 `docs/host/HOST-UPGRADE-0.2.1-rc.5.md`。
3. 口径注记: `docs/host/HOST-PACKAGES.md` 头部、`docs/host/DSH-CTX-API.md` 复核注记。
4. 途中新发现登记两条 BACKLOG 条目 (alpha 线复核、本机升级到 rc.5)。
5. 验证: `pnpm run check:docs`, 人工确认。

计划改动文件清单:

- `docs/BACKLOG.md` — 条目规范化并标〔进行中〕; 追加两条新条目。
- `docs/implementation/2026-11-04-host-upgrade-0.2.1-rc.5.md` — 本追踪文档。
- `docs/host/HOST-UPGRADE-0.2.1-rc.5.md` — 新增对照记录。
- `docs/host/HOST-PACKAGES.md` — 头部版本注记 (计数不重生成)。
- `docs/host/DSH-CTX-API.md` — rc.5 复核注记 (正文研读基线不变)。

明确不做:

- 不改 `scripts/install.sh` / `scripts/test-install.sh` / 各包 smoke 的 `REQUIRED_VERSION` (决策 2c 与 3b)。
- 不改 `docs/STATUS.md` (决策 4b)。
- 不重生成 `HOST-PACKAGES.md` 的包计数与挂载清单 (需 rc.5 安装树, 属升级任务)。
- 不改 `0.2.2-alpha` 线相关内容 (另立条目)。

## 实现记录

- 2026-11-04 15:50: 建本追踪文档, 写「目标 / 调研 / 决策 / 规划」。
- 2026-11-04 16:00: `docs/BACKLOG.md` 的登记条目按 `WORKFLOW-STANDARD.md` §3 规范成列表形 (去掉「改动位置 / 验收」, 补〔进行中: 2026-11-04〕), 同时追加两条途中发现的新条目 (alpha 线复核、本机升级到 rc.5)。
- 2026-11-04 16:05: 新增 `docs/host/HOST-UPGRADE-0.2.1-rc.5.md` (8 节: 版本与来源 / 提交分组 / 增量总览 / ACP stdout / web 思考块契约 / 编码漂移与包计数 / 口径对齐 / 待办 / 依据)。
- 2026-11-04 16:10: `docs/host/HOST-PACKAGES.md` 头部补 rc.5 注记; `docs/host/DSH-CTX-API.md` 补 rc.5 复核注记。

## 偏差

- 提交询问点的执行顺序: 决策与实现连做, 未在「决策完成后」单点阻塞询问, 与 `WORKFLOW-STANDARD.md` §5 点 1 的字面顺序不一致; 原因是同回合内的纯文档改动, 默认建议本就是「合并为关闭后一次提交」。在关闭点一次询问 (用户答「关闭并提交」), 本次为单笔收尾提交。
- 新条目「本机宿主升级到 `0.2.1-rc.5`」正文写的「rc.2 实测 306 / 295」取自 `HOST-PACKAGES.md` 的既有实测行, 本次未在安装树上复算 (安装树仍 rc.3), 数字按文档照录。

## 测试与证据

- `pnpm run check:docs` 输出: `✓ check:docs 通过: 111 篇现行 Markdown / 901 个 .ts, 规则 0 项, 错误 0 / 警告 0` (收尾前); 归档与本文件移动后复跑一次, 结论同。
- `format` 已对全部改动 / 新增文件执行 (`docs/BACKLOG.md`、本追踪文档、`docs/host/HOST-UPGRADE-0.2.1-rc.5.md`、`docs/host/HOST-PACKAGES.md`、`docs/host/DSH-CTX-API.md`、`README.md`、`README.zh.md`)。
- 上游事实核对命令与输出摘录见本文件「调研」节与 `docs/host/HOST-UPGRADE-0.2.1-rc.5.md` §8。
- 未做: 本仓代码改动 (本条无需)、`pnpm run check` / `test` (纯文档, 无代码面)、真机验证 (无运行时行为变化)。
- 人工确认: 用户在关闭点确认关闭并提交。

## 收尾

- 回写文档: 新增 `docs/host/HOST-UPGRADE-0.2.1-rc.5.md`; `docs/host/HOST-PACKAGES.md` 补 rc.5 注记; `docs/host/DSH-CTX-API.md` 补 rc.5 复核注记; `README.md` / `README.zh.md` 的「当前升级对照」指针与 §顶部复核说明改指 rc.5 (双语同构)。`docs/STATUS.md` 按 `WORKFLOW-STANDARD.md` §4.6 由用户择时更新, 本次未改; `docs/ROADMAP.md` 无需回写 (只按 `HOST-UPGRADE-*.md` 通配引用)。
- BACKLOG: 所接取条目已标完成并从 §2 移出 (关闭注记留在 §2 开头); 途中发现的两条按当前顺序重编为 `#1`(0.2.2-alpha 线复核) / `#2`(本机升级到 rc.5)。
- 归档: 本文件已移入 `docs/archived/2026-11-04-host-upgrade-0.2.1-rc.5.md`。
- 遗留: 两条新条目未接取; 本机安装树仍为 `0.2.1-rc.3`。
- 提交: 本次变更一笔收尾提交 (`docs(host)`), 之后不再有相关提交。
