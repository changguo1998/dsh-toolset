# HOST-UPGRADE: 0.2.1-rc.3 → 0.2.1-rc.5 对照记录

> 职责: 记录 `dsh-v0.2.1-rc.3 → dsh-v0.2.1-rc.5` 的接口面增量与本仓影响判定
> 不负责: 包清单 (见 `HOST-PACKAGES.md`)、ctx 接口逐条研读 (见 `DSH-CTX-API.md`)
> 过期条件: 出现下一版宿主 (0.2.2 线) 时由新对照文档接替

## 0. 版本与来源

- 对比源: 官方 clone `~/GithubRepos/deepseek-harness`, tag `dsh-v0.2.1-rc.3..dsh-v0.2.1-rc.5` (13 个提交, 388 文件, +776 / −431; 头提交 `b830ec950f`「Merge PR #7572 release-dsh-0.2.1-rc.5」, 2026-10-29)。
- 中间还有一次发布 `504a01a957`(rc.4, 2026-10-26); 两组提交见 §1。
- 版本号: 全仓包 `0.2.1-rc.3` → `0.2.1-rc.5`。`package.json` 全量差异**只有版本号字段** (过滤 `"version"` 与 `dsh-*` 依赖版本后为空集)。
- 本机状态: `dsh --version` = `0.2.1-rc.3`; 本次只做复核与口径注记, **未升级安装树、未重装 profile**。

## 1. 提交分组

| 组 | 提交 | 内容 |
| --- | --- | --- |
| rc.3 → rc.4 | `41736cdec5` / `940aafcadb` | ACP stdout 回归修复: 账号模型目录的诊断改走 stderr, 补 stdout 期望用例 |
| rc.3 → rc.4 | `cc4446eecc` / `cb7f0878e4` | MCP 资源列举诊断离开 ACP stdout |
| rc.3 → rc.4 | `72624bae95` / `c38265a00e` / `199ffe37ba` | web 会话视图 tab: tooltip 只在标签超宽时出现 |
| rc.4 发布 | `504a01a957` / `083bdcf625` | 版本号与发布合并 |
| rc.4 → rc.5 | `534dac8c81` | web 思考块渲染定制, 新增升级指南 `v0.2.1-rc.4/reasoning-body-props` |
| rc.5 发布 | `31cfe2aafe` / `b830ec950f` | 版本号与发布合并 |

## 2. 增量总览 (按面)

| 面 | 变更 | 影响本仓 |
| --- | --- | --- |
| 模型侧工具面 | 无 (无 `tool-*` 包或 `tools` 注册源文件变更) | 无 |
| 会话 / 工具事件 | 无 (`packages/core` / `host` / `session` / `boot` / `interaction` / `compaction` 的非 manifest 变更 0 个) | 无 |
| 进程内服务面 | 无 (无 `ctx.provide` 新增或收窄) | 无 |
| `bundle/base`(dsh-base) patch | 无 (仅版本号) | 无 |
| 官方插件配置 schema (我们挂载的行) | 无 | 无 |
| LLM / MCP | 日志流向与资源列举前置判定 (见 §3) | 无 (本仓不挂 acp / mcp-client) |
| web 客户端 | 思考块槽契约拆分 + 视图 tab tooltip (见 §4) | 无 (TUI 走自有渲染层) |
| 工程配置 / 测试 | `apps/cli` 的 ACP stdout 期望用例、`apps/web` 端到端断言 | 无 |

包目录数 (深度 3 的 `packages/<a>/<b>/package.json`): **343 → 343**, 无增删。

## 3. ACP stdout 纪律 (唯二有行为含义的变更之一)

- `packages/llm/llm-deepseek-account/src/index.ts`: listing 的 `info` 由 `console.info` 改 `console.error` (注释写明「ACP reserves stdout for protocol messages, including during successful catalog loads」)。只换日志流向, 模型目录结果不变。
- `packages/mcp/mcp-client/src/connection.ts`: `resources/list` 与 `resources/templates/list` 先读 `getServerCapabilities()?.resources`, 未声明时直接回空页 (`{ resources: [] }` / `{ resourceTemplates: [] }`), 不再让 SDK 往 stdout 写 `console.debug`。对「未声明 resources 的服务器」结果面等价 (原路径 SDK 也回空页)。
- 本仓 34 包不挂 `acp` / `acp-app` / `mcp-client`, 无需适配。

## 4. web 思考块渲染契约 (唯二有行为含义的变更之二)

- `packages/client/ui-chat/src/client/contract/slots.ts`: `conversation.chat.reasoning.body` 槽的 owner props 拆为 `rawText` (原始模型输出) 与 `text` (显示就绪文本), `running` 不变; `conversation.chat.reasoning.content` Factory 入参由「owner props + labels」收窄为 `text` / `running` / 可选 `labels`。
- 新增 `packages/client/ui-chat/src/client/reasoning-text.ts` 的 `reasoningText()`: 剥掉 `<signature>` 段与尾部空行, 供显示层使用。
- 官方随发行文升级指南: `docs/upgrade-guide/v0.2.1-rc.4/reasoning-body-props/guide.md`(含 `guide.zh.md` / `guide.i18n.yaml`); 迁移要求是「普通渲染继续读 `text`, 需要完整输出的扩展改读 `rawText`, 传给 Content Factory 时不要重复做显示处理」。
- 影响面: 只涉及 web 客户端槽的贡献者 (本仓无) 与 `packages/experimental/client-ui-cot-translation` 的翻译包装 (官方已自行改掉)。TUI 不消费该槽。

## 5. 编码漂移与包计数

- `packages/session/session-persistence-jsonl/src/format.ts` 在该区间**无 diff**, `session-paths` 复刻的 `encodeSegment` / `projectKey` / `projectDir` / `sessionDir` 四函数无漂移; 若将来升级安装树, 仍需按 `src/encode.ts` 注释的出处行号复核安装树 `lib/index.js`。
- 包目录数不变 (343), 因此 `HOST-PACKAGES.md` 的分类与行清单无需改动; 其**计数**仍来自 rc.2 安装树实测, 需升级后重生成 (已登记条目)。

## 6. 本仓已做的口径对齐 (2026-11-04)

- 新增本文件。
- `docs/host/HOST-PACKAGES.md`: 头部版本口径补 rc.5 复核注记 (包计数不重生成, 仍为 rc.2 安装树实测)。
- `docs/host/DSH-CTX-API.md`: 补 rc.5 复核注记 (逐条研读基线不变)。
- **未改**: `scripts/install.sh` / `scripts/test-install.sh` / 各包 smoke 的 `REQUIRED_VERSION` (安装树未升级, 抬门槛会与本机状态不一致)、`docs/STATUS.md`(按 `WORKFLOW-STANDARD.md` §4.6 由用户择时更新)。

## 7. 未做 / 待办

- 本机仍为 rc.3: 升级安装树、重生成 `HOST-PACKAGES.md` 计数、抬版本门槛, 见 `docs/BACKLOG.md` 条目「本机宿主升级到 `0.2.1-rc.5` 并重建安装树口径」。
- `0.2.2-alpha` 线: 主分支已在 `dsh-v0.2.2-alpha.3` 之后 555 个提交, 包目录 343 → 370 (+27), 且有 20 条 `v0.2.2-alpha.2` 升级指南 (事件与投影面含破坏性改动)。属独立复核任务, 见 `docs/BACKLOG.md` 条目「宿主升级复核: `0.2.2-alpha` 线的接口变化与新增包面」。

## 8. 依据

- `git log --oneline dsh-v0.2.1-rc.3..dsh-v0.2.1-rc.5`(13 条) 与 `git diff --stat` / `--name-status`(388 文件)。
- `git diff dsh-v0.2.1-rc.3..dsh-v0.2.1-rc.5 -- '**/package.json'` 过滤后为空集 (确认只有版本号变化)。
- `git diff ... -- packages/mcp/mcp-client/src/connection.ts packages/llm/llm-deepseek-account/src/index.ts`
- `git diff ... -- packages/client/ui-chat/src/client/contract/slots.ts packages/client/ui-chat/src/client/reasoning-text.ts`
- `docs/upgrade-guide/v0.2.1-rc.4/reasoning-body-props/guide.md`(rc.5 树内)
- `git ls-tree -r --name-only <tag> | grep '^packages/[^/]+/[^/]+/package.json$'` 计数 (rc.3 / rc.5 = 343, HEAD = 370)。
- 过程记录: `docs/archived/2026-11-04-host-upgrade-0.2.1-rc.5.md`。
