# 接入官方 Agent Teams（team）（接取条目：`docs/BACKLOG.md`「接入官方 Agent Teams（team）」）

状态：规划　　开启：2026-11-16　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

让官方 Agent Teams（rc.3 起随 `dsh-base` 自动挂载、但 Team mode 缺省关）在本仓「开箱即用」：

1. 配置开关：`agent-team` 行 `config.defaultEnabled: true`（默认开启——用户 2026-11-16 裁定：打开配置开关、保持默认开启、不提供关闭、TUI 不提供切换）。
2. TUI 标题行状态指示：Team 状态符号**常驻显示、按查询到的状态切换颜色**（生效绿 / 未生效灰），只读、懒读 `ctx.agentTeams.isEnabled(root)`。
3. 工具面接线：让 `team_task_*` 穿过两道既有包装/揭示层——`tool-consult` 按普通工具对待（`plainWhenTools` 条件豁免 + shadow + 咨询揭示）+ `security-guard` 工具注册表登记/核对。

不开运行期切换（无 TUI slash 命令、不提供关闭入口），因此无「开关一次全树缓存失效」的反复成本；缓存效应只在配置层面一次性发生。

## 调研

来源：官方源码 `packages/team/agent-team` / `tool-agent-team`（clone `~/GithubRepos/deepseek-harness`，rc.3 tag 口径）、`docs/host/HOST-UPGRADE-0.2.2-rc.3.md`、本仓 `tool-consult` / `security-guard` / `TUI` 既有实现与 `ARCHITECTURE-REUSE.md`。

### 宿主侧事实（rc.3，已实测/核对）

- `agent-team`（`ctx.agentTeams` 服务 + 持久任务板）与 `tool-agent-team`（`team_task_*` 4 工具：`team_task_create` / `team_task_list` / `team_task_get` / `team_task_update`）已随 `dsh-base` 新增行自动挂载（官方活跃 100 → 102，2026-11-16 dump 实测；base `cordis.patch.yml:366-372`）。
- Team mode 缺省关：`agent-team` 行 `config.defaultEnabled` 缺省 `false`（`agent-team/src/index.ts:51`）。`defaultEnabled: true` 让**没有既有选择的新根会话**（含普通 fork）首步前保存 `team/mode` 为开启；既有选择优先、resume 不应用默认。
- 工具 when 条件：4 个 `team_task_*` 均带 `when: ({agent}) => enabled(agent)`，`enabled` 内调 `ctx.agentTeams.isEnabled(agent)`（`tool-agent-team/src/index.ts:105,141,182,201,234`）。mode 关 → 工具不在面。
- 提示段：`team:policy` 在 prompt assembly 时按 root 选择求值（README:96「Policy text is evaluated during prompt assembly」）；mode 关 → 段落不注入。
- 缓存：`team:policy` 段和 4 个工具 schema 都在请求前缀内。README KV Cache 节只写「装卸插件失效」；机制上 mode 切换与装卸等效（段有无 + 工具面变化）。用户裁定不提供切换 → 无反复失效。

### 本仓侧现状

- `tool-consult`：条件工具白名单 `DEFAULT_ALLOWED_WHEN_TOOLS = ["web_search", "web_fetch"]`（`tool-consult/src/config.ts:77-80`）。白名单外条件工具静态 deny、从模型面彻底移除。测试夹具已用 `team_task_list` 作条件工具样例（`tests/degrade.test.ts` / `tests/integration/plugin.test.ts` 多处）。`allowedWhenTools` 可在 profile/bundle 层配置覆盖。
- `security-guard`：工具注册表（`src/tool-registry.ts`）——rc.3 升级文档 §10 #3 已列 `wait_agent` / `office_*` / `user_terminal_*` 未登记为覆盖缺口；`team_task_*` 同批转正，需核对是否在登记表、未在则补。
- `TUI`：标题行符号区已有 plan 段位四态着色（灰/青/黄/绿）、daemon / group / flow 块先例；状态数据懒读服务面随状态行 ticker 保鲜（如 plan-stage / cache 段）。`ARCHITECTURE-REUSE.md` §0 `agent-group` 行把 `experimental-agent-team` 记为「未挂, 实验」——措辞待本条目随改。

## 决策

> 定稿（2026-11-16）：D1-D3 为用户裁定; D4、D7 沿用户「只读指示 / 常驻切色」裁定; D5-D8 由用户「其他的按照推荐方案」确认推荐项。

| 决策项 | 说明 | 备选方案 | 推荐 | 选定 |
| --- | --- | --- | --- | --- |
| D1 `defaultEnabled` 默认开还是关 | `agent-team` 行 `config.defaultEnabled` 决定新根（无既有选择）首步是否自动进 Team mode；缺省 `false` = 装好不开门 | a. `defaultEnabled: true`（配置打开、默认开启）; b. 保留缺省 `false`（用户按需开） | **a**（用户 2026-11-16 已裁定「打开配置开关、保持默认开启」） | a |
| D2 TUI 是否提供运行期切换 | 开关一次 = 全树请求前缀失效（`team:policy` 段有无 + 4 工具 when 进出面两处）; 官方只有 `setEnabled`（root 限定）无只读检查捷径 | a. `/team on\|off\|status` slash 命令; b. 不提供切换、不提供关闭入口 | **b**（用户已裁定「TUI 不提供切换、不许关闭」; 避免反复缓存失效） | b |
| D3 状态符号呈现 | 标题行符号区的 Team 指示要「常驻显示、按状态切色」还是「条件出现」 | a. 仅生效时显示符号; b. **常驻显示 + 按查询到的状态切换颜色**（生效绿 / 未生效灰） | **b**（用户已裁定; 延续 plan 段位四态着色惯例） | b |
| D4 状态数据源 | TUI 需读「当前 root 的 Team 是否生效」— `ctx.agentTeams.isEnabled(root)` 是官方只读面; 需先经 `agents` 服务解析 root（`parentSession` 为空者） | a. 懒读 `ctx.agentTeams.isEnabled(root)`（root 经 `agents` 服务解析, 同 herdr 修复根判定口径）; b. 直接读当前会话的 `isEnabled`（错误: 非 root 会误报） | **a**（只读服务面、无需 import 宿主; 服务缺/非 root 按未生效 fail-close 到灰） | a |
| D5 tool-consult 放行方式 | `team_task_*` 是条件工具（`when` 在册）; tool-consult 判定「条件工具」= `tools.executable(name)===undefined`（`core/tools/src/index.ts:254`: 带 `when` 的注册在无 toolSet 调用时返回 undefined）。白名单外条件工具 → `denied` → `restrict({deny})` 静态隐藏（`tool-consult/src/index.ts:539-554`），且初始集里指到也会被剔除（`computeInitial:570-578`）; 白名单内 → 不 deny、不 shadow、不进 managed = **纯宿主原生**（`installShadows:597` 跳过 conditional; `attachListeners:480` 只拦 managed）→ mode 开时 step admission 带完整定义进面, 关时不在面。 | **b（用户 2026-11-16 后续改为「按普通非初始工具对待」, 即下文 D5 修订）**: 白名单放行只是「不藏、交给宿主 when」; 用户最终裁定把这 6 个工具（`team_task_*` ×4 + `web_search` / `web_fetch` ×2）**统一按普通非初始工具对待**——见下方「D5 修订」 | ~~b~~ 修订为下 |
| D5 修订（2026-11-16 用户裁定） | 用户要求「把 team_task\_\* 连带 web\_\* 的两个, 改成按照正常的挂载的工具对待」——即不走条件工具通道, 与其它普通工具一样 inc: shadow 短说明 + `consult_tools` 咨询揭示。**机制**: tool-consult 新增配置 `plainWhenTools`（条件豁免名单）——`computeDenied` 判定条件工具时, 名单内的工具**不当条件工具**（即使 `executable===undefined`）, 从而: 不进 `denied`、不因 conditional 被 `installShadows` 跳过 → 走普通工具 shadow 路径（非初始则收短 + 进 managed + pre-execute 未揭示拒绝 + 咨询揭示放行）。同时 `web_search` / `web_fetch` 从 `initialTools` 移出（否则作为初始保留完整定义、不走 shadow）。宿主 `when` 对本仓部署恒真（team_mode 恒开、web provider 就绪）, 故「当不带 when 处理」成立; shadow 重注册不带 when = 工具恒在面（短说明）, 语义上与普通工具一致。 | a 条件工具白名单放行（保留宿主完整定义 + when 控可见）; **b 条件豁免名单 + 按普通工具 shadow/揭示（选定）** | **b（用户 2026-11-16 裁定「改成按照正常的挂载的工具对待」, 并在问答中选「B 普通非初始工具: 短说明 + 咨询揭示」）** | b |
| D6 security-guard 是否登记 | `team_task_*` 参数面是否含 watched 键（路径/命令/代码）→ 决定「未登记工具启发式」是否命中 | a. 补登 `PLUGIN_COMMAND_TOOLS` / 路径表; b. **核对不命中、不登记** | **b**（已实测 4 工具参数面: `subject`/`description`/`blocked_by`/`write_scopes`/`task_id`/`expected_revision`/`action`/`owner`/`status`/`unowned`/`ready`/`cursor`/`limit` — 无 `command`/`path`/`script`/`code` watched 键; `write_scopes` 只是 advisory 提示、不执行 → 未登记启发式天然放行） | b |
| D7 状态符号选型与位置 | TUI 标题行工作流组（plan / flow-track）现居最右、与其余组 `•` 分隔; Team 符号归属哪组、用哪个字形 | a. 放工作流组（plan / flow-track / team）; b. 放环境/行为组 | **a**（team 属流程/协作面, 与 plan / flow-track 同组最右; 字形由用户裁定, 位置沿用工作流组惯例） | a（字形 2026-11-16 定: `fa-group` U+F0C0, 生效绿 / 未生效灰同字符切色） |
| D8 fff 用户 patch 是否同步 | 仓库模板 `profiles/example` 改后, 本机 `~/.dsh/profiles/fff` 是否一起改 | a. 只改仓库模板（fff 由用户侧 `--sync`/手动）; b. 同时改本机 fff patch | **a**（按项目惯例 profile 实机改动须用户授权; 本条目产物给 example 模板, fff 同步留用户） | a |

## 规划

### 总体规划（决策 → 落点）

决策的产物分布: 在 **仓库模板**（D1 配置）、**tool-consult**（D5 放行）、**security-guard**（D6 核对）、**TUI**（D3/D4/D7 指示）、**宿主面文档**（D8/D4 依据）五处落地。依赖链: T1(配置) → T2(工具面) → T4(文档) 无相互依赖、可独立完成; T3(TUI) 依赖 `getAgentTeams` 接线, 与 T1/T2 互不阻塞。

| 决策 | 落点组件 | 产物 |
| --- | --- | --- |
| D1 默认开 + D8 只改模板 | `profiles/example/cordis.patch.yml` | `agent-team` 行加 `config.defaultEnabled: true` |
| D5 按普通工具对待 | `tool-consult` | `plainWhenTools` 机制 + 6 工具走 shadow/揭示 |
| D6 不登记 | `security-guard` | 只核对, 不改代码（无产物） |
| D3 常驻切色 + D4 懒读 root + D7 fa-group | `TUI` | `teamEnabled` 状态 + 标题行工作流组符号 |
| D4 root 判定 / D5 already | 追踪文档 | 依据与措辞落盘 |

### 执行顺序（含已完成标记）

1. **T2 工具面接线** — 已完成（T2a 已提交 `5afca691`; T2b 核对完成, 无改动）。
2. **T1 配置开关** — 已完成（`profiles/example/cordis.patch.yml`, 未提交）。
3. **T3 TUI 标题行状态符号** — 进行中（状态层已落, 接线待续）。子步骤与依赖:
   - T3a 状态模型: `teamEnabled` 字段 + `team-enabled` action + reducer + 初始值（已完成）
   - T3b 服务读取口: `AgentTeamsLike` + `AppDeps.getAgentTeams`（已完成声明; `main.ts` 实现与接线待续, 用 `rawAgent` 直调 `ctx.get("agentTeams")?.isEnabled(rawAgent)`——TUI 会话即 root, 免 root 解析）
   - T3c ticker 保鲜: `wiring.ts` 加 `maybeRefreshTeam`, 随 StatusTicker 懒读（待续）
   - T3d 渲染: `title-bar.ts` 加 `TITLE_ICON.team = "\u{F0C0}"` + 工作流组追加 team（恒显, 生效绿 / 未生效灰）（待续）
   - T3e 测试: 两态着色 + 未挂载/未读到回落 + 工作流组顺序断言; 冻结基线更新（待续）
4. **T4 文档回写** — 未做: `ARCHITECTURE-REUSE.md` §0 `agent-group` 行措辞（「未挂, 实验」→「已挂载, 转正, 默认开」）; `HOST-PACKAGES.md` 按需（§2 行清单仍 rc.1 批为主, rc.3 增量注记已覆盖, 通常无需再改）; `tool-consult/README.md`、根 `README.md` / `README.zh.md` 已在 T2a 同步。

### 各任务验收

- **T1**: `profiles/example/cordis.patch.yml` 含 `- id: agent-team` + `config.defaultEnabled: true`; 注释说明裁定; 不写 name（避免整条跳过）; 语法校验通过。
- **T2a**: tool-consult check/build/test（100 单测 + 11 集成）全绿; 集成用例验证 web/team 工具 shadow→揭示→放行链路。
- **T2b**: security-guard 零改动; 参数面核对记录在实现记录。
- **T3**: TUI build/test 全绿（含新增两态 + 回落用例）; `getAgentTeams` 未挂载/抛错时 `teamEnabled` 保持 undefined → 标题栏按灰; 全仓 check/build/test 通过; 真机（若可行）确认标题行工作流组出现 fa-group 符号并随状态变色。
- **T4**: `ARCHITECTURE-REUSE.md` 措辞更新; check:docs 通过。

### 提交点（按 WORKFLOW-STANDARD §5）

- 决策完成提交点（已过）: 决策表 + 追踪文档/BACKLOG 期间未在决策点提交, 已并入实现后提交。
- **实现完成提交点**（T2a 已提交; T1/T3 完成后）: 代码 + 测试 + 对应 README —— T1 一处（配置）, T3 一处（TUI）。
- **任务关闭提交点**（T4 后）: 剩余全部（追踪文档归档、BACKLOG 条目清理、ARCHITECTURE-REUSE 回写、临时脚本清理（`tmp/nerd-symbols.mjs` 按需保留或删））。

### 计划改动文件清单

- `profiles/example/cordis.patch.yml`（T1, 已完成）
- `tool-consult/`：`src/config.ts`、`src/index.ts`、`cordis.patch.yml`、`README.md`、`tests/`（T2a, 已提交）
- `security-guard/`：无改动（T2b, 已核对）
- `TUI/`：`src/app/state/{types,actions,reducer-view,initial}.ts`（T3a 已完成）、`src/app/app-deps.ts`（T3b 部分）、`src/main.ts`（T3b 待接线）、`src/app/runtime/wiring.ts`（T3c）、`src/app/layout/title-bar.ts`（T3d）、`tests/`（T3e）
- `docs/ARCHITECTURE-REUSE.md`（T4）
- 本追踪文档 `docs/implementation/2026-11-16-agent-team-adoption.md`

### 明确不做

- 不做 TUI 切换 slash 命令、不提供任何关闭入口（用户裁定）。
- 不改官方 `agent-team` / `tool-agent-team`。
- 不接入任务板本身（`team_task_*` 的模型使用是宿主原生行为，本仓只做放行与指示）。
- 不更新 `docs/STATUS.md`（用户择时更新）。
- 不做 SSH / 远程相关扩展（用户「先不管了」）。

## 实现记录

- 2026-11-16（T2a 完成核心）:

  - `tool-consult/src/config.ts`: 新增 `Config.plainWhenTools` 与 `ResolvedConfig.plainWhenTools`; `DEFAULT_INITIAL_TOOLS` 14 → 12（去 `web_search` / `web_fetch`）; `DEFAULT_ALLOWED_WHEN_TOOLS` 置空; 新增 `DEFAULT_PLAIN_WHEN_TOOLS = ["web_search", "web_fetch"]`; `resolveConfig` 归一 `plainWhenTools`。
  - `tool-consult/src/index.ts`: `computeDenied` 对 `plain` 名单内的工具不做条件判定（不发 `conditional`），从而不被 deny / 不被 shadow 跳过 → 走普通工具路径（非初始 shadow + 咨询揭示）。
  - `tool-consult/cordis.patch.yml`: `initialTools` 去 web 两件; 删 `allowedWhenTools`; 新增 `plainWhenTools` 列 `team_task_*` 四件。
  - 测试: `config.test.ts`（缺省值 12 初始 + `plainWhenTools` 断言）; `main.test.ts`（初始 12、`plainWhenTools` shadow 断言改写白名单条件用例）; `shadow.test.ts`（web 两件进 shadow 顺序）; `tests/assemble.ts`（web 两件注解改条件豁免）; 新增集成用例「plainWhenTools: web 工具 shadow → 未揭示拒绝 → 咨询揭示 → 放行」。
  - README 双侧（`tool-consult/README.md`、根 `README.md` / `README.zh.md`）同步: 12 初始、`plainWhenTools` 说明、`allowedWhenTools` 缺省空。
  - 验证: `pnpm -C tool-consult run check` 通过; 单测 100 全绿; 集成 10 → 11 全绿。

- 2026-11-16（T2b 核对完成, D6 按推荐 b 确认）: `security-guard/src/tool-registry.ts` 读码核对——4 个 `team_task_*` 参数面无 `command` / `path` / `script` / `code` watched 键（`write_scopes` 仅 advisory 路径提示, 不执行也不作真实路径传递）→ 「未知工具启发式」天然不命中, **不登记**、不改代码; 待 T4 时在 `ARCHITECTURE-REUSE.md` / README 若有涉及记一笔。

- 2026-11-16（T1 完成）: `profiles/example/cordis.patch.yml` 按 id 覆盖 `agent-team` 行加 `config.defaultEnabled: true`（12 行, 含注释说明裁定与工具面放行关系; fff 实机同步留用户, D8）。

- 2026-11-16（D7 定稿 + 符号选型脚本）: 用户裁定状态符号 = **`fa-group`（U+F0C0, 与 `fa-users` 同码位别名）**, 生效绿 / 未生效灰用**同字符切色**（无空心版）; 位置 = 工作流组最右。选型辅助脚本 `tmp/nerd-symbols.mjs` 交付（在线拉官方 glyphnames.json 或 `--offline` 内嵌表, 并做本地字体验证; 44 个候选含群组/协作/管理/任务板四组, 全部在 MapleMono NF CN 中验证存在）。

- 2026-11-16（T3 进行中, 状态层已落, 接线待定）: TUI 状态模型已加 `teamEnabled`（`state/types.ts` 字段 + `state/active.ts`… 实际在 `actions.ts` / `reducer-view.ts` / `initial.ts`）; `app-deps.ts` 加 `AgentTeamsLike` + `getAgentTeams` 读取器; `main.ts` 已 import `AgentTeamsLike`。**尚未完成**: `main.ts` 的 `getAgentTeams` 实现与接线（用 `rawAgent` 即 TUI 根会话直接调 `ctx.get("agentTeams")?.isEnabled(rawAgent)`）、`wiring.ts` 的 `maybeRefreshTeam`（随 StatusTicker 懒读）、`title-bar.ts` 的 `TITLE_ICON.team`（U+F0C0）与工作流组追加渲染、对应测试。停止于此待用户确认后再继续。

- 待做: T3 余下部分（wiring / title-bar / 测试）; T4 文档回写。

## 偏差

无

## 测试与证据

（待补）

## 收尾

（待补：回写 `ARCHITECTURE-REUSE.md` / `HOST-PACKAGES.md`、归档、BACKLOG 条目清理）
