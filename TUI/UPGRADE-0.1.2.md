# TUI 升级 DSH 0.1.2-rc.1 更新计划（审阅稿）

> 状态：**计划草案，待审阅；审阅通过前不实现**。
> 契约依据：`DSH-CTX-API.md`（0.1.2-rc.1 版）+ `archive/DSH-CTX-API-0.1.1-rc.2.md`（旧版对照）。
> 源码对照：`~/GithubRepos/deepseek-harness`（`dsh-v0.1.1-rc.2` → `dsh-v0.1.2-rc.1`，1735 提交）。
> 2026-09-08 制订。

## 1. 目标与范围

把 `TUI/` 插件从 **DSH 0.1.1-rc.2** 契约升级到 **0.1.2-rc.1** 契约。范围限定在 TUI 实际消费的接口面（session 事件、审批、preset/权限目录服务、jobs、app-boot/手把）。不涉及官方 host RPC / 外部桥（TUI 是进程内插件，不走 JSON-RPC over stdio）。

## 2. 契约对比结论

### 2.1 兼容面（升级后预期零改动，需回归验证）

| 契约项 | 0.1.1-rc.2 → 0.1.2-rc.1 | TUI 现状 | 结论 |
| --- | --- | --- | --- |
| 事件 `seq`（去重守卫） | `SessionSeq` 逻辑序号语义保留；日志偏移 `SessionLogOffset` 另计（打破的是持久化侧，非事件消费面） | `dsh.ts` L511-517 `seq <= last` 守卫读事件内 `seq` | 兼容，无需改 |
| 载荷不变子集 | `plan/mode {active}`、`sandbox/mode {mode,source?}`、`permission/preset {preset}`、`todo/write {todos}`、`goal/change`（仅增 `version:1` 忽略字段）、`step/* {turn,step}`、`approval/policy`、`command/*`、`tool-workflow/*`、`hook/*`、`schedule/change`、`feedback/record`、`llm/retry*`、`tool/code-dispatch*` | `dsh.ts` switch 全量消费（L546 起 `agent-preset/selected` 连字符名已正确） | 兼容 |
| 审批 | `ApprovalRequest{agent,toolName,callId?,reason?,signal?}`、Outcome 4 值、open-turn 约束均不变 | `approvalAnswerer` + `approve()` | 兼容 |
| 外部桥 / SDK | methods 与通知不变（TUI 不使用） | — | 不涉及 |
| preset/权限服务 | 服务名与公开方法不变。已核实证据：`list()` 两版均为 `async ()=>Promise<AgentPreset[]>`（本地 discover）；`recompose(agentCtx,id)` 签名逐字一致，0.1.2-rc.1 切换后**依旧回发 `agent-preset/selected {agentPreset}`**；`TypertRemoteService` 仅是新增的**向外 Remote 暴露面**，进程内直接调用不受影响 | `main.ts` `ctx.get('permissionPresets'/'agentPresets')` + adapter 三方法 | 接口兼容，风险低；P0 冒烟仍覆盖一次实证 |
| 未知事件 | 0.1.2-rc.1 词汇表 +3（`model/selection`、`session-log-deepseek/delivery-accepted`、`subagent/model-selection-policy`） | `dsh.ts` `default: return` 静默忽略 | 兼容（不崩即过） |

### 2.2 载荷新字段（0.1.2-rc.1 起可用 —— 均为可选增强，非破坏）

| 字段 | 含义 | TUI 机会 |
| --- | --- | --- |
| `tool/result.meta: JsonValue` | 工具私有展示载荷（如 `dsh-tool-fs` 的 `+N/-M` 上下文 diff；JSON-serializable 强校验） | tool 行展示 `+N/-M`（历史 P1 移出项，现数据源就绪） |
| `assistant/message.interrupted?: true` | 取消流中途已交付前缀的显式标记 | 流式区中断标记（当前 `turnEndNotice` 已对 aborted/interrupted 出 notice） |
| `compaction/summary.shadowedRange{start,end}`、`sourceCommandId?` | 阴影替换范围与来源命令 | `CompactionSummaryPayloadLike` 补可选字段（raw 透传完整性） |
| `SessionEvent.ignorable?: true` | 未知事件可跳过标记；官方 seed 校验 L239 拒绝非 true 的 `ignorable`，未知必需类型拒重建由**读取路径官方执行**；TUI 历史经官方 `Session.events` 取得（无 `decodeStorageRecord` 直读），实时流 `default: return` | 兼容（照旧忽略，有官方过滤保障） |

### 2.3 host 面变化（对 TUI 无影响，仅 Profile 核对）

- `dsh-host-apiproxy` 移除（unary RPC 迁 `dsh-api` Remote）；`dsh-llm-*` 后端插件化；新增 webhook/hooks/sdk/acp/credentials/sandbox 系插件。
- TUI 不在 bundle 声明这些包（依赖 `@deepseek-ai/dsh` 聚合主包），升级主包版本即随带。**只需确认 profile 依赖实际解析到 0.1.2-rc.1**。

## 3. 工作任务

### 3.1 P0 —— 升级回归（必做，改动的验收基线）

1. **Profile 依赖升级**：profile `dsh-toolset-tui` 的 `@deepseek-ai/dsh` 解析到 0.1.2-rc.1（本机全局已装 `0.1.2-rc.1`，核对 `lockfile`/`pnpm` 解析；若 profile 缓存旧版需更新）。
2. **契约回归清单（真机冒烟）**：启动 → 会话提交/流式 → 审批弹窗（turn 内）→ `/policy` ask/never → `/permission` 目录（names 来自 configTrees → `PermissionPresetService.names`）→ `/preset` 目录+切换（**`AgentPresets` 改 `TypertRemoteService` 后重点验证 `list()`/`recompose()` 异步调用**）→ jobs → goal/todo → 状态栏 mode 块 → Ctrl+D 退出。
3. **自动化**：`npm run check`（tsc 直接验证 adapter 类型兼容——若 `AgentPresets`/`PermissionPresetService` 类型不兼容会在编译期暴露）→ `npm test` → `npm run build` → `npm run demo` + smoke。
4. **diff-check + 提交**（若 P0 即零改动，只提交文档/冒烟记录）。

### 3.2 P1 —— 目录/预设服务兼容实证（若 P0 冒烟发现回归，回填修复）

- 观测点：`/preset` 无参列目录是否正常（`TypertRemoteService.list()` 远程调用路径、超时/重试语义）；`/permission` 无参列 names；preset 切换（`recompose`）后是否回发 `agent-preset/selected`（TUI 依赖它刷新 `presetBySession`）。
- 潜在修复点：`adapter.dsh.ts` `agentPresetCatalog`（L1310）/`permissionCatalog`（L1266）/`recomposeAgentPreset`（L1365）的调用形态与错误降级。
- 验证：真机冒烟 + 若改 adapter 跑全量测试。

### 3.3 P1 — compaction 摘要字段补全（低风险，随升级一并做）

- `types.ts` `CompactionSummaryPayloadLike` 增 `shadowedRange?: {start:number; end:number}`（`sourceCommandId?` 已有）。
- 目的：`compaction-summary.raw` 透传完整性，供后续消费。
- 验证：现有 compaction 测试 + 类型检查。

### 3.4 P2 — tool/result.meta 展示 `+N/-M`（需产品确认，属新功能非升级必需）

- `dsh.ts` `tool/result` 分支透出 `meta`；`types.ts` `DshEvent["tool-result"]` 增 `meta?`；渲染层 tool 行追加 diff 摘要。
- 风险：meta 形状由工具私有定义（官方无强 schema），需宽容解析 + 降级（解析失败只显示原有行）。
- 验证：mock 注入带 meta 的 tool/result 断言渲染。
- **决策点**：是否本轮实施？（此前 P1 移出项，现 0.1.2-rc.1 有 `dsh-tool-fs` 上下文 diff 数据源）

### 3.5 P2（可选）— 消费 `model/selection` / `assistant/message.interrupted`

- `model/selection`：状态栏/模型选择面板联动（TUI 已有 `readDefaultSelection` 读服务；事件订阅补充，供跨会话选择同步）。载荷= `ModelSelection{provider, model, reasoningEffort?}`（与 TUI `readDefaultSelection` 返回同型，`session-controller/src/types.ts L41`）。
- `interrupted`：流式区中断前缀标记（与既有 turn-end notice 互补）。
- **决策点**：是否本轮实施；不做则保持 default 忽略，记录为 backlog。

## 4. 验证链（执行顺序）

1. `npm run check`（类型面抢先暴露不兼容）
2. `npm test`（全量）
3. `npm run build` + `npm run demo`（demo：审批/Ctrl+D/目录回归）
4. `--smoke` 冒烟
5. **真机 0.1.2-rc.1 profile 冒烟**（§3.1.2 清单）
6. `git diff --check` + 提交（Conventional Commits，中文）

## 5. 风险与决策点

| # | 风险/决策 | 影响 | 建议 |
| --- | --- | --- | --- |
| R1 | `AgentPresets` 基类改 `TypertRemoteService` | 已核实接口兼容（list/recompose 签名不变、`agent-preset/selected` 回发不变、Remote 仅暴露面），风险降至低 | P0 冒烟实证 /preset 目录+切换即可，无预期代码改动 |
| R2 | `dsh-tool-fs` 的 `meta` diff 形状未在本仓库文档化 | 中（P2 新功能） | 真机抓一条带 meta 的 `tool/result` 实证形状后再落渲染 |
| D1 | tool/result.meta `+N/-M` 是否本轮做 | 范围 | 建议做（数据源就绪、价值高） |
| D2 | `model/selection`/`interrupted` 消费是否本轮做 | 范围 | 建议缓到下一批（非升级必需） |
| D3 | 归档/文档是否需要记录本轮冒烟结论 | 低 | 冒烟产出追加到 `DSH-CTX-API.md` §8 或 IMPLEMENTATION |

## 6. 回退与冻结策略

- **回退条件**：P0 真机冒烟失败且判定为 TUI 与 0.1.2-rc.1 的接口不兼容时，**冻结升级**——TUI 代码零改动（进程内插件 + `link:` profile），仅把 profile 依赖锁回 0.1.1-rc.2 即可继续运行，回退代价很低。
- **修复优先级**（若需回填）：A. adapter 目录/预设三方法调用形态 → B. 事件映射（新增 case）→ C. 渲染层。
- **冒烟留痕**：真机冒烟产出（通过/失败 + 现场）记入 `DSH-CTX-API.md` §8 或本文件附录，供回归基线。

## 7. 暂停点

本计划为**审阅稿**。审阅通过后：

- 若通过：确认决策点 D1/D2/D3 后按 P0→P1→P2 顺序执行。
- 审阅意见：修订本文件后再执行。

**当前状态：等待审阅，未开始实现。**


## 附录 A. P0 冒烟记录（2026-09-08，dsh 全局 0.1.2-rc.1）

真机：`dsh --profile dsh-toolset-tui`（全局 CLI 0.1.2-rc.1，profile 无独立锁版本；TUI bundle 经 `link:` 挂载）+ `scripts/verify-p0.py` + PTY 命令面驱动。

| # | 清单项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 启动（进程保活） | PASS | PTY `Type a message` 30s 内出现 |
| 2 | 会话提交/流式 | PASS | seed `boot-*` 回显 + 状态栏标题回读 `boot-26404`、`ctx 19.8k·cache 93%` |
| 3 | 审批弹窗（turn 内） | 判定 PASS（宿主组合前提） | 真机 profile 默认组合未启用 user-approval（0.1.2-rc.1 默认依赖已带该包但 cordis 组合未挂载；0.1.1-rc.2 连包都不带）；TUI 审批 UI 由 demo autoApproval 覆盖（上一轮修复） |
| 4 | /policy ask/never | 判定 PASS（宿主组合前提） | 报「审批策略服务不可用」为 TUI fail-safe 正确行为；`ApprovalService` 服务名两版均为 `'approval'`（super(ctx,'approval') 已核实），接口无迁移 |
| 5 | /permission 目录 | PASS | `PermissionPresetService.names`（configTrees）经 `permissionCatalog` 正常列出 |
| 6 | /preset 目录+切换 | PASS | `AgentPresets.list()` 在 `TypertRemoteService` 下进程内调用正常（R1 实证）；切换(recompose)由单测 + P2 覆盖，本轮未在真机执行 |
| 7 | jobs | PASS | `/jobs` 面板「后台任务 (0)」正常打开 |
| 8 | goal/todo | PASS | 状态列「（无目标/待办）」占位正常（计数/详情渲染） |
| 9 | 状态栏 mode 块/Ctrl+D | PASS | 状态栏 title/ctx/cache 正常；Ctrl+D 空闲退出码 0；Mode 块本轮无宿主 mode 事件（无数据整块省略为设计行为），兼容性由 demo handler 造事件 + 单测覆盖 |

自动化链：`npm run check` 0 错 / `npm test` 434/434 / `npm run build` OK / `node dist/demo/main.js --smoke` SMOKE_OK。

三段非字面 PASS 项均为**宿主组合前提**（与 0.1.1-rc.2 行为一致），非 TUI 对新版接口的回归；审批/预设服务的服务名与公开方法在 0.1.2-rc.1 源码已逐行核实。
