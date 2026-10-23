# herdr-use 共用服务面（服务面实现 + 现有工具面审查）

状态：规划（契约草案与计划已写，未动代码；2026-10-23 增补「工具面审查」范围）　　开启：2026-10-23　　关闭：—
接取条目：项目级 `docs/BACKLOG.md` §2「7. herdr-use 共用服务面（契约设计 + 实现，并复核工具面契约）」
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给 `herdr-use` 增加一个**进程内服务面** `ctx.provide("herdrUse", …)`，供编排类插件（首个消费者是 `coagent`）在不自建依赖的前提下建 pane / tab、驱动、取屏、收尾；**并主动审查现有工具面** —— 13 个动作的语义与参数面、归属 / 审批 / 沙箱三道边界、描述与实现是否一致 —— 审查发现的确定缺陷在本条一并修；两面差异只允许出现在「准入」这一层。

硬约束（来自 coagent 裁定）：**登记表与写锁必须是工具路径那一份**——否则归属校验与退出清理对不上。

## 边界

- 不改 `coagent` / `session-channel` / `agent-group`；不在本条改 session-channel 的「终态可被迟到结果覆盖」缺陷（另条）。
- 工具面行为变更**以审查发现的确定缺陷为限**（判定线见下节「工具面审查」）；不做风格重排、不改动作名、不新增模型侧动作。
- 不动审批门的接入形态（仍只挂 `tools/pre-execute`）；服务面**不**接入该门（见「准入」）；闸内判定逻辑的缺陷按审查结论修。
- 本条只到「服务面可用 + 工具面审查与缺陷修复 + 契约成文 + 单测」；coagent 的真机链路属 E 组。

## 工具面审查（本条第二件事，2026-10-23 增补）

审查对象是**现有** 13 个模型侧动作：`src/tools.ts` 的描述与参数 schema、`src/actions.ts` 的实现、`README.md` 的契约表述，逐条对表。覆盖三个维度（用户裁定）：

| 维度 | 看什么 | 处置 |
| --- | --- | --- |
| 动作语义与参数面 | 必填 / 可选参数、默认值与文档是否一致、互斥关系（`pane_wait` 的 `match` / `regex` / `stable` 三选一）、参数适用对象（`tab_*` 动作是否误用 `pane_id`）、`force` / `label` 的语义与生效条件 | 语义错或参数无效 → 修；纯命名口味差异 → 记条目 |
| 归属 / 审批 / 沙箱三道边界 | 沙箱闸的写类动作清单有无漏项、外来 pane 审批档（`foreign` / `always` / `never`）与 `allowForeignPanes` 的交互、跨 workspace `tab_close` 拒绝、`pane_close` 的 `force` 与审批先后 | 漏拒 / 误拒 / 档位不生效 → 修并补单测 |
| 描述与实现一致性 | `tools.ts` 主描述与各 action 描述、`README.md` 动作表 / 参数 / 安全边界节，与真实行为逐条比对 | 描述错 → 改描述；实现与文档相反 → 改实现 |

**「确定缺陷」判定线**：能在单测里钉住的行为偏差（漏拒 / 误拒 / 描述与实现相反 / 参数被忽略 / 默认值与文档不符）算确定缺陷，本条一并修；涉及 herdr 外部行为或真机时序的偏差只记条目（本条不跑真机）。不属缺陷的改进建议（新增动作、参数面重构、错误码体系）也记条目，不在本条做。

**产出**：下面「审查发现表」逐条登记（编号 / 维度 / 现象 / 证据 `文件:行` / 处置）；修完的项写明改动点与钉住它的单测。

## 审查发现表（执行审查时填写）

| 编号 | 维度 | 现象 | 证据 | 处置 |
| --- | --- | --- | --- | --- |
| — | — | 待审查 | — | — |

## 现状（2026-10-23 读码结论）

| 事实 | 证据 |
| --- | --- |
| 无 `provide`；`PluginCtxLike` 只有 `on` / `get` / `effect` / `tools` | `herdr-use/src/main.ts:78-88` |
| 入口只有一个：`apply(ctx, config, deps)` → `createHerdrPlugin` | `src/main.ts:414-441` |
| 动作实现集中在 `dispatchAction(action, args, deps, exec?)` | `src/actions.ts:1187` |
| 依赖面 `DispatchDeps`（config / runner / reader / registry / callerPaneId / callerTabId / resolveSession / guardCheck / clock） | `src/actions.ts:60-79` |
| 写锁 = `registry.serialize(key, task)`，按 pane 或 workspace 队列串行 | `src/actions.ts:1252,1257`；`src/registry.ts:166` |
| 会话解析 = `readSessionContext(exec)`，取 `exec.agent.session` / `exec.session` / `exec` | `src/workspace.ts:60-79` |
| 前置门 `preExecuteVerdict` 只挂在 `tools/pre-execute`，对工具调用生效（沙箱闸 + 外来 pane 审批闸） | `src/main.ts:176-243` |
| 退出清理 = `createExitCleanup(binPath, registry, config)` + `process.once("exit")` | `src/main.ts:377-390` |
| 工具动作共 13 个（pane 10 + tab 3） | `src/types.ts:37-49` |
| `pane_create` 落点 = 本会话 workspace 的**活动 tab**，并登记进同一个 registry | `src/actions.ts:398-467` |

**缺口**：外部插件若照 `createHerdrPlugin` 的 handle 组装第二份 deps，会得到第二份 `PaneRegistry` 与第二把锁；退出清理与归属判定都只认自己那份。

## 契约草案

### 1. 服务名与形态

`ctx.provide("herdrUse", service)`，`service` 在 `createHerdrPlugin` 内构造、与工具共用同一个 `dispatchDeps`：

```ts
interface HerdrUseService {
  // 通用面：所有方法内部都走同一个 dispatchAction（同一份 deps → 同一把锁 + 同一份登记表）
  dispatch(action: HerdrUseAction, args: Record<string, unknown>, exec?: unknown): Promise<ActionResult>;

  // 常用面的薄封装（返回 ActionResult 原样，不另造错误形态）
  createPane(args: { direction?: "right" | "down"; cwd?: string; label?: string }, exec?: unknown): Promise<ActionResult>;
  createTab(args: { cwd?: string; label?: string }, exec?: unknown): Promise<ActionResult>;
  run(paneId: string, command: string, exec?: unknown): Promise<ActionResult>;
  sendText(paneId: string, text: string, exec?: unknown): Promise<ActionResult>;
  sendKeys(paneId: string, keys: string[], exec?: unknown): Promise<ActionResult>;
  read(paneId: string, opts?: { source?: ReadSource; lines?: number; format?: ReadFormat }, exec?: unknown): Promise<ActionResult>;
  wait(paneId: string, opts?: { match?: string; regex?: string; stable?: boolean; timeoutMs?: number; settleMs?: number; lines?: number }, exec?: unknown): Promise<ActionResult>;
  info(paneId: string, exec?: unknown): Promise<ActionResult>;
  list(exec?: unknown): Promise<ActionResult>;
  closePane(paneId: string, opts?: { force?: boolean }, exec?: unknown): Promise<ActionResult>;
  closeTab(tabId: string, opts?: { force?: boolean }, exec?: unknown): Promise<ActionResult>;

  // 只读面：供消费方判断「这个 pane 是不是自己登记的」
  readonly registry: PaneRegistry;   // 只读用途；写操作仍须走上面的方法
  readonly config: ResolvedConfig;
}
```

**共用性保证**：服务对象的每个方法都直接调 `dispatchAction(action, args, dispatchDeps, exec)`，与工具注册用的是同一个 `dispatchDeps` 对象——锁、登记表、归属、caller 护栏、clock 全部同源。

### 2. 会话解析

沿用 `readSessionContext(exec)`：调用方把自己的 `exec`（工具执行上下文）透传进来；没有 `exec` 时由 `deps.resolveSession` 兜底（与库面现状一致）。**服务面不猜会话**——拿不到会话就返回 `session-unavailable` 结构化错误（现有语义，`src/actions.ts:338-358`）。

### 3. 准入（关键差异，必须写进 README）

| 层 | 工具面 | 服务面 |
| --- | --- | --- |
| 沙箱闸（只读会话拒绝写类） | 有（`tools/pre-execute`） | **无**（进程内可信 API） |
| 外来 pane 审批闸 | 有（`ask`） | **无** |
| 归属校验（未登记 pane 拒绝写） | 有（动作层 `ownership` 拒绝） | **有**（同一动作层） |
| 跨 workspace tab 拒绝 | 有 | **有** |

即：服务面只保留「归属 / workspace」这类**确定性**判定，不承担「要不要问人」；消费方（coagent）必须自己拿捏权限。

### 4. 回执形态

统一用现有 `ActionResult`（`ok` / `action` / `data` / `error` / `paneId` / `notes`），不新增错误码；`pane_read` 的截断仍在**工具层**做（服务面返回完整文本，`tools.ts:34-59` 的现状口径）。

## 工具面契约复核点（逐条确认/修订）

> 本节只讲「两面如何对齐」；工具面自身的缺陷审查见上文「工具面审查」节，两者不重复。

1. **动作清单**：13 个动作不变；服务面覆盖其中 pane 10 + tab 3，且补一个通用 `dispatch`。
2. **参数面**：服务面参数名与工具参数名保持一致（`pane_id` / `command` / `source` / `lines` / `stable` 等），减少两套心智。
3. **回执**：服务面直接返回 `ActionResult`，工具层负责渲染成模型可读文本（现状不变）。
4. **归属**：`pane_create` / `tab_create` 登记进同一 registry；`closePane` 只关 pane 并注销（不关 tab / workspace），与工具一致。
5. **审批**：服务面不走 `pre-execute`；README 的「安全边界」节要写清这一条，避免消费方误以为有闸。
6. **退出清理**：`closeOnExit` 时工具路径的清理要能覆盖**服务面建的 pane**（同 registry 天然满足，单测需钉住）。
7. **`pane_create` 落点**：仍固定为本会话 workspace 的活动 tab；`tab_create` 新建 tab。服务面不引入「指定 workspace」参数（模型层没有 workspace 概念，服务面也不开这个口子）。

## 待裁定（开工前需要一次确认）

1. **服务方法是否给 `exec` 参数**：草案给了（会话解析最准）；若嫌调用面啰嗦，可改成构造时绑定会话。
2. **是否暴露 `registry`**：草案给只读引用；若担心被误用，改为提供 `isRegistered(paneId)` 查询。
3. **`wait` 是否纳入服务面**：coagent 认领靠 session-channel，不需要 `wait`；但 pane 内启动脚本可能要判稳，留可选项。
4. **`dispatch` 是否公开**：公开便于未来动作复用到；不公开则只暴露具名方法（升级时加方法即可）。

## 计划改动文件清单

- `herdr-use/src/service.ts`（新增：类型 + 薄封装，内部调 `dispatchAction`）
- `herdr-use/src/main.ts`（`PluginCtxLike` 增 `provide?`；构造并 `provide("herdrUse", …)`；handle 暴露 service 便于测试）
- `herdr-use/src/index.ts`（导出服务类型，供 coagent 引用）
- `herdr-use/src/actions.ts`（仅当复核点 2/4 需要微调，或审查发现确定缺陷时动；无发现则不动）
- `herdr-use/src/tools.ts`（仅当审查发现描述 / 参数 schema 与实现不符时动；无发现则不动）
- `herdr-use/tests/service.test.ts`（新增：共享 registry / 锁串行 / 建读关 / 归属拒绝 / 服务面建的 pane 被清理识别）
- `herdr-use/tests/tool.test.ts`、`herdr-use/tests/actions.test.ts`（确定缺陷的回归用例，按发现追加）
- `herdr-use/README.md`（新增「服务面」节；在「安全边界」「参数」补两面对照表）
- `docs/BACKLOG.md`（条目状态流转；本轮已登记）

## 验收

- 单测：服务面与工具面共享**同一 registry 实例**；并发两个写操作可见串行（同一把锁）；服务面 `createPane` 后工具路径 `pane_list` / 退出清理能看到该 pane；对外来 pane 的写操作返回归属拒绝；`session-unavailable` 路径有覆盖。
- 工具面审查：三个维度对 13 个动作全覆盖，发现逐条进「审查发现表」（含证据 `文件:行`）；判定为确定缺陷的项已修并由单测钉住，判定为「记条目」的项已写入对应 `BACKLOG.md`。
- `cd herdr-use && npm run check && npm test` 全绿；根 `npm run check` 通过。
- README 两面语义对照成文（准入差异、回执、归属、清理各一行）。
- 不做真机（真机属 coagent 的 E 组；本轮只到服务面可用 + 工具面审查 + 契约成文）。

## 明确不做

- 不动 `coagent/`（消费方实现属 E 组）。
- 不改 `session-channel` 终态缺陷。
- 不改工具面动作语义的「设计品味」部分（只修审查发现的确定缺陷）；不新增模型侧动作；不动审批门的接入形态（仍只挂 `tools/pre-execute`、仍经审批面板），闸内判定逻辑的缺陷按审查结论修。
- 不给服务面加「指定 workspace」能力。
