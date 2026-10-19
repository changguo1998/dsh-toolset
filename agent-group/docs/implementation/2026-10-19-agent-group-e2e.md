# agent-group 真机联调全流程（接取条目：agent-group/docs/BACKLOG.md「真机联调未做（两个会话各挂本插件跑通全流程）」）

状态：实现　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

起两个真机会话（各挂 session-channel / session-paths / agent-group），一个建组并把另一个加为成员，跑通 `create_group → add_member → link → send → check → remove`；确认 `<会话目录>/agent-group.json` 真实落点且为 0600，memory-base 已挂时能按 `search({kind: "agent_group"})` 检索到镜像行；验收按条目：上述流程真机走通，回报正文与成因在 `check` 结果里正确出现。预期无代码改动，除非联调暴露问题。

## 调研

来源：本包源码通读（`src/main.ts` / `core.ts` / `transport.ts` / `store.ts` / `mirror.ts` / `model.ts`）、宿主 cordis 库级探针、`dsh --profile fff` 真机会话实测（2026-10-19 12:16 至 13:55）。

### 1. 本包现状（代码）

- 注册路径：`apply` 期读一次 `tools`，成功才 `tools.register(...)`，失败只 `logger.info` 后返回（`agent-group/src/main.ts:307-319`）。
- 服务读取：自定义 `readService` 先 `ctx.get(name)`，再回落 `ctx[name]`，异常吞掉（`main.ts:86-101`）；`sessionChannel` / `sessionPaths` 在**每次 execute** 时才解析（`main.ts:221-278`），本包不写 `inject`。
- 落盘：`<sessionDir>/agent-group.json`，临时文件 + `rename`，`mode 0o600` + `chmod 0600`（`store.ts:114-131`）；目录由 `sessionPaths.sessionDirFor` 推导，本包不建目录。
- 镜像：`registerKind({kind:"agent_group"})` + `remember({kind:"agent_group", source:{kind:"manual", label:"agent_group", ref:<组 id>}, project:<管理者会话 cwd>})`（`mirror.ts:37-86`）。
- 只有写状态的动作才落盘与镜像；`status` 只读、命中缓存不碰存储（`core.ts:573-595`）。

### 2. 宿主机制（cordis 4.0.5 库级探针）

探针脚本 `tmp/cordis-probe3.mjs`（工作区 `tmp/`，gitignored；实测后已删）：

- 服务在**根层** `provide`、插件未声明 `inject`：`ctx.get("tools")` 与 `ctx.tools` 都拿得到对象，`register` 可调用 —— 注册成功。
- 服务由**兄弟 fiber** `provide`、调用方未 `inject`：`ctx.get("tools")` 返回 `undefined`，`ctx.tools` 回落拿到字符串（无 `register`）—— 读不到。

结论：不写 `inject` 时，能否读到服务取决于「是不是根层提供，且在本包 `apply` 前就绪」。cordis 的 `inject` 另有一层语义：声明后本插件的**激活会被推迟到依赖就绪**，这正是各兄弟包（`fs-digest` / `hash-edit` / `task-engine` / `background-daemon` 等）普遍 `inject: ["tools"]` 的原因。

### 3. 真机现状（fff profile）

- 挂载：`~/.dsh/profiles/fff/package.json` 把 `@dsh-toolset/agent-group` link 到主仓 `/home/guochang/Projects/dsh-toolset/agent-group`；调研时主仓与本 worktree 的 `agent-group/src`、`docs` **逐文件 diff 为空**（`src` 至今仍为空；`docs` 随本任务改动），`dist/` 构建于 2026-10-18 16:31（晚于源码 mtime）。
- 传输侧就绪：`/run/user/1000/dsh-session-channel.sock` 存在；会话启动 stderr 有 `[session-channel] 已连接 unix:...（Redis 7.0.15）`；`peers` 列到 8 个在线会话。
- **工具缺失（关键）**：新起两个 `dsh --profile fff` 会话（`ui-cocoa-e5d7`、`ui-moose-cb50`，herdr pane 内），工具表里都没有 `agent_group`；被直接问到时 `ui-cocoa-e5d7` 自述「没有」。本会话（`tui-18b485d8`，同一 profile）也没有该工具。
- bundle 未被跳过：pane 内捕获的启动 stderr（`dsh --profile fff 2>...`）没有 `skipping profile bundle` 行；也没有 `[agent-group]` 警告 —— 该警告走 `ctx.logger(...).info`，无 exporter 时静默丢弃，故「无警告」不能当作「apply 正常」。
- 从未落盘：`find ~/.dsh/sessions -maxdepth 3 -name 'agent-group*.json'` 无结果 → 本机从未成功执行过写状态的动作。

### 4. 成因判断

- 已证实：`agent_group` 工具在本机任何 fff 会话里都没有注册上，联调无法从第一步开始。
- 高置信推断（两段同源）：① `apply` 期 `tools` 不可读（未 `inject`、且不是根层已就绪服务）→ 只 warn 后返回，工具从未注册；② 即使注册成功，`execute` 期读 `sessionChannel` / `sessionPaths`（都由兄弟 bundle 在自己 fiber `provide`）同样拿到 `undefined` → 动作会返回 `session_channel_unavailable` / `session_paths_unavailable`。
- 与既有裁定冲突：`README.md` / `main.ts` 注释里的「2026-10-17 真机裁定：去掉 `inject`，改注册期同步 + 执行期惰性解析」在当前宿主（0.2.0-rc.2 / cordis 4.0.5）不成立 —— 去掉 `inject` 同时失去了「等 `tools` 就绪再激活」这一保障，而惰性解析又拿不到兄弟 fiber 的服务。
- 已证实（修复后）：静态 `inject: ["tools"]` 恢复后经假宿主/单测验证「分叉优先、直读兜底」的两条读取路径（见「测试与证据」回归用例）。
- 未证实部分：`tools` 在真实宿主里究竟何时 `provide`、本包 `apply` 时 `ctx.get("tools")` 返回的是 `undefined` 还是字符串（探针两种都复现过，取决于提供位置）。要坐实需在包内临时插桩（属代码改动，本任务不做）。

### 5. 环境约束（影响联调执行与取证）

- 本会话的工具沙箱把 `/home` 挂成只读（`findmnt -T ~/.dsh`：`/dev/nvme0n1p4 ... ro`）→ 工具侧**不能写** `~/.dsh/profiles`、`~/.dsh/sessions`；读可以（`ls` / `find` / `stat` 正常）。
- herdr pane 里的进程不受该沙箱限制（pane 内可写 `~/.dsh`、可跑 `dsh`）；pane 与工具之间的文件交换要走工作区 `tmp/`（pane 的 `/tmp` 与本会话的 `/tmp` 不是同一个，实测 pane 写 `/tmp/ag-boot.err` 工具侧看不到）。
- `tmp/` 在 `.gitignore` 内（临时脚本与日志不污染仓库）。
- 临时 `DSH_HOME` 测试 profile 方案实测不通：复制 fff 到 `tmp/dshhome/profiles/fff` 后 `dsh --dump-config` 大量报 `patch: entry "<包名>" not found`（profile 的 bundle 列表未被识别为已初始化 profile）；正规初始化要 `--from-default-profile` + `pnpm` 安装，成本高。故联调走真实 fff profile。

## 决策

决策项 1　联调运行载体：a 复用现有在线会话　b 新起两个 `dsh --profile fff` 会话（herdr pane）　c 临时 `DSH_HOME` 测试 profile
→ 选定 **b**。理由：a 的会话都没有本包工具、且各有在办任务，注入群组指令会干扰；c 在 dump-config 阶段就暴露 profile 未初始化与 patch 基线缺失（见调研 §5），且需要 pnpm/网络，收益不抵成本。代价：fff link 主仓，联调验的是主仓构建产物（当前与本 worktree 源码 diff 为空，等价）；若后续需要验 worktree 改动，得先合回主仓 —— 属修复任务的事。

决策项 2　驱动方式：a 人工在 pane 里打字　b 本会话经 session-channel（`channel_delegate` / `session_channel send`）向管理者会话注入任务　c `herdr_pane run` 逐条打字
→ 选定 **b**。理由：注入有回执与任务记录（`task.id`），管理者的最终回答可回收入「测试与证据」；成员会话只需被动接 `TASK <id>` 注入并在轮末自动回传。c 只能看屏幕，取证弱。

决策项 3　验收取证口径：状态文件绝对路径 + `stat -c '%a %n'` 应为 `600`、JSON 内容（成员 / 连接 / 指令收场）、`check` 返回的 `settled[].status` / `result` / `cause`、`status` 的 `mirror` 计数、`memory_query({action:"search", kind:"agent_group"})` 命中行。
→ 选定该口径，证据原文摘入「测试与证据」。文件读取由工具侧直接读（`/home` 只读但可读）。

决策项 4　联调暴露的「工具从未注册」如何处置：a 本任务内做最小修复后再联调　b 登记新 BACKLOG 条目、本任务暂停等修复　c 临时 fork（复制包到 `tmp/` 改 `inject`）绕过验证
→ 选定 **a**（2026-10-19 用户裁定：本任务内做最小修复后再联调）。复验时机：修复未合主分支，真机联调顺延到用户合入主分支之后（见实现记录末条）。

决策项 5　收尾清理：联调会话用完即退出、pane 关闭；`tmp/` 下的探针脚本与日志删除；不在 `~/.dsh` 留测试组状态（联调产生的 `agent-group.json` 由管理者会话自己写，任务结束前删除并记录）。
→ 选定该项。

## 规划

（细化，2026-10-19；决策项 4 后续裁定为选项 a，下方分支 a 已执行，分支 b 不再需要。）

任务拆分（分支 b：修复另立条目）：

1. 在 `agent-group/docs/BACKLOG.md` 追加「工具未注册（无 inject，兄弟 bundle 服务读不到）」条目，附调研 §2、§3 的证据与建议方向（`inject: ["tools"]` + `ctx.inject` 分叉解析 `sessionChannel` / `sessionPaths`）。
2. 本追踪文档记「偏差：联调未能开始（阻塞于新条目）」，条目状态保持〔进行中〕，等修复任务完成后回到本任务继续。
3. 关停 pane / 会话，删 `tmp/` 诊断产物。

任务拆分（分支 a：本任务内修复后继续联调）：

1. 改 `agent-group/src/main.ts`：声明 `inject: ["tools"]`；`sessionChannel` / `sessionPaths` 改用 `ctx.inject([...], cb)` 分叉持有，工具定义仍在 `apply` 期注册。
2. 同步 `README.md` / `docs/DESIGN.md` 的「依赖与降级」与「与设计文档的偏差」两节；补/改 `tests/main.test.ts` 的假宿主用例（含服务晚到）。
3. `npm run check` / `build` / `test`（`agent-group/`），主仓构建后重启会话复测工具可见。
4. 按决策项 1 至 3 跑联调，取证入档。

计划改动文件清单（按分支）：

- 本追踪文档（两分支都改）
- `agent-group/docs/BACKLOG.md`：追加新条目（分支 b 必做；分支 a 也要先登记，关闭时再清理）
- 分支 a 追加：`agent-group/src/main.ts`、`agent-group/tests/main.test.ts`、`agent-group/README.md`、`agent-group/docs/DESIGN.md`
- 两会话的启动动作为 profile 侧手工操作，不落仓库

明确不做：不做二期能力（广播 / 平等连接 / TUI 入口 / 轮次）；不改协议版本；不改 `session-channel` / `session-paths` / `memory-base` 三个依赖包；不在主仓（`/home/guochang/Projects/dsh-toolset`）落改动。

## 实现记录

- 2026-10-19 12:16 至 12:55：读本包源码与 README / DESIGN；`diff -r` 确认主仓与本 worktree 的 `agent-group/{src,docs}` 一致；`session_channel peers` 列到 8 个在线会话；herdr 建 pane `wVJ:p2` 起 `dsh --profile fff`（会话 `ui-cocoa-e5d7`），经 `session_channel send` 问其工具表 → 答「没有 `agent_group`」。
- 12:55 至 13:30：建 pane `wVJ:p3` 起第二个 fff 会话（`ui-moose-cb50`），捕获启动 stderr 到 pane 侧 `/tmp/ag-boot.err` 再复制进工作区 `tmp/ag-boot.err`；无 `skipping profile bundle`、无 `[agent-group]` 行；确认 bundle 未跳过但工具仍缺。
- 13:30 至 13:55：写 cordis 库级探针（`tmp/cordis-probe.mjs` / `-2` / `-3`），复现「根层服务可读、兄弟 fiber 服务不可读」；`find ~/.dsh/sessions -name 'agent-group*.json'` 无结果；试验临时 `DSH_HOME` profile（`tmp/dshhome`）→ dump-config 报 patch 基线缺失，放弃该方案。
- 诊断产物（均在工作区 `tmp/`，gitignored，已删）：`ag-boot.err` / `cordis-probe*.mjs` / `dump-wt.{txt,err}` / `dshhome/`；pane `wVJ:p2`、`wVJ:p3` 已关闭。
- 14:00 至 14:10：在 `agent-group/docs/BACKLOG.md` 追加「工具从未注册（不写 inject，兄弟 bundle 的服务读不到）」条目（P0，引用本文件调研 §2 至 §4 作证据）；按用户指示先关掉测试窗口（pane `wVJ:p2` / `wVJ:p3` 已 close，测试会话 `ui-cocoa-e5d7` / `ui-moose-cb50` 已从 `peers` 消失），`tmp/` 诊断产物已删空。
- 15:00 至 15:40（实现）：按决策项 4 的选项 a 落地修复 —— `src/main.ts` 增加 `export const inject = ["tools"]`；新增 `GroupServiceBindings` / `bindOptionalServices` / `readInject`，`sessionChannel` / `sessionPaths` / `sessions` / `memory` 四个可选服务改走 `ctx.inject([...], cb)` 子分叉绑定（服务晚到自愈），`createLazyGroupService` 支持「分叉优先、`readService` 直读兜底」，`apply` 保持 apply 期同步注册。`tests/main.test.ts` 增三个回归用例（静态 `inject` 声明 / 真机形态分叉可用 / `ctx.inject` 抛错不冒泡），并修正原「不写 inject」口径的注释。`npm run check` / `npm run test` / `npm run build` 全绿（43 用例通过）。依赖安装：worktree 无 node_modules，临时 `agent-group/node_modules` 符号链接到主仓同包（gitignored，不落提交）。
- 15:40 至 16:30（尝试真机复验，均未成功）：① `--patch` + `NODE_PATH` 挂 worktree 构建（`agent-group-wt` 别名）→ composed config 含该行，但 `apply` 未执行（dsh 的 bundle 解析走 ESM，不认 `NODE_PATH`）；② 临时 `DSH_HOME`（`tmp/home`）profile：node_modules 用符号链接重建、`agent-group` 指向 worktree 后 `--dump-config` 零 skip，但新起 idle 会话（manager / member）在启动后进程退出、pane 自动关闭，未落原因。两项均已撤。
- 16:40 至 16:50（用户裁定）：用户明确 —— 当前只做代码修改，新起的代理会话加载的是**主分支**构建，修复未合并前真机验证无意义；完成修改后提交，由用户合并到主分支后再复验。故真机联调调整到合主之后。

## 偏差

- 联调**未开始**（本期）：阻塞于「`agent_group` 工具从未注册」。与追踪文档「预期无代码改动、按流程跑通」的差异由此产生；处置按决策项 4 选定 **a**（本任务内修复）。
- 真机复验（决策项 1 至 3 的完整流程）**未执行**：修复未合入主分支，新起会话加载旧构建。用户已裁定合主后复验（见实现记录末条）；本追踪文档的「测试与证据」只含单测与已有环境证据。
- 临时 `DSH_HOME` 复验方案的两个会话启动后自动退出、pane 关闭，未定位原因即按用户裁定放弃，未再投入。
- 调研 §4 的成因已由修复坐实一半：未声明 `inject` 段（库级探针 + 真机工具缺失 + 修复后回归用例）。「修复生效」本身待合主后真机确认。
- 文档口径更新：`README.md` / `docs/DESIGN.md` 中「2026-10-17 真机裁定：不写 inject」已改写为 2026-10-19 修正口径（DESIGN §8 旧行划线标注取代）。

## 测试与证据

（真机联调待合主后补；本任务已完成的验证如下。）

代码侧（`agent-group/`，2026-10-19）：

- `npm run check` → 通过（src + tests 双 tsc --noEmit）。
- `npm run test` → 43 / 43 通过，含新增回归用例：
  - 「静态 inject 声明 tools（不声明时真机工具永远进不了工具表）」—— `assert.deepEqual(inject, ["tools"])`；
  - 「真机形态：兄弟 bundle 的服务直读不到时，经 ctx.inject 分叉仍可用」—— 直读 `get` 全返 `undefined`，`ctx.inject` 子分叉给到 `sessionChannel` / `sessionPaths` / `sessions` / `memory`，apply 后建组 / 加成员 / 落盘 0600 / 镜像 kind 全通过；
  - 「宿主 ctx.inject 抛错：apply 不冒泡，工具照常注册」。
- `npm run build` → 通过（dist 产出；仅存于 worktree，未部署）。

真机侧（既有环境证据，摘录见上）：

- 修复前：两个新起 fff 会话工具表无 `agent_group`（会话自述「没有」）；`~/.dsh/sessions` 无 `agent-group.json`。
- 复验安排：合主后由用户或后续回合按决策项 1 至 3 执行，结果回填本文件「测试与证据」。

## 收尾

- BACKLOG：新登记的「工具从未注册（不写 inject，兄弟 bundle 的服务读不到）」已随本任务修复完成，**已从 `agent-group/docs/BACKLOG.md` 移除**（只留未完成项）；「真机联调未做（两个会话各挂本插件跑通全流程）」仍〔进行中〕，合主后复验即关闭。
- 文档回写：`README.md`「依赖与降级」与 `docs/DESIGN.md` §7 / §8 已同步 2026-10-19 修正口径；追踪文档补全实现记录 / 偏差 / 测试与证据。
- 清理：`tmp/` 下 cordis 探针、overlay、临时 DSH_HOME、启动 stderr 等诊断产物已删；测试 pane 全部关闭；`agent-group/node_modules` 符号链接保留（gitignored，供后续 check / test）。
- 提交：本次改动（`src/main.ts`、`tests/main.test.ts`、`README.md`、`docs/DESIGN.md`、`docs/BACKLOG.md`、本追踪文档）已提交，见 git 记录；提交信息引用本文件路径。
- 遗留：真机复验（合主后）；临时 DSH_HOME 会话退出原因未深究（不影响交付）。
