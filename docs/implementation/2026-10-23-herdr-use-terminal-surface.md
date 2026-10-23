# herdr-use 终端面重构（10 个工具）与共用服务面

状态：规划（2026-10-23 由「共用服务面」条目扩范围并入；契约与计划已成文，代码未动）
接取条目：项目级 `docs/BACKLOG.md` §2「7. herdr-use 共用服务面」——本轮按用户裁定扩为「终端面重构 + 共用服务面」，两件事同轮交付
本文件是本任务唯一的过程记录与文档落点；计划外的文件不改。

## 用户裁定（2026-10-23）

| 项 | 裁定 |
| --- | --- |
| 工具面 | 拆成 10 个独立模型侧工具，无 `action` 参数：`herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run`；旧 `herdr_use` 与 `pane_*` / `tab_*` 动作全删，不留别名 |
| 终端模型 | 一个终端 = 本插件 `herdr_create`（内部 `tab create`）建出的一个 tab + 它自带的 root pane；返回 root pane id 作 `terminal_id`；`herdr_close` 关整个 tab |
| 抽象 | 工具面只露 `terminal_id`，不出现 pane / tab / workspace 概念，不出现 `tab_id` |
| 会话 | 严格一个 dsh 会话一个 workspace（不再进程内单例、子会话沿用） |
| 后台 | `herdr_create` 增 `foreground`（缺省 `true`）；`false` 时该终端所有命令加 `--session dshbg`，落在名为 `dshbg` 的 herdr session |
| 归属 | 删 `allowForeignPanes` / `force` / `requireApproval` 与外来 pane 审批门；只留登记校验与沙箱闸 |
| label | 同时改 tab 标题与 root pane label |
| list | 汇总两个 lane，逐条标 `foreground` 与 `registered` |
| 服务面 | 原 #7 服务面并入本轮，方法用 camelCase（`create` / `list` / `read` / `info` / `wait` / `label` / `text` / `key` / `run` / `close`），不加前缀；与工具面共用同一份登记表与写锁 |
| 错误码 | 同步改为 terminal 口径：`pane-required` -> `terminal-required`、`pane-not-registered` -> `terminal-not-registered`；删 `tab-required` / `tab-not-registered` / `foreign-pane` / `approval-denied`；新增 `ambiguous-terminal` |

## 目标

把 `herdr-use` 从「pane / tab 双层、单工具多动作」收敛为「终端单层、十工具」：调用方只认识终端 id 与十个具名工具，内部一律由一个 tab 承载；同轮补 `ctx.provide("herdrUse", …)` 服务面，与工具面共用同一份登记表、同一把写锁、同一套会话绑定。

硬约束：同一个 `dispatchDeps`、同一个 registry 实例、同一把 `serialize` 队列；否则退出清理与归属判定对不上。

## 终端与 lane

- **终端**：`herdr_create` 调 `tab create --workspace <绑定> --cwd <cwd> --label <label> --no-focus`，回执取 `.result.tab.tab_id` 与 `.result.root_pane.pane_id`；`terminal_id` = root pane id，`tab_id` 只存登记表、不出工具面。
- **lane**：`foreground`（继承父会话所在 herdr session，不传 `--session`）与 `background`（`--session dshbg`）。`dshbg` 是固定常量，不新增配置；herdr 的 `--session` 语义是「使用或创建」（二进制帮助原文：`Use or create a named persistent session`），无需先建会话。
- **绑定**：`Map<dsh session id, Map<lane, WorkspaceBinding>>`。每个 (会话, lane) 一个 workspace，label 沿用 `<会话 cwd 目录名>/<会话 id 末 8 位>`；两个 lane 在不同 herdr session 内，同名不冲突。
- **路由**：每条 CLI 调用经 lane runner：background 前置 `["--session", "dshbg"]`；foreground 不加参数。socket（`read` / `wait` 的 stable）按 lane 解析路径：foreground 用 `HERDR_SOCKET_PATH` 或 `status --json`；background 用 `--session dshbg status --json`。
- **退出清理**：按绑定遍历两个 lane，逐条 `tab close` 登记终端；该 workspace 已空则 `workspace close`。同步清理面同样带 lane 前缀。

## 工具契约（10 个）

| 工具 | 作用 | 必填 | 参数 |
| --- | --- | --- | --- |
| `herdr_list` | 列两个 lane 绑定 workspace 里的终端（tab 维度），逐条标 `foreground` / `registered` / `focused` / `pane_count` | — | 无 |
| `herdr_read` | 取屏（走 socket，回执带 `revision` / `truncated`） | `terminal_id` | `source?`（缺省 `recent-unwrapped`）· `lines?`（缺省 120）· `format?`（缺省 `text`） |
| `herdr_info` | 进程探活（`foreground_processes` / `shell_pid` / `running`） | `terminal_id` | — |
| `herdr_wait` | 等输出：`match` 字面量 / `regex` 正则 / `stable` 静默判稳（三选一，互斥） | `terminal_id` + 三者之一 | `settle_ms?`（缺省 400）· `timeout_ms?`（缺省 30000）· `source?` / `lines?` |
| `herdr_create` | 在目标 lane 的会话 workspace 建终端（新 tab，`--no-focus`，自动打 label） | — | `foreground?`（缺省 `true`）· `cwd?`（缺省会话工作目录）· `label?`（缺省配置 `label`） |
| `herdr_close` | 关整个终端（关 tab，注销登记） | `terminal_id` | — |
| `herdr_label` | 同时改 tab 标题与 root pane label（非空） | `terminal_id`、`label` | — |
| `herdr_text` | 注入字面量文本（不回车） | `terminal_id`、`text` | — |
| `herdr_key` | 发按键序列（如 `["ctrl+c"]`） | `terminal_id`、`keys`（非空字符串数组） | — |
| `herdr_run` | 文本 + 回车一次提交 | `terminal_id`、`command` | — |

- 工具名即动作，无 `action` 参数；每工具 schema 独立（`additionalProperties: false`），模型看不到无关参数。
- `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run` / `herdr_close` 只接受**已登记**终端；未登记返回 `terminal-not-registered`。`herdr_list` 里 `registered: false` 的残留终端仅供识别，需人工在 herdr 里关闭。
- `herdr_list` 的 `terminal_id` 由 tab 的 root pane 反查（`pane list --workspace` 按 `tab_id` 对齐；已登记者取登记值）；`tab list` 本身不含 root pane 字段。
- 内部仍用统一的 `dispatchAction` 实现，十个工具是十个薄壳；便于服务面与工具面同源。

## 准入与安全

| 层 | 工具面 | 服务面 |
| --- | --- | --- |
| 沙箱闸（`tools/pre-execute`） | 有：`read-only` 会话拒 `herdr_create` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run` / `herdr_close`，放行 `herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` | 无（进程内可信 API，消费方自负策略） |
| 外来 pane 审批门 | **删除**（抽象后无可达外来 pane） | 无 |
| 归属校验（动作层） | 有：未登记 / 跨 workspace 一律拒 | 有（同一动作层） |
| 调用者护栏 | 有：继承 lane 下 `herdr_close` 调用者所在 tab 拒；不读调用者 pane | 有（同一动作层） |

- 删除的配置项：`requireApproval` / `allowForeignPanes`（旧 profile 里残留会被 `resolveConfig` 忽略，不报错）。
- 保留的配置项：`closeOnExit` / `label`（缺省 `dsh-pane`）/ `timeoutMs` / `renderLimit`。
- `security-guard` 登记改为 10 条：`herdr_run` 的 `command`、`herdr_text` 的 `text` 是命令文本，`herdr_key` 的 `keys[]` 是命令路径；其余工具无命令面。
- 命令仍跑在 dsh 文件沙箱之外，`security-guard` 复查与登记继续生效。

## 服务面（原 #7，并入本轮）

```ts
export interface HerdrUseService {
  dispatch(action: HerdrUseAction, args: Record<string, unknown>, context?: unknown): Promise<ActionResult>;
  list(context?: unknown): Promise<ActionResult>;
  read(terminalId: string, opts?: ReadOptions, context?: unknown): Promise<ActionResult>;
  info(terminalId: string, context?: unknown): Promise<ActionResult>;
  wait(terminalId: string, opts?: WaitOptions, context?: unknown): Promise<ActionResult>;
  create(opts?: CreateOptions, context?: unknown): Promise<ActionResult>;
  close(terminalId: string, context?: unknown): Promise<ActionResult>;
  label(terminalId: string, label: string, context?: unknown): Promise<ActionResult>;
  text(terminalId: string, text: string, context?: unknown): Promise<ActionResult>;
  key(terminalId: string, keys: readonly string[], context?: unknown): Promise<ActionResult>;
  run(terminalId: string, command: string, context?: unknown): Promise<ActionResult>;
  isRegistered(terminalId: string): boolean;
  readonly config: ResolvedConfig;
}
```

- `CreateOptions`：`foreground?` / `cwd?` / `label?`；`ReadOptions`：`source?` / `lines?` / `format?`；`WaitOptions`：`match?` / `regex?` / `stable?` / `settleMs?` / `timeoutMs?` / `source?` / `lines?`（服务面 camelCase，内部映射到工具参数）。
- **会话上下文**（取代「exec 透传」的窄口径）：末参 `context` 可为宿主工具 `exec`、`{ session: { id, cwd } }` 或 `{ id, cwd }`——`readSessionContext` 三种形态都已支持（`src/workspace.ts:60-79`）。插件消费方（如 coagent）不必伪造工具上下文，直接传自己的会话对象即可；什么都不传则 `resolveSession` 兜底，仍取不到返回 `session-unavailable`。
- 每个方法直接调 `dispatchAction(action, args, dispatchDeps, context)`，与十个工具共用同一对象；`ctx.provide?.("herdrUse", service)`，`PluginCtxLike` 增 `provide?`，并按仓库先例导出 `provide = ["herdrUse"]`。
- 不暴露 registry（避免外部误写），只给 `isRegistered` 与 `config`；通用 `dispatch` 公开，便于未来扩展。
- 回执沿用 `ActionResult`（错误码按上表改名）；`herdr_read` 的文本截断仍只在工具渲染层做。
- 服务面不经 `tools/pre-execute`。

## 工具面复核点（设计即审）

1. 十个工具的名称、描述、参数 schema、`README.md` 与真实行为逐条对表；每工具 `additionalProperties: false`，不给无关参数。
2. 参数面不得出现 `action` / `pane_id` / `tab_id` / `workspace` / `direction` / `force` / `allowForeignPanes`。
3. 归属拒绝、调用者护栏、沙箱拒绝的回执文案与文档一致；错误码无 pane / tab 字样。
4. `herdr_list` 字段、`herdr_create` 回执字段（`terminal_id` / `label` / `cwd` / `foreground`）在两面对齐。
5. 十个工具都注册到同一 `dispatchDeps`；`tools/pre-execute` 按工具名判定写类集合，未知工具不拦。

## 现状证据（2026-10-23 读码）

| 事实 | 证据 |
| --- | --- |
| 单工具 `herdr_use` + 13 动作，pane / tab 两层 | `herdr-use/src/types.ts:18-49`、`herdr-use/src/tools.ts:260-430` |
| 无 `provide`；`PluginCtxLike` 只有 `on` / `get` / `effect` / `tools` | `herdr-use/src/main.ts:78-88` |
| 进程内只维护一个 workspace 绑定，子会话沿用 | `herdr-use/src/registry.ts:71-73`、`herdr-use/src/workspace.ts:1-20` |
| `tab create` 返回 `.result.tab.tab_id` + `.result.root_pane.pane_id`，成功后同时登记 tab 与 root pane | `herdr-use/src/actions.ts:497-580` |
| `tab list` 的 `TabInfo` 不含 root pane 字段 | `herdr-use/src/actions.ts:279-298` |
| 审批闸与沙箱闸都挂在 `tools/pre-execute` | `herdr-use/src/main.ts:176-243` |
| `security-guard` 只按旧工具名 `herdr_use` 登记命令面 | `security-guard/src/index.ts:273` |
| 旧口径允许 `pane_create` / `tab_create` 在 `read-only` 下放行 | `herdr-use/README.md:90` |

## 计划改动文件清单

- `herdr-use/src/types.ts`：工具名常量（10 个）与动作枚举；`TerminalRecord`（paneId / tabId / lane / cwd / label / workspaceId）；配置删 `requireApproval` / `allowForeignPanes`；错误码改 terminal 口径。
- `herdr-use/src/tools.ts`：改为 10 个工具定义（名称 / 描述 / 独立 schema / 薄壳 execute），共用同一份参数校验与回执渲染。
- `herdr-use/src/actions.ts`：重写 10 个动作实现；`terminal_id` 解析、归属拒绝、lane 路由、`list` 聚合、`close` 关 tab、`label` 双写。
- `herdr-use/src/registry.ts`：终端登记（键含 lane）、按会话 × lane 的绑定表、退出清理；删 `unregisterTabByRootPane` / 外来判定。
- `herdr-use/src/workspace.ts`：lane 感知的绑定解析与 workspace 创建 / 复用。
- `herdr-use/src/cli.ts`：lane runner（`--session` 前置）、按 lane 解析 socket 路径、握手读 `HERDR_SESSION`。
- `herdr-use/src/service.ts`（新增）：服务类型 + 薄封装 + `provide` 装配。
- `herdr-use/src/main.ts`：注册 10 个工具；删审批闸，保留沙箱闸（按工具名映射写类集合）；构造并 `provide("herdrUse", …)`。
- `herdr-use/src/index.ts`：导出服务类型、工具名常量。
- `herdr-use/tests/service.test.ts`（新增）：共享 registry / 锁串行 / 建读关 / 归属拒绝 / 两 lane 清理。
- `herdr-use/tests/{tools,actions,main,registry,workspace,cli,policy}.test.ts`：按新面改写，覆盖 10 个工具的 schema 与 lane 前缀 argv。
- `herdr-use/tests/helpers.ts`：fake runner 支持按 lane 断言。
- `herdr-use/README.md`：重写工具表、会话模型（foreground / dshbg）、安全边界、服务面节。
- `herdr-use/scripts/verify-herdr-use.mjs`：验证链改 10 个工具与新参数。
- `security-guard/src/index.ts`：`PLUGIN_COMMAND_TOOLS` 改 10 条登记。
- `behavior-correction/src/main.ts`（一行）：指路文案由 `herdr_use` / `pane_*` 改为 `herdr_run` / `herdr_text` / `herdr_key` 等。
- `docs/BACKLOG.md`：条目 7 范围、组表 I1 工作量（1 至 1.5 天 -> 2 至 3 天）。
- 本追踪文档。

**不改**：`coagent/`、`session-channel/`、`agent-group/`、`herdr-integration/`；根 `README.md` / `README.zh.md` / `AGENTS.md` 的包描述按 2026-10-23 约定由 H 组回写。

## 验收

- 单测：10 个工具各自 schema（`additionalProperties: false`、必填项、无 `action`）、注册数 10、argv 形状（含 `--session dshbg` 前缀）、`terminal_id` 归属拒绝、`herdr_list` 两 lane 聚合与 `registered` 标记、`herdr_close` 关 tab 而非单 pane、两个 dsh 会话各有独立 workspace、退出清理跨 lane、服务面与工具面共享同一 registry 与同一把锁（串行可观察）、`session-unavailable` 覆盖、context 三种形态（exec / `{session}` / `{id,cwd}`）。
- `cd herdr-use && npm run check && npm test` 全绿；`cd security-guard && npm test`、`cd behavior-correction && npm test` 全绿；根 `npm run check` 通过；`npm run build` 通过。
- 改动文件跑 `format`；README 与十个工具描述逐条一致。
- 真机不跑；`--session dshbg` 的实际建会话、`tab rename` 行为列未验证项。
- 人工确认：合并后由用户挂载 profile 实测 `herdr_create -> herdr_run -> herdr_read -> herdr_close` 与 `foreground: false` 一次。

## 未验证 / 风险

- `herdr --session dshbg` 的「使用或创建」语义取自二进制帮助文本，未在真机建会话验证；若实际不自动创建，需在 ensure 阶段补 `session` 命令（实现时留一条注释）。
- `tab rename` 只接受非空 label（帮助为 `tab rename <tab_id> <label>`），故不提供「清空 label」语义。
- 跨 lane 的 pane id 若碰撞（两个 session 各自从 `w1:p1` 起编号），按 `terminal_id` 查找会歧义；实现时以 lane + pane id 建键，歧义即返回 `ambiguous-terminal` 并提示用 `herdr_list` 重取。
- 删除 `requireApproval` / `allowForeignPanes` 后，旧 profile 的未知配置被静默忽略（不迁移、不告警）。
- 工具数从 1 增至 10，模型侧上下文与 `security-guard` / 审批名单 / 文档同步成本上升；已计入工作量。

## 明确不做

- 不改 `coagent`（消费方实现属 E 组）；不改 `session-channel` 终态缺陷。
- 不保留旧 `herdr_use` 工具或旧动作别名；不新增 workspace / tab / 布局类工具。
- 不做真机验证；不引入跨 herdr machine / remote 目标。
- 根 README 双侧与 `AGENTS.md` 的包描述留给 H 组回写。
