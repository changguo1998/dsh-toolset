# herdr-pane 沙箱模式联动（接取条目：`herdr-pane/docs/BACKLOG.md`「沙箱模式联动：会话处于 `read-only` 时拒绝写类动作」）

状态：关闭　　开启：2026-10-19　　关闭：2026-10-19
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

会话处于 `read-only` 沙箱模式时, 本插件的写类动作在**派发前**被拒绝, 回执说明当前模式与切换方式; 其余模式与「无法判定模式」的情形保持放行, 不误拦。判定依据是宿主可查询的沙箱策略, 不自己折叠事件流。

## 调研

### 1. 条目原假设已过时: 宿主的沙箱策略是**可查询服务**

条目登记 (2026-10-16) 时写的开口是「`sandbox/mode` 是会话事件, 不是可查询服务; 会话初始模式在无事件时无从判定」。现在宿主 (0.2.0-rc.2) 的 `dsh-sandbox-policy` 提供唯一策略所有者 `ctx.sandboxPolicy` (`docs/host/HOST-PACKAGES.md:164`):

- `resolve(request = {})` → `{ mode, workspaceRoot, sessionId? }`, 优先级为 `显式 mode ?? overrideOf(session) ?? defaultMode` (`dsh-sandbox-policy/lib/index.js:141-151`);
- `overrideOf(session)` 读 `ctx.sessionProjections.stateOf(session, "sandboxMode")`, 该投影由会话日志里最后一条 `sandbox/mode` 事件回放得到 (`lib/index.js:114-121,154-156`);
- 因此**初始模式、重启后、resume 后都可判**, 不需要订阅事件, 也不需要自己维护折叠状态与补偿路径。

模式词汇封闭为 `read-only` / `workspace-write` / `danger-full-access`。

### 2. `tools/pre-execute` 的真实载荷与返回值

- 载荷即宿主 `ToolExecution`: 字段 `name` / `arguments` / `agent` / `signal` / `callId` / `rootCallId` (`dsh-tools/lib/types/index.d.ts:216-242,282-287`; 构造见 `dsh-tools/lib/index.js:3131-3191`)。
- 返回 `PreToolDecision = {kind:'allow'} | {kind:'deny', reason, info?} | {kind:'cancel'} | {kind:'ask', reason?}` (`dsh-tools/lib/types/index.d.ts:445-460`); `deny` 由宿主渲染成 `Error: <reason>` 的 `isError` 结果, 不再派发 (`dsh-tools/lib/index.js:3241-3257`)。
- 旁证 (同宿主同事件的消费方): `dsh-tool-bash` 用 `exec.agent.session` 解析策略 (`dsh-tool-bash/lib/index.js:346-349`), `dsh-hooks-codex` 用 `exec.name` / `exec.agent` 并返回 `deny` (`dsh-hooks-codex/lib/index.js:232-241`), 本仓 `auto-approve/src/gate.ts:65-69` 用 `exec.name` / `exec.arguments` / `exec.agent`。

### 3. 途中发现的缺陷: 现有审批门在生产路径恒放行

`herdr-pane/src/main.ts:104-108` 把载荷声明成 `{ toolName?, args? }`, `preExecuteVerdict` (`src/main.ts:116-149`) 按 `execution.toolName !== TOOL_NAME` 早退。宿主实际给的是 `name` / `arguments` → `toolName` 恒 `undefined` → 监听器 (`src/main.ts:218-232`) 恒 `next()` 放行, **闸③ (审批) 从未生效**; `tests/main.test.ts:178-278` 的假载荷照抄了错误字段名, 故单测全绿但未暴露。

本条目要求在同一监听器里新增拒绝判定, 取参与返回形态都依赖这组字段, 故字段名修正并入本任务 (同文件、同一处), 不单独立条目。

### 4. 现有闸与动作集合

- 闸①: 动作层归属校验 `checkOwnership` (`src/policy.ts:55-67`); 写类集合 `OWNED_ACTIONS = send_text / send_keys / run / label / close` (`src/policy.ts:25-31`), 读类 `read` / `info` 可读任意 pane。
- 闸②: 派发前 `guard.inspectCommand` 复查 (`src/policy.ts:153` 起, `makeGuardChecker`), 服务缺失或抛错时告警一次后放行。
- 闸③: 审批档 `requireApproval = foreign | always | never` (`src/policy.ts:82`); 缺省 `foreign`。
- `wait` 只有 `stable` 模式算写侧 (`src/main.ts:133-138`, `src/policy.ts:64-65`)。

### 5. 切换入口

宿主命令 `/permission <preset>` 切「沙箱模式 + 审批策略」捆绑 (`dsh-permission-presets/lib/types/index.js:180`); TUI 侧有 `/permission` 转发与状态列展示, 没有独立的 `/sandbox` 命令。

### 6. 基线

`cd herdr-pane && npm test` → 109 例全绿 (2026-10-19)。

## 决策

**决策项 1　模式来源**

- a) 订阅 `session/event` 的 `sandbox/mode` 自己折叠 (条目原方案)
- b) 每次调用问 `ctx.sandboxPolicy.resolve({ session })`

**选定 b**。理由: 服务是策略唯一所有者, 投影来自日志回放, 重启 / resume 后直接正确, 不需要时序假设与补偿路径; a 还要自己处理「事件早于插件挂载」「换会话」「子会话」三种情况。条目验收里「无事件时按不拦处理」随之改为「策略服务缺失 / 解析失败 / 无会话时按不拦处理」。

**决策项 2　闸的位置**

- a) 动作层 `dispatchAction` (覆盖工具面与库面)
- b) `tools/pre-execute` 门 (只覆盖工具面)

**选定 b**。理由: 工具 `execute(args)` 只拿到参数 (`src/tools.ts:348`), 动作层没有会话可用; 而 pre-execute 是宿主既有门, 能在派发前返回 `deny`, 且与现有审批门同一处。库面 `dispatchAction` 直调不经此门, 属已知边界, 写进 README。

**决策项 3　拦截集合**

- a) 只拦 `send_text` / `send_keys` / `run` / `close` (条目正文列举)
- b) 拦全部写类 (`OWNED_ACTIONS` 再加 `label`) 与 `wait` 的 stable 模式
- c) a + `wait` 的 stable 模式

**选定 c**。理由: `label` 只改归属标记、不向 pane 输入, `create` 只切 pane、不提交命令, 两者在只读会话里不产生文件写入; `wait` 的 stable 模式会走 socket 串行化并按写侧校验归属, 与写类同档。`read` / `list` / `info` 一律放行 (只读、无副作用)。

**决策项 4　模式不可判定时的行为**

- a) 不拦, 首次告警一行 (fail-open)
- b) 拦 (fail-closed), 与宿主 bash 工具「围栏但缺策略服务就抛错」同口径

**选定 a**。理由: pane 里的命令本来就跑在 dsh 沙箱之外, 策略只是额外闸门; 服务缺失 (极简 profile) 时把工具整体变成不可用, 代价大于收益, 也与本包 guard 复查的 fail-open 口径一致。告警只发一次, 避免每次调用刷屏。

**决策项 5　拒绝文案**

带三样: 当前模式、被拒动作与目标 pane、切换方式 (指向 `/permission`)。不写「沙箱会兜住」之类误导语 (pane 在沙箱外执行)。文案由纯函数产出, 单测锁定关键片段。

**决策项 6　字段名缺陷的处理**

并入本任务 (见调研 3): 载荷改为读 `name` / `arguments` / `agent`, 测试里的假载荷同步改成宿主真实形状, 并为审批门补「字段名错就转红」的回归断言。不新开 BACKLOG 条目。

**决策项 7　判定顺序**

沙箱拒绝先于审批: 只读会话里对非自有 pane 的写操作直接拒绝, 不弹审批 (弹了也只能拒绝)。

**决策项 8　配置面**

不新增开关: 模式属宿主会话状态, 插件只读它; 需要更宽或更严的部署改会话模式或权限预设。

## 规划

### 任务拆分

1. 类型与纯函数: `SandboxMode` / 策略服务结构面 / 写类判定 / 拒绝文案。
2. 入口接线: 读载荷字段, 解析模式, 先 deny 后 ask, 一次告警, deps 注入。
3. 测试: policy 纯函数用例 + main 门用例 (含真实载荷形状回归)。
4. 文档: 包 README 的闸门与边界、BACKLOG 状态、本追踪文档。

### 计划改动文件清单

- `herdr-pane/src/types.ts` (新增 `SandboxMode` 与策略服务的结构替身)
- `herdr-pane/src/policy.ts` (写类集合、模式读取、拒绝文案三个纯函数)
- `herdr-pane/src/main.ts` (载荷字段修正 + 沙箱门 + 注入面)
- `herdr-pane/tests/policy.test.ts` (纯函数用例)
- `herdr-pane/tests/main.test.ts` (载荷形状与门的用例)
- `herdr-pane/README.md` (闸门数量与顺序、沙箱联动、库面边界、测试数)
- `herdr-pane/docs/BACKLOG.md` (条目标〔进行中〕, 关闭时移除)
- `herdr-pane/docs/implementation/2026-10-19-herdr-pane-sandbox-mode.md` (本文件)

### 明确不做

- 不拦 `label` / `create` / `read` / `list` / `info`; 不拦 herdr CLI 的其他面。
- 不给库面 `dispatchAction` 直调加拦截 (决策项 2), 只写边界。
- 不新增配置项 (决策项 8)。
- 不改 TUI; 不补 `docs/ARCHITECTURE-REUSE.md` 的 `herdr-pane` 审计行 (另有未立项条目)。
- 不真机验证 herdr 内的审批弹窗 (需要 herdr 会话; 以代码级证据替代, 见「测试与证据」)。

### 验收对照 (条目原文 → 本任务落点)

| 条目原文 | 本任务落点 |
| --- | --- |
| `read-only` 下写类动作被拒且回执点明原因 | pre-execute 返回 `deny`, 文案含模式 / 动作 / pane / 切换方式 |
| 切到 `workspace-write` 后同一动作放行 | 同一判定按解析出的模式分流, 单测覆盖三模式 |
| 无事件时按「不拦」处理并有单测钉住 | 策略服务缺失 / 解析抛错时不拦, 单测钉住 (验收口径按决策项 1 改写) |

## 实现记录

### 2026-10-19 实现

1. `src/types.ts`：新增 `SandboxMode`（宿主封闭词汇）与 `SandboxPolicyServiceLike`（只取 `resolve` 的结构替身）。
2. `src/policy.ts`：新增 `SANDBOX_WRITE_ACTIONS` / `isSandboxWrite` / `sandboxDenialReason` / `SandboxModeReader` / `asSandboxMode` / `makeSandboxModeReader`；头部注释由「三闸」改为「四道判定」。
3. `src/main.ts`：载荷类型改为宿主真实字段 `name` / `arguments` / `agent`（旧 `toolName` / `args` 缺陷一并修正）；`preExecuteVerdict(execution, { registry, config, sandboxMode })` 先沙箱 deny 后审批 ask；监听器只要不是 `allow` 就直接返回（不调 `next()`）；`HerdrPaneDeps` 新增 `sandboxMode` 注入口。
4. `src/tools.ts`：工具描述补一行「只读会话拒写类动作」。
5. `README.md`：安全边界改四道判定（沙箱门列第 3、审批门列第 4 并注明先于审批）、`deps` 注入面、用例文件描述、已知边界（库面直调不覆盖 / 只读下 `close` 被拒）。
6. 测试：`tests/policy.test.ts` 新增写类集合 / 拒绝文案 / 读取器六类用例；`tests/main.test.ts` 新增字段名回归、只读拒绝矩阵、可写与 fail-open、deny 先于 ask、监听器两态。

关键命令（均在 `herdr-pane/` 下）：`npm run check` 退出码 0；`npm test` 121 例全绿（基线 109）；`npm run build` 通过。

## 偏差

1. **拒绝位置**：条目正文写「订阅 `session/event` 折叠」并落在 `src/main.ts`（订阅 + 折叠）；实现按决策项 1 改为每次向 `ctx.sandboxPolicy.resolve()` 查询，落点文件不变（`main.ts` 监听器 + `policy.ts` 纯函数）。事件折叠与 `sessionProjections` 回放是同一份状态，故行为等价。
2. **验收口径**：条目原文「无事件时按不拦处理」改为「策略服务缺失 / 解析抛错时按不拦处理」（决策项 1，用户 2026-10-19 确认）。
3. **真机目视未做**：需要 herdr 会话内跑模型调用并观察审批面板，本次只做代码级证据（含两次反向验证），真机项留在验收对照表外（用户开工前已认可）。
4. **额外修了一个缺陷**（字段名）—— 已写入规划与决策项 6，不属范围外。

## 测试与证据

- `cd herdr-pane && npm run check` → 退出码 0（无输出）。
- `cd herdr-pane && npm test` → **121 例全绿 / 0 失败**（基线 109，+12）。
- `cd herdr-pane && npm run build` → 退出码 0。
- **反向验证 1**：把 `sandboxDenialReason` 的只读分支短路为 `return undefined` → 5 例转红（116 pass / 5 fail：拒绝文案、只读矩阵、拒绝先于审批、监听器只读、字段名回归）；恢复后 121 全绿。
- **反向验证 2**：把 `preExecuteVerdict` 的载荷读回 `execution.name` → 改成读 `execution.toolName` → 8 例转红（113 pass / 8 fail）；恢复后 121 全绿。
- 宿主面依据（静态证据）：`dsh-tools` 的 `createExecution` 给出 `name` / `arguments` / `agent`（`lib/index.js:3131-3191`、`types/index.d.ts:216-242`），`deny` 由宿主渲染为失败结果（`lib/index.js:3241-3257`）；`dsh-sandbox-policy` 的 `resolve` 优先级与会话回放（`lib/index.js:114-121,141-156`）。

## 收尾

- **回写文档**：包 `README.md`（安全边界四道判定、`deps` 注入面、用例文件描述、已知边界两条）；`src/policy.ts` / `src/main.ts` 头部注释；`src/tools.ts` 工具描述。未改 `DESIGN.md`（本包属轻量包，`AGENTS.md`「结构与约定」口径），未改 `STATUS.md`（用户择时更新）。
- **BACKLOG**：条目已标「完成」并从 `herdr-pane/docs/BACKLOG.md` 移除（只留未完成项），关闭记录写在该文件清单头。
- **归档**：本文件移入 `herdr-pane/docs/archived/2026-10-19-herdr-pane-sandbox-mode.md`。
- **提交**：一次提交（6 个源 / 测试文件 + 3 个文档），提交信息按 `feat(herdr-pane): ...`。
- **遗留**：
  1. 真机 herdr 会话内的拒绝 / 审批弹窗观感未验（见「偏差」3）。
  2. 库面 `dispatchAction` 直调不受沙箱门约束（README 已写边界，如需覆盖另立条目）。
  3. `docs/ARCHITECTURE-REUSE.md` 的 `herdr-pane` 审计行仍缺（属项目级未立项条目）。
