# herdr 工具面添加 tab / workspace 操作（接取条目：`herdr-pane/docs/BACKLOG.md`「herdr 工具面添加 tab / workspace 操作」）

状态：实现完成（待关闭确认）　　开启：2026-10-21　　关闭：待用户确认后归档
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

> 2026-10-21 第二次改向（用户裁定）：**取消「组」概念，只保留会话 ↔ workspace 的对应，且由插件内部保证、模型接触不到 workspace 面**。本文档已按此重写决策与规划；被取代的决策保留原文并划掉。

## 目标

工具面只暴露 **tab 层与 pane 层**（外加既有 pane 动作），模型看不到也传不进 workspace id / 名字；每个 dsh 会话由插件内部绑定一个 herdr workspace（首次使用时确保存在，之后复用），该会话建出的全部 tab / pane 落在其中，写操作不出这个 workspace。workspace 的创建 / 查找 / 生命周期都由程序内部完成。**dsh 不一定跑在 herdr 里**（tmux、普通终端均可）：工具只需 herdr 二进制可用且服务端可达，调用者 pane 从必需条件降为可选上下文。

## 调研

01. **herdr CLI 已有完整 tab / workspace 子命令**（本机 `herdr 0.9.x`，`herdr tab --help` / `herdr workspace --help`）：
    - `tab`：`list` / `create` / `get` / `focus` / `rename` / `close`；`tab create` 支持 `--workspace` / `--cwd` / `--label` / `--env` / `--focus` / `--no-focus`。
    - `workspace`：`list` / `create` / `get` / `focus` / `rename` / `report-metadata` / `close`（另有 `move` / `move_block`，仅 socket 方法）。
    - `pane split [PANE_ID]` 可指定目标 pane（也支持 `--pane` / `--current`），**没有 `--tab`**：只能在某个 pane 上切，故「切进本会话 workspace」必须先解析出该 workspace 的活动 pane。
02. **回执形状（三处交叉验证：官方 skill `herdr --skill`、`herdr api schema --json`、真机 `herdr tab list` / `herdr workspace list`）**：
    - `tab create` → `result.tab`（`TabInfo`）+ **`result.root_pane`**（`PaneInfo`，含 `pane_id`）。
    - `workspace create` → `result.workspace` + `result.tab` + `result.root_pane`。
    - `tab list` → `result.tabs[]`：`tab_id` / `workspace_id` / `number` / `label` / `focused` / `pane_count` / `agent_status`（真机实测）。
    - `workspace list` → `result.workspaces[]`：`workspace_id` / `number` / `label` / `focused` / `pane_count` / `tab_count` / `active_tab_id` / `agent_status`（真机实测；`worktree` 可为 null）。
    - `pane list` 的每条已带 `tab_id` / `workspace_id`，故「本 workspace 的活动 pane」可由 `workspace list` 的 `active_tab_id` + `pane list` 对齐取得。
03. **调用者上下文（可选）**：herdr 向受管 pane 注入 `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` / `HERDR_PANE_ID`；但 dsh 未必在 herdr 内（tmux / 普通终端），故这些变量只作可选上下文：在 herdr 内时用于护栏（不读调用者自己的 pane、不关调用者所在 tab），不在时全部省略。**它们与「会话 workspace」无关**——创建 / 切 pane 一律落在会话 workspace，不落 dsh 所在 workspace。
04. **官方安全口径**（`herdr --skill`）：后台工作用 `--no-focus`；不依赖别的客户端的焦点；不关闭非自己创建的对象；不建 workspace / tab / worktree 除非明确需要。
05. **本包现状**（`src/` 十个动作全为 pane 层）：CLI 为主、`read` / `wait stable` 走 socket；`PaneRegistry` 记 pane 归属；四道门（guard 复查 / security-guard 登记 / 沙箱模式 / 越界审批）。`tools/pre-execute` 网关只认 `args.pane_id`，无 pane_id 直接放行——新增 tab 动作必须改这里。
06. **来源事件**：0.2.1 升级真机复测时，独立验证实例只能 `herdr tab create`（bash），其 pane 未登记，`herdr_pane read` / `run` 被归属门拒绝（2026-10-21 实测）。
07. **herdr 没有「任意 workspace 归组」的接口**：schema 里 group 只出现在 `close_group` 与 `workspace_group_close_required`；真分组由 `worktree open` 产生（primary + linked worktree，需 git trust）。普通 `workspace create --cwd` 不挂 repo / worktree 信息（本机 `workspace list` 六项均无 `worktree` 字段）。故「组」只能靠命名表达，已按用户裁定取消。
08. **会话身份可得**：宿主 `defineTool` 把执行上下文透传给工具（`execute(args, exec)`，见 `dsh-tools/lib/index.js:866`），`exec.agent.session` 即会话对象，带 `id` 与 `meta.cwd`（`dsh-session` 的 `Session` 构造入参）。子代理会话有自己的 session id——按「进程内首个使用该工具的会话」缓存 workspace，子会话调用沿用同一 workspace（边界写明）。
09. **复用不依赖持久存储**：`workspace list` 返回全部 workspace 及 label，按「约定 label 精确匹配」即可在 dsh 重启后找回本会话的 workspace；找不到才新建。代价是用户手工改名会导致下次新建（记入已知边界）。
10. **herdr CLI 可脱离 herdr 环境使用**：清空全部 `HERDR_*` 后 `herdr tab list` 仍正常返回（socket 缺省 `/home/guochang/.config/herdr/herdr.sock`；`herdr status` 报 server running，client / server 0.9.5、protocol 22，2026-10-21 实测）。故工具可用性只需「二进制 + 可达服务端」，不要求在 herdr 内。
11. **关闭语义未文档化**：`pane close` / `tab close` 成功响应只有 `type` 与 id，未说明「关掉最后一个 pane 是否级联关 tab / workspace」；官方 skill 只说普通 CLI/API 关闭不继承 TUI 的最后一格确认。列真机待验项。

## 决策

**决策项 1 = 动作面范围**（~~被决策项 6 取代~~）

- ~~(a) 新增 5 个动作：`tab_create` / `tab_list` / `tab_close` / `workspace_list` / `workspace_create`，工具面 10 → 15。~~
- ~~(b) (a) 之外再加 `workspace_get` / `workspace_close` / focus 类。~~
- ~~(c) 只加 `tab_create` / `tab_list` / `tab_close`（不加 workspace 面）。~~
- ~~**选定 (a)**（2026-10-21 用户裁定「workspace 做 list、create，不做关闭」）。~~ → 由决策项 6 取代（workspace 面整体撤出工具）。

**决策项 2 = 焦点与拓扑重操作**

- (a) 不提供 `tab_focus` / `workspace_focus`；`tab_create` 一律 `--no-focus`。
- (b) 提供 focus 动作（会抢用户视图），按审批档每次打断。
- (c) focus 全量提供。
- **选定 (a)**。理由：本工具定位是后台驱动，官方明确要求后台工作不抢焦点；焦点是人的视图状态，模型没有切换它的正当理由。焦点不影响任何对象可达性（id 全部显式解析）。

**决策项 3 = 目标解析与默认值**（~~被决策项 6 / 7 取代~~）

- ~~(a) `tab_create` / `tab_list` 的 `workspace` 缺省取调用者所在 workspace（`HERDR_WORKSPACE_ID`）……~~
- ~~(b) 不传 `--workspace`，交给 herdr 用 UI 焦点所在 workspace。~~
- ~~(c) `workspace` 与 `cwd` 都必填。~~
- ~~**选定 (a)**。~~ → 由决策项 6 / 7 取代：模型不再传 `workspace`，目标由会话绑定内部解析。

**决策项 4 = 归属登记与门禁口径**（~~被决策项 8 取代~~）

- ~~(a) `tab_create` 登记 tab + root pane；`workspace_create` 登记 workspace + tab + root pane；`tab_close` 只关自建 tab（非自建需 `allowForeignPanes` + `force`）……~~
- ~~(b) 只登记 root pane。~~
- ~~(c) 只登记 tab。~~
- ~~**选定 (a)**。~~ → 由决策项 8 取代：归属改为「本会话 workspace + 登记表」，写操作不出本 workspace。

**决策项 5 = 自建 workspace 的关闭路径与残留处理**（~~被决策项 9 取代~~）

- ~~(a) 不提供 `workspace_close`：关 workspace 走「关掉它的 root pane」……~~
- ~~(b) 提供 `workspace_close` 但加严……~~
- ~~(c) 不建 workspace。~~
- ~~**选定 (a)**。~~ → 由决策项 9 取代（生命周期收进程序内部）。

**决策项 6 = 层级映射：只要会话 ↔ workspace，组概念取消**

- (a) 工具面只到 tab / pane 两级：新增 `tab_create` / `tab_list` / `tab_close`（工具面 10 → 13），**不出现任何 workspace 动作与 `workspace` 参数**；会话 ↔ workspace 由插件内部绑定。
- (b) 保留 `workspace_list` 只读，让模型知道有哪些 workspace（与「模型接触不到」冲突）。
- (c) 保留 workspace 创建 / 关闭动作（自由拓扑，用户已否决）。
- **选定 (a)**（用户 2026-10-21 裁定：「不管组这个概念了，只管会话-工作区的对应。这个由程序内部保证，模型接触不到」）。理由：workspace 是「会话的隔离容器」，不是模型可编排的资源；模型只需要在其内部建 / 关 tab 与 pane。少一层动作面 = 少一层误伤面与描述成本。

**决策项 7 = 会话 ↔ workspace 的绑定与命名**

- (a) label = `<cwd 目录名>/<会话 id 短标记>`（如 `dsh-toolset/a1b2c3d4`）；首次需要时 `workspace list` 精确匹配复用，无则 `workspace create --cwd <会话 cwd> --label <label> --no-focus`；进程内缓存 binding，子会话调用沿用同一 workspace。
- (b) label 用会话标题（标题生成晚、可被改名，解析不稳）。
- (c) 不查历史，每次新建（重启即多一个空壳）。
- **选定 (a)**。理由：cwd 是会话的天然归属，加上会话 id 短标记即可在同一目录下区分多个会话且可跨重启找回；不引入持久存储（不新增 `sessionPaths` 依赖），也不依赖可变的标题。会话 id 取 `exec.agent.session.id`（短标记取末 8 位，过滤非法字符）。用户手工改名后下次会新建——写入已知边界。

**决策项 8 = 写边界与 `create` 重定向**

- (a) 写操作只落在本会话 workspace：`tab_create` 固定 `--workspace <本会话 workspace>`；`tab_close` 只关本 workspace 内已登记的 tab（其他一律拒，不再走 `allowForeignPanes` 例外）；**`create` 改为切本 workspace 活动 tab 的 pane**（`pane split <pane_id> --direction … --cwd <会话 cwd> --no-focus`），不再切调用者 pane；读类（`read` / `info` / `list`）仍可跨 workspace 观察。
- (b) 读也只限本 workspace（对用户排障更不友好）。
- (c) `create` 仍切调用者 pane（pane 会落到用户的 workspace，边界泄漏）。
- **选定 (a)**（2026-10-21 用户补充：「自己的」指会话对应的那个固定 workspace，不是会话本身所在的 workspace；dsh 可能在 tmux 或普通终端里跑）。理由：这是「每个会话只能修改自己的 workspace」的落点；dsh 不在 herdr 内时没有调用者 pane 可用，重定向也顺带解决了这个前提；读放开不产生副作用，排障仍可用。`create` 重定向是唯一的行为变更，README 与工具描述都要写明。

**决策项 9 = 会话结束后的 workspace 残留（待用户确认）**

- (a) 退出清理时，若本会话 workspace 内全部 pane 都是本插件登记且已关闭，则由程序内部一并关闭该 workspace（`workspace close`，仅此一例、不出工具面）。
- (b) 一律不关：关掉登记 pane 后留空壳，由人工或后续条目处理。
- (c) 留给下一个会话复用（label 含会话 id，跨会话复用语义不通）。
- **暂定 (a)**（2026-10-21 提问未答，先按推荐落定，可随时改判）：残留空壳是「内部保证生命周期」的破口；限制在「全部 pane 均属本插件」可避免误伤用户后来在其中开的 pane。

**决策项 10 = 工具注册条件（降级口径）**

- (a) 二进制可解析 + 服务端可达（`herdr status` 或一次只读 `tab list` 探活）即注册；`HERDR_*` 全部可选；探活失败只记一行日志、不注册。
- (b) 维持三变量齐备才注册（会把 tmux / 普通终端场景整体排除）。
- (c) 无论是否可达都注册，调用时返回不可用原因。
- **选定 (a)**。理由：用户明确 dsh 不一定在 herdr 内；一次只读探活的成本可接受，且延续既有「不注册必然失败的工具」口径（避免诱使模型反复试错）。

## 规划

### 任务拆分

01. **会话绑定**（新模块 `src/workspace.ts`）：`exec.agent.session` → `{id, cwd}`；label 规范化；`workspace list` 精确匹配 / `workspace create` 确保；进程内缓存；解析本 workspace 活动 pane；子会话沿用缓存。
02. **工具入参面**：工具 `execute(args, exec)` 接执行上下文（`main.ts` 组装时把 `exec` 传给 `dispatchAction`）；`DispatchDeps` 增会话解析器。
03. **动作实现**：`tab_create` / `tab_list` / `tab_close` 三个 handler（argv / 信封 / 登记 / 注销）；`create` 改为按会话 workspace 的活动 pane 切分（保留 `direction` / `cwd` / `label` 参数语义）；工具面动作枚举 10 → 13。
04. **登记表**：`WorkspaceBinding`（`sessionId` / `workspaceId` / `label` / `cwd` / `rootPaneId`）缓存 + `TabRecord`（`tabId` / `workspaceId` / `label` / `rootPaneId` / `createdAt`）；`tab_close` 注销 tab 与 root pane；pane `close` 掉 tab root 时注销 tab。
05. **门禁**：`tab_close` 计入审批集合与沙箱写集合（`read-only` 拒）；`tools/pre-execute` 网关按 `tab_id` 解析归属（当前只认 `pane_id`）；拒绝关闭调用者所在 tab（`HERDR_TAB_ID`，防御性，正常不出现）；跨 workspace 的 tab 一律拒。
06. **生命周期**：按决策项 9 落定后在 `dispose` / `exit` 清理后处理 workspace（含「全部 pane 属本插件」的前置核对）。
07. **测试**：见下。
08. **真机验证**：扩展 `verify-herdr-pane.mjs`：`--with-tab`（建 tab → run → wait → read → tab_close）；`--with-create-in-workspace`（`create` 落在会话 workspace、`pane list` 核对 `workspace_id`）；`--cwd` 变化下的复用（同一会话重跑脚本应复用 workspace）；`--check-cascade`（关掉最后一个 pane 后 `workspace list` 是否还在）。
09. **文档回写**：`README.md`（能力表 / 归属与生命周期 / 安全边界 / 已知边界 / `create` 行为变更 / 降级口径改为「二进制 + 服务端可达」）；BACKLOG 条目完成并移出；本追踪文档归档。
10. **可用性判定**：`cli.ts` 的握手改为「探活 + 可选上下文」——`HERDR_SOCKET_PATH` 有则用，无则走 CLI 缺省；`HERDR_PANE_ID` / `HERDR_TAB_ID` / `HERDR_WORKSPACE_ID` 缺失不阻止注册。

### 计划改动文件清单

- `herdr-pane/src/workspace.ts`（新）：会话 → workspace 的绑定、确保、解析活动 pane、label 规范化。
- `herdr-pane/src/cli.ts`：握手改为「二进制 + 服务端探活」，`HERDR_*` 全部可选；保留调用者 pane / tab 作为护栏上下文。
- `herdr-pane/src/types.ts`：动作枚举（13）、`WorkspaceBinding` / `TabRecord` 类型、错误码（`session-unavailable` / `workspace-unavailable` / `tab-required` / `tab-not-registered`）。
- `herdr-pane/src/registry.ts`：binding 缓存与 tab 登记面、tab 关闭 argv 同源。
- `herdr-pane/src/actions.ts`：三个 tab handler、`create` 重定向、分派与写边界、`DispatchDeps` 增会话解析。
- `herdr-pane/src/policy.ts`：审批 / 沙箱集合加入 `tab_close`、跨 workspace 拒绝文案。
- `herdr-pane/src/main.ts`：注册条件改为探活（决策项 10）；`tools.register` 的 `execute(args, exec)` 透传；pre-execute 网关按 `tab_id` 判定；退出清理的 workspace 处理（按决策项 9）。
- `herdr-pane/src/tools.ts`：枚举、描述（写明「workspace 由插件内部绑定、模型不可见」与 `create` 落点）、`tab_id` 参数、三个渲染分支。
- `herdr-pane/src/index.ts`：库面导出新增类型 / 常量（按需）。
- `herdr-pane/tests/*.test.ts`：见下。
- `herdr-pane/scripts/verify-herdr-pane.mjs`：真机链路扩展。
- `herdr-pane/README.md`、`herdr-pane/docs/BACKLOG.md`、本文件。

### 测试要点（逐文件）

- `actions.test.ts`：`tab_create` argv（固定 `--workspace <binding>`、`--cwd` / `--label` / `--no-focus`）、回执缺 `root_pane` 的失败；`tab_list` argv 与登记标记；`tab_close` 同 workspace 登记放行 / 跨 workspace 拒 / 调用者 tab 拒 / 注销 tab 与 root pane；`create` 重定向（`pane split <本 workspace 活动 pane>`，不出现 `--current`）、无活动 pane 时的失败与提示；会话缺失 / workspace 确保失败的结构化回执。
- `workspace.test.ts`（新）：label 规范化、`workspace list` 匹配复用 / 未匹配新建、缓存命中、子会话沿用、活动 pane 解析（含多 tab / 空 tab）。
- `registry.test.ts`：binding 缓存与 tab 登记、注销、`clear()`。
- `policy.test.ts`：`needsApproval("tab_close", …)` 三档、`isSandboxWrite("tab_close")`、跨 workspace 文案。
- `main.test.ts`：注册条件（有服务端 / 无服务端 / 无 `HERDR_*` 仍注册）；pre-execute 网关四例（只读 deny / 跨 workspace deny / 本 workspace 登记 allow / 缺 `tab_id` 放行交动作层）；`execute` 透传 `exec`；无调用者 pane 时护栏不生效。
- `tool.test.ts`：枚举含 3 个新动作且不含任何 workspace 动作、描述含「workspace 内部绑定」与 `create` 落点、三个渲染分支与畸形值全函数性。

### 明确不做的部分

- 组（cwd ↔ group）概念与任何归组机制（用户裁定取消；herdr 也无此接口）。
- 工具面的 workspace 动作（create / list / get / close / focus / move）与 `workspace` 参数。
- `tab_focus` / `workspace_focus`（抢用户视图）；`tab_rename` / `tab_move` / worktree 面。
- 持久化绑定（不引入 `sessionPaths` / memory-base 依赖；复用靠 label 约定）。
- socket 侧 tab / workspace 方法；`security-guard` 登记变更；跨 machine / `--session` 目标；类型重命名。

### 估时

单线程约 2 天（会话绑定 + workspace 确保 + 三个 tab 动作 + `create` 重定向 + 可用性判定 + 门禁 + 单测 + README；真机验证另计一次人工跑）。

## 实现记录

（2026-10-21 实现，分支 `dsh/herdr-pane-tab`；按「规划 / 计划改动文件清单」逐项落地。）

01. **会话绑定**（新模块 `src/workspace.ts`）：`readSessionContext` 从宿主 `exec.agent.session` 读 `id` 与
    `header.cwd`（另收 `meta.cwd` / `cwd` / 直接传 session 三种形态；cwd 缺失回退 `process.cwd()`）；
    `shortSessionId` 取 id 末 8 位并滤非法字符；`workspaceLabel` = `<cwd 目录名>/<短标记>`（空白 / 斜杠归一
    为 `-`，截 80 字符）；`ensureWorkspace` 先查进程内缓存，再 `workspace list` 按 label 精确匹配复用，
    没有才 `workspace create --cwd <会话 cwd> --label <label> --no-focus`，并把建出的 root pane 登记为
    本插件 pane；`activePaneOf` 用 `workspace list` 的 `active_tab_id` + `pane list --workspace` 对齐，
    同 tab 内优先焦点 pane。失败一律返回 `workspace-unavailable` + 可操作提示，不抛错。
02. **工具入参面**：`HerdrPaneToolDef.execute(args, exec?)` → `dispatchAction(action, args, deps, exec?)`；
    `DispatchDeps` 增 `resolveSession`（缺省 `readSessionContext`，单测 / 真机脚本可注入固定会话）与
    `callerTabId`；`callerPaneId` 改为可选（不在 herdr 内时没有调用者上下文）。
03. **动作实现**：新增 `tab_create` / `tab_list` / `tab_close` 三个 handler（argv 走 CLI、回执走信封、
    登记 / 注销齐全）；`create` 改为 `pane split <本 workspace 活动 pane> --direction … --cwd <会话 cwd> --no-focus`（不再 `--current`）；`list` 去掉 `--workspace` 过滤与回执里的 `workspace_id`（决策项 6：
    模型看不到也传不进 workspace 面）；工具面动作枚举 10 → 13。
04. **登记表**（`src/registry.ts`）：`WorkspaceBinding` 单例缓存（`workspaceBinding` / `setWorkspaceBinding`）、
    `TabRecord` 登记面（`tabs` / `tab` / `registerTab` / `unregisterTab` / `unregisterTabByRootPane`）；
    `close` 掉 tab 的 root pane 时同步注销该 tab；`clear()` 连绑定与 tab 一起清；新增 `tabCloseArgs` /
    `workspaceCloseArgs`（argv 同源）。
05. **门禁**（`src/policy.ts` + `main.ts` 的 `tools/pre-execute`）：`tab_close` 计入审批集合（`needsApproval`）
    与沙箱写集合（`isSandboxWrite` / `SANDBOX_WRITE_ACTIONS`）；pre-execute 网关按 `tab_id` 解析登记与
    workspace 归属——跨本会话 workspace 一律 `deny`、调用者所在 tab（`HERDR_TAB_ID`）`deny`、未登记 tab
    按 `foreign` 档 `ask`（动作层再给 `tab-not-registered` + 放行方式）；缺 `tab_id` 放行交动作层。
    沙箱拒绝文案按目标类型给「目标 pane / 目标 tab」。
06. **生命周期**：`createExitCleanup` 关完登记 pane 后，对本会话 workspace 做一次 `pane list --workspace`；
    列表为空（说明里面的 pane 全是本插件的且已关闭）才内部 `workspace close`，列不出来或还有别人的 pane
    就不动（宁可留空壳也不误伤）。同步执行面抽成可注入的 `SyncRunner`，单测据此断言 argv。
07. **可用性判定**（`src/cli.ts` + `src/main.ts`）：`readHerdrHandshake` 改为「二进制可解析即握手」，
    `HERDR_ENV` 不再参与，`HERDR_SOCKET_PATH` / `HERDR_PANE_ID` / `HERDR_TAB_ID` / `HERDR_WORKSPACE_ID`
    全部可选；新增 `probeHerdrServerSync`（`herdr status --json` → `server.status === "running"`，顺便带回
    `server.socket`；探活超时按 3s 封顶）；socket 路径顺序 = `HERDR_SOCKET_PATH` → 探活 socket →
    `$XDG_CONFIG_HOME/herdr/herdr.sock`（`defaultHerdrSocketPath`）。探活失败 / 抛错只记一行日志、不注册。
08. **测试**：新增 `tests/workspace.test.ts`；`tests/helpers.ts` 增有状态 `fakeHerdr`（workspace / tab / pane
    三层按真机信封回）+ `fakeExec` / `fakeSession`；`actions` / `registry` / `policy` / `main` / `tool` /
    `cli` / `socket` 全部按新口径更新与补例。
09. **真机脚本**（`scripts/verify-herdr-pane.mjs`）：注入合成会话（`--session-id` / `--cwd`），用 CLI 只读
    核对 create 落点；新增 `--with-tab`（tab_create → tab_list → run → wait → read → tab_close）、
    `--check-cascade`（关掉 workspace 最后一个 pane 后看 workspace 是否还在）；开跑前按 label 报「复用 /
    新建」。修掉 `--keep` 的旧缺陷（原来 dispose 仍会按 `closeOnExit` 关掉现场，现在保留时置 false）。
10. **文档**：`README.md` 能力表 / `create` 行为差异 / 归属与生命周期 / 降级口径 / 安全边界 / 库面 /
    测试与验证 / 已知边界全部按 13 动作与「workspace 内部绑定」重写。

## 偏差

01. **探活用 `herdr status --json` 而不是 `tab list`**：决策项 10 允许二者其一；status 同时给出
    `server.socket`（自定义 socket 部署不必再猜路径），且是纯本地只读查询，故取它。
02. **探活超时按 3s 封顶**（`min(timeoutMs, 3000)`）：`apply` 是同步调用，不能把宿主启动拖到 10s。
03. **`tab_create` 取不到 `root_pane` 时仍登记 tab**：设计只写「回执缺 root_pane 的失败」；实现按失败返回，
    但先把 tab 记进登记表（`rootPaneId` 可选），使模型还能用 `tab_close` 收尾——否则会漏一个无人认领的 tab。
04. **`create` 回执新增 `split_from`**：模型排障要知道切的是哪个 pane（回执仍不含 workspace 面）。
05. **退出清理的 workspace 判定用「关闭后 pane list 为空」**：等价于「workspace 内全部 pane 都是本插件的且
    已关闭」，但少一次前置列举；列不出来（服务端已退）时不动 workspace。
06. **未登记 tab 在审批门走 `ask` 而不是 `deny`**：沿用既有口径「审批门只决定要不要打断人，归属拒绝由动作层
    给结构化回执 + 放行方式」；跨 workspace 与调用者 tab 是硬拒，不回退到审批。
07. **`list` 回执不再带 `workspace_id`**：决策项 6 的「模型看不到 workspace id / 名字」按严格口径落；
    排障改用 `herdr workspace list` 与 label 约定。
08. **pre-execute 的 `session` 未参与 tab 判定**：绑定是进程内单例（决策项 7 的「子会话沿用同一 workspace」），
    故跨 workspace 判定只看登记表与绑定，不依赖会话对象；tab 动作的会话缺失只在动作层判
    （`tab_close` 不需要会话）。
09. **`--keep` 语义修复**（真机脚本，计划外的小修）：旧脚本打印「保留 pane」后仍会在 `dispose()` 里按
    `closeOnExit` 关掉它；现在保留时把 `closeOnExit` 置 false，让开关与行为一致。
10. **BACKLOG 条目未移出、追踪文档未归档**：按仓库流程，这两步属「任务关闭」环节（需用户确认），留给主会话。

## 测试与证据

```text
$ npm --prefix herdr-pane run check
> tsc -p tsconfig.json --noEmit
（无输出，exit 0）

$ npm --prefix herdr-pane run test
ℹ tests 152
ℹ pass 152
ℹ fail 0
（九个用例文件：cli / socket / net / actions / registry / workspace / policy / main / tool）

$ npm --prefix herdr-pane run build
> tsc -p tsconfig.json
（无输出，exit 0）
```

真机验证（`scripts/verify-herdr-pane.mjs` 的 `--with-tab` / `--check-cascade` / `--session-id` 路径）
按当时的任务要求**未在实现分支跑**（会改用户 herdr 布局）。实现完成后由主分支合并后执行真机复测，
结论如下：

- **通过**：workspace label 含斜杠被服务端接受（实测建成 `dsh-toolset/mvikr2hz`）；关掉 tab 的最后一个
  pane 会**级联关 tab**（tab 从 `tab list` 消失）；退出清理把空 workspace 关掉且无残留；
  `pane close` / `tab close` / `workspace close` / `pane split` 均返回 JSON 回执。
- **发现缺陷（与本任务的 tab / workspace 改动无关，属既有缺陷）**：`herdr pane send-text` /
  `send-keys` / `run` 成功时 stdout 与 stderr **都为空**（exit 0）；`parseEnvelope` 把「无输出」判成
  `unparsed` → `dispatchAction` 回 `herdr-cli-error: herdr CLI 失败（exit 0）：（无输出）`，导致
  `send_text` / `send_keys` / `run` 在真机全部不可用，真机脚本 FAIL 在 `send_text`。单测的假信封
  （自带 `{"result":…}`）掩盖了这类静默成功。
- **修法（2026-10-21 补丁）**：`parseEnvelope(stdout, stderr, exitCode?)` 增可选退出码——**exit 0 且
  两侧都没有任何输出**时归一为 `{kind:"ok", result:{}}`；错误信封仍优先，非零退出 / 有输出但解析不出
  JSON / 不知道退出码（socket）时语义不变。`actions.ts` / `workspace.ts` / `registry.ts` 与真机脚本的
  全部 CLI 调用点都传入退出码（socket 读通道不传）。
- **补单测**：`cli`（exit 0 + 空输出 → ok 空 result；exit 1 / 无退出码 / 非 JSON 噪声 / 错误信封各保持
  原语义）、`actions`（`send_text` / `send_keys` / `run` 静默成功且回执字段正确；exit 1 + 空输出仍失败）、
  `workspace`（`workspace list` 静默成功按空列表处理并新建 workspace）。真机写操作按要求未重跑。

已做的真机只读核对：`herdr status --json`（探活返回
`{ok:true, socketPath:"/home/guochang/.config/herdr/herdr.sock"}`）、`herdr workspace list` /
`tab list` / `pane list` 的回执形状（与调研 02 一致）、`herdr tab create --help` / `pane split --help`
/`workspace create --help` 的参数面。

未验证项（本次补丁后未重跑真机写链路）：

- 补丁后的 `send_text` / `send_keys` / `run` 在真机上是否恢复（单测已覆盖 exit 0 空输出，真机待复跑
  `scripts/verify-herdr-pane.mjs`）；
- `tab create` 回执的 `.result.tab` / `.result.root_pane` 与 `workspace create` 的 `.result.root_pane`
  已由真机 tab / workspace 链路的通过结论间接确认，但未逐字段断言；
- 退出清理「用户后来在 workspace 里开的 pane 会阻止内部关 workspace」这一保护分支未在真机构造验证。

## 收尾

待用户确认后：BACKLOG 条目移出、本文件移入 `docs/archived/`、STATUS 由用户择时更新。
