# 33 个插件端到端用例

> 接取条目: `docs/BACKLOG.md` §2 #3「33 个插件端到端用例」（2026-11-03 开工, 2026-11-03 关闭）
> 层级: 项目级

## 计划改动文件清单

| 文件 | 作用 |
| --- | --- |
| `e2e/harness.ts` | 真宿主装配夹具: 临时 `DSH_HOME` + 独立 profile、`runProfile()`、工具调用、agent 创建、事件驱动、注入捕获、清理 |
| `e2e/<包>.test.ts` × 33 | 每个插件一条用例 |
| `e2e/README.md` | 运行方式、前置外部命令、夹具能力 |
| `package.json` | 根 `devDependencies` 钉 `@deepseek-ai/dsh@0.2.1-rc.3`; `test:e2e` 改为跑插件套件; 原 TUI 端到端更名 `test:e2e:tui`; `pnpm.verifyDepsBeforeRun: false` |
| `pnpm-lock.yaml` | 根依赖变更 |
| `docs/BACKLOG.md` | 条目开工标进行中、关闭移除; 追加途中发现的缺陷条目 |

不用改 33 个包的源码与包内用例: 条目验收要求「不改变 `pnpm run test` 的包内用例面」。

## 调研

- `@deepseek-ai/dsh/profile-boot` 的 `runProfile({ environment, profile, patchFiles, args })` 返回 `{ ctx, shutdown }`; 装配单位是 `$DSH_HOME/profiles/<name>` 的 profile 目录 (`package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml`), bundle 先按 dsh 安装锚点解析、再按 profile 目录解析。
- `dsh-base` 是一整个 `- insert:` 层 (529 行), 无法按行取子集; 但用户层可用 `- id:` 关行/改 `config`、`- insert:` 加行。夹具因此挂 `dsh-base` + 被测包 + 服务依赖, 用 profile 用户层做针对性配置, 不用全量 34 包。
- `ctx.tools.execute({ callId, name, arguments, agent?, signal })` 走完整工具管线 (pre-execute 守卫、post-execute 消费者); 需要会话归属的工具必须传真实 `Agent`——`ctx.agents.create()` 可在无模型调用下建真实会话。
- rule-engine 消费者只在真实会话事件上唤醒: 用 `session.append("assistant/message", …)` + `session.append("turn/end", …)` 复现回合, `step/end` 复现步边界; 投递终点用 `agent.followup` / `steer` / `inject`, 夹具拦截这三条路径读注入正文。
- 外部依赖: `ast-grep` (ast-tools)、`python` (script-interpreter)、`redis-server`/`redis-cli` (session-channel、agent-group)、`herdr` (herdr-use 只读列举)、unix socket 自建 (herdr-integration、session-title-cutoff 的 helper 链接)。
- 宿主默认写入落在 `~/.dsh`; 夹具把 `DSH_HOME` 指到 `tmp/e2e/<随机>/`, 并把 `sessionDir` / `stateDir` / `dshHome` / `ledgerPath` 等配置逐一指向临时目录, 避免污染真实家目录。

## 决策

1. **一文件一宿主**: `node --test` 每文件独立进程, 一次 `runProfile` 装配一个被测包; 用 `--test-force-exit` 收尾 (个别插件的心跳 / 重试定时器不随 dispose 立刻停, 但用例断言已完成)。
2. **服务依赖按需追加**: `extraPackages` 明确列出被测包需要的仓内服务 (rule-engine、session-paths、memory-base、herdr-use、session-channel、fs-digest)。
3. **断言真实边界**:
   - 工具类: 经 `ctx.tools.execute()` 执行, 断言返回值 + 落盘文件 (hash-edit、md-logic、ast-tools、script-interpreter、memory-base、metric-loop、daemon、preference、output-compress);
   - 消费者类: 驱动真实会话事件, 拦截 rule-engine 的三条投递路径 (md-table-check、ponytail、symbol-normalizer);
   - 守卫类: 用真实 `bash` 工具触发拦截并读 `guard.recent()` (security-guard、behavior-correction);
   - 插桩类: 服务面 (clock、session-paths、command-template、auto-approve、coagent、herdr-use、context-report、session-title-cutoff)、事件面 (herdr-integration 的 unix socket 协议、escalation-hint 的 `tools/post-execute` 瀑布)。
4. **不碰用户真实环境**: herdr-use 只 `herdr_list`、coagent 只 `list`、session-channel / agent-group 自起临时 Redis, 不创建终端、不写系统 Redis、不启动子会话。
5. **根脚本并存**: `test:e2e` 归插件套件, TUI 原端到端迁到 `test:e2e:tui`, 两条都留在根 `package.json`。

## 实现记录

- `e2e/harness.ts`: `bootPackage(dir, { extraPackages, patch, env, prepare, toolTimeoutMs })`; profile 清单由仓库包 `package.json` 的 `name` 生成, 包目录符号链接进 profile `node_modules`; `patch` 支持函数形态 (先拿临时 home 再拼配置); `prepare` 用于起 Redis / socket / helper 链接; `callTool` 支持 `agent`; `createAgent` 用真实 `agents.create`; `captureInjections` / `appendTurn` / `appendStepEnd` / `injectionText` / `waitFor` / `tempPath`。
- 33 条用例与断言:

| 包 | 用例断言 |
| --- | --- |
| clock-base | `clock` 服务 `scope().schedule` 真实触发 |
| herdr-integration | 自建 unix socket 收到 `pane.report_agent_session` |
| herdr-use | 10 个终端工具注册; `herdr_list` 返回空清单 |
| task-engine | 真实 agent 会话里 `task_decompose("root")` → `task_status` 含子任务 |
| memory-base | `registerKind().put` 后 `memory_query` 命中, 磁盘出现 `.db` |
| goal-contract | `goal_contract_draft` 落 goal 并回读契约 (readback.match) |
| metric-loop | `start` 跑一轮 `echo 7`, 状态文件 `history` 长度 1 |
| output-compress | 大 `tool/result` 事件后会话目录出现 `digest.db` |
| fs-digest | Markdown `outline` 含标题与行号 |
| hash-edit | `hash_read` 锚点 → `hash_edit` 改行, 文件内容变化 |
| ast-tools | `ast_query` 命中 `console.log`, `ast_replace` 写回源码 |
| md-logic | `structure` 取节范围 → `replace` 整节改写落盘 |
| md-map | `index` 后 `callers(b.md)` 列出 `a.md` |
| security-guard | `bash sudo id` 被拒, `guard.recent()` 有 `bash` 记录 |
| code-map | `index` 后 `callers(greet)` 列出 `main.ts` |
| context-report | 真实会话 `state` / `list` 均可用 |
| rule-engine | `rule_add` → `rule_list` 出现 → `rule_test` 命中 |
| behavior-correction | `bash cat` 被拒并指路专用工具 |
| symbol-normalizer | `normalize("✔ ❌")` → `"✓ ✗"`; 回合审查经投递路径提醒 |
| session-channel | 临时 Redis: 别名写入并可被 `redis-cli` 读到 |
| session-title-cutoff | 官方 helper 链接后 `registration.provider.id = session-title-cutoff`, `automatic = all-prompts` |
| command-template | 随包模板清单非空; agent 命令面含 `playbook` |
| ponytail | `step/end` 触发决策阶梯注入 |
| md-table-check | 表头 2 列 / 数据 3 列的真实回合收到修正提示 |
| auto-approve | `autoApprove.status()` 可用; `/autoapprove status` 命令输出 |
| background-daemon | `daemon_task create` 后 `tasks.json` 落盘并可 `show` |
| preference-analysis | `preference_add` → `preference_list` 可见; `ledger.json` 落盘 |
| session-paths | `root()` / `projectKey()` / `ensureSessionDir()` 建目录 |
| script-interpreter | `script_run` 执行 Python 输出 |
| agent-group | 临时 Redis 上 `create_group` / `status` 成功 |
| coagent | `list` (probe none) 空记录 |
| tool-consult | 咨询前 `fs_digest` 不可见, 咨询后揭示可见 |
| escalation-hint | 沙箱拒绝结果经 `tools/post-execute` 瀑布补 `sandbox_permissions` 指引 |

## 偏差

1. **根 `test:e2e` 语义变更**: 原脚本跑 TUI `demo:build -- --smoke` + `smoke:pty`; 条目要求插件套件占用 `test:e2e`。处理: 插件套件用 `test:e2e`, TUI 迁到 `test:e2e:tui`, 原命令仍可显式执行。
2. **`pnpm.verifyDepsBeforeRun: false`**: 根新增 `devDependencies` 后, `pnpm run` 会先做依赖状态检查并隐式 `pnpm install`; 该检查在受限环境下访问全局 store 失败。关闭隐式安装, 依赖由显式 `pnpm install` 管理。此设置只影响根项目运行脚本。
3. **`herdr-use` / `coagent` 只读**: 真正 `herdr_create` / `coagent spawn` 会拉起用户 herdr 会话里的终端与子 dsh 进程, 不适合自动化套件; 用例只断言工具面与只读动作, 创建类动作仍留人工验收 (真机记录见 `docs/archived/2026-10-23-real-machine-verification.md`)。
4. **`escalation-hint` 直接驱动瀑布**: 测试环境没有真实沙箱拒绝, 用例直接调 `ctx.waterfall("tools/post-execute", exec, result, next)` 并给宿主判据形态的失败结果; 走的是插件真实监听器与真实 `additionalContexts` 出口, 只是上游拒绝由夹具构造。
5. **`session-title-cutoff` 断言注册面**: 标题生成需真实 LLM 路由, 自动化套件不调用模型; 用例链接宿主同版 `dsh-session-title-llm`、禁用官方 `session-title-llm` 行, 断言 `ctx.sessionTitle.registration.provider` 被本包接管 (`id` / `automatic`)。读取该只读字段是观察点, 不改被测代码。
6. **`auto-approve` 断言范围**: 真实 `approval/request` 的灰区裁定与学习层需交互面板 / LLM; 用例断言服务面与 `/autoapprove status` 命令链路, 裁定矩阵仍由包内用例覆盖。
7. **依赖发现**: `auto-approve` 的 `readService` 在可选服务缺席时会回落到直接属性读取, 而 cordis 对未注入属性取值抛错 → 插件整体未激活。故 e2e profile 必须显式挂 `session-paths` 与 `memory-base`; 该降级缺陷已记入 BACKLOG 新条目。`agent-group` 同缺 `session-paths` 时工具返回结构化降级错误 (行为符合预期), 但 `apply` 阶段不报错, 不另立条目。

## 测试与证据

- `pnpm run test:e2e`: 33/33 通过, 退出 0 (3 次全跑: 5829 ms / 5666 ms / 5622 ms, 均 `pass 33 fail 0`)。
- 单跑抽查: 每个文件均单独运行过并修到通过 (含格式化后复跑)。
- 全仓门禁: `pnpm run check`、`pnpm run test` (见收尾记录)。
- 反例: 初版 `output-compress` 事件缺 `message.id` / `toolCallId`, 宿主格式校验直接抛错; 初版 `md-table-check` 未在 profile 层开 `enabled` (包缺省关闭), 消费者不触发——两处都按真实宿主约束修正, 非夹具放宽。

## 收尾

- 条目从 `docs/BACKLOG.md` §2 移除, 关闭注记写在该节。
- 本文件移入 `docs/archived/`。
- 回写 `docs/BACKLOG.md` 新缺陷条目; 不涉及 DESIGN / README (插件契约未变)。
