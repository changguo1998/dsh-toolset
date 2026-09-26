# 规则触发的自动注入：rule-engine 插件（BACKLOG: 项目级#42）

状态：关闭　　开启：2026-09-27　　关闭：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按设定规则（关键词 / 正则 / 内置谓词）检测模型输出与事件流，命中后**代替用户**向下一个回合注入一条 user-role 消息（如检测到非推荐符号即发更正要求、检测到越界操作即发约束提醒）。

落地形态：**新建独立插件 `rule-engine`**（跨包通用），不并入 TUI。

## 调研

来源：宿主官方源码 clone（`/home/guochang/GithubRepos/deepseek-harness`，`dsh-v0.1.7-rc.2`，commit `477b4f4205`，与已安装 `@deepseek-ai/dsh` 0.1.7-rc.2 同基线）、本机安装包、`docs/host/DSH-CTX-API.md`、本仓 TUI adapter 与既有插件源码。完整六问结论见 `tmp/rule-engine-handoff.md` §7-§8（临时文件，不作为引用来源）。关键事实：

1. **注入时序红线**：`session/event` 监听器在 `Session.append` 的**同步派发窗口**内执行（`entry.appending === true`），此刻 `followup()` → `inbox.splice` → 再次 append 撞重入保护抛错，异常被宿主 `logger.warn` 吞掉，现象为「消息不落盘」。**必须推迟到宏任务**。agent 作用域事件（`agent/status`、`agent/inbox/*`）不在该窗口，可同步调。
1. **注入正路**：`ctx.agents.get(sessionId): Agent | undefined` → `agent.followup(message)`（同步 void）→ `await ctx.sessions.flush(agent.session)` 确保落盘。消息构造需 `id` 非空、`content` 为数组、`source.kind` 非空，否则 append/resume 校验抛 `lacks an identified message`。
1. **事件两条线**：会话日志事件统一经 `ctx.on('session/event', (session, event) => …)`（`event.type` 判别、`event.data` 载荷）；逐 delta 正文只有 `agent/assistant-stream` 一条路，durable 侧 `assistant/message` 是压缩记录。
1. **`inject` 是硬依赖**：任一声明服务不可用 → 插件整体等待、不加载；可选依赖须走 `ctx.reflect.get(name, false)`。本包只用 `agents` + `sessions`（profile `fff` 两者都在）。
1. **`notice` 通道（推翻原假设）**：宿主**没有**「插件 → 人」的 notice 通道。`notice` 只有三义：消息 source 的 `form:'notice'` 呈现形式（+ 必填 `summary`，≤120 字符）、credentials 的 `notify()`、客户端 UI 组件。真正「问人」的 API 是 `ctx.userQuestions.ask()`（语义是提问、会暂停等人答）。TUI 私有 `DshEvent{type:'notice'}` 产生点全在 TUI 侧，插件够不到；且 dsh-toolset TUI 未实现 `form` 分支，`form:'notice'` 目前会渲染成普通用户消息块。
1. **配置与持久化**：`Config` 不导出运行时 schema 则宿主跳过校验、配置原样透传（本仓 11 个包沿用的松口径）；patch 的 `config` 段是**整行替换、非深合并**；状态目录惯例见 metric-loop（`{version, state}` 外壳 + tmp/rename 原子写 + 版本不符拒载）。

## 决策

| # | 维度 | 选项 → 选定 | 理由 |
|---|------|------------|------|
| D1 | 落地形态 | 并入 TUI / 新插件 → **新插件 `rule-engine`** | 跨包通用；贴 `<对象>-<角色>` 命名范式（同 task-engine） |
| D2 | 命名 | `rule-engine`（定稿）；落选 `followup-rules`（把宿主 API 写进包名）、`rule-trigger`（因果读反）、`reflex`（隐喻名）、`auto-reply`（语义指向客服自动应答、窄于多动作面） | 动作面可扩展，不与单一动作绑定 |
| D3 | 规则来源 | 插件配置（apply 的 Config 段）＋ 模型面工具族运行时增删改查；TUI `/rule` 命令面本期不做 | 先有可编程与可自服务两条路 |
| D4 | 匹配面 | **只做三类**：模型正文文本、工具调用与结果、回合边界 | 覆盖先例（符号纠正）与越界操作两类诉求 |
| D5 | 动作面 | 只做 `inject`（代替用户注入 user-role 消息，推迟一个宏任务）；`tag` / `abort` / `memory` 本期不做 | 后两者建议另开条目 |
| D6 | 呈现方式（U1） | ② 另开 TUI 条目 / ③ 改 `userQuestions.ask()` / **① 只做 inject，消息带 `source:{kind:'rule-engine', form:'notice', summary}` 元数据** | 宿主无「插件→人」通道；TUI 现状即「完全模拟用户输入」（默认行为），将来 TUI 支持 `form` 即自然变成一行提示，插件无需再改。TUI 渲染能力登记为 #46 |
| D7 | pre-step 路径（U2） | 也做 pre-step / **本期只用 `agent.followup`** | pre-step 语义是「下一 step 内注入」而非新回合，另开条目 #44 |
| D8 | 持久化范围（U3） | 只写状态目录 / 回写 profile 配置 / **配置为基线 + 运行时层叠加** | 配置只读、运行时改动落 `~/.dsh/rule-engine`，两层按 id 合并（运行时覆盖同 id 基线 + 记录被删基线 id），避免改写项目目录外的 profile 文件 |
| D9 | 真机验证（U4） | **不授权 → 本期只跑包内 check/build/test + demo** | 不触碰 `~/.dsh/profiles/fff` |
| D10 | 谓词档位（U5） | JS 表达式 / **keyword + regex + 少量内置谓词名** | 三档均可纯函数单测，无任意代码执行面 |
| D11 | 延迟机制 | 微任务 / **`setTimeout(…, 0)`** | 只有 TUI 的宏任务路径有真机实证；微任务留待实测 |
| D12 | 符号纠正迁移 | **不迁移**，TUI 侧改为消费者另开条目（#43） | 跨模块，本任务不改 `TUI/**` |
| D13 | 改文件范围（用户 2026-09-27 追加约束） | **只允许改 `rule-engine/**` 与根 `docs/**`** | 仓库级集成（根 `package.json` / `scripts/` / 根 `README.md` / `AGENTS.md`）本轮不做，登记为 #45 |

## 规划

### 计划改动文件清单

新增（`rule-engine/`，新包）：

| 文件 | 职责 |
|------|------|
| `package.json` | 包名 `@dsh-toolset/rule-engine`、`dsh.bundle.patch` 集成契约、check/build/test/demo 脚本 |
| `tsconfig.json` | 抄 task-engine / metric-loop 口径（strict + noUncheckedIndexedAccess + rewriteRelativeImportExtensions） |
| `cordis.patch.yml` | `- insert: [{id: rule-engine, name: '@dsh-toolset/rule-engine'}]` |
| `.gitignore` / `LICENSE` | 沿用现有包 |
| `index.ts` | 包入口（re-export `src/main.ts`） |
| `src/types.ts` | 规则 / 配置 / 状态类型 |
| `src/match.ts` | 纯匹配层：keyword / regex / 内置谓词；消息文本抽取 |
| `src/rules.ts` | 规则归一化 + 两层合并（config 基线 + 运行时层） |
| `src/persist.ts` | 运行时层状态目录持久化（原子写 + 版本拒载） |
| `src/engine.ts` | 编排：事件 → 聚合 → 匹配 → 节流去重 → 注入派发 |
| `src/inject.ts` | 注入动作：推迟宏任务 → `agents.get` → `followup` → `sessions.flush` |
| `src/tools.ts` | 工具族 `rule_add` / `rule_list` / `rule_update` / `rule_remove` / `rule_test` |
| `src/main.ts` | 插件入口：`name` / `inject` / `provide` / `Config` / `apply`（订阅 + 工具 + 只读服务） |
| `tests/match.test.ts`、`tests/rules.test.ts`、`tests/engine.test.ts`、`tests/persist.test.ts`、`tests/inject.test.ts`、`tests/main.test.ts` | 单测（`node --experimental-transform-types --test`）；`main.test.ts` 为计划外追加（端到端覆盖 apply 接线与真实注入器链路，见「实现记录」） |
| `demo/main.ts` | mock 事件流跑「规则命中 → 注入」，不依赖 DSH |
| `README.md`、`docs/DESIGN.md` | 模块契约与架构（新模块自管 `docs/`） |

修改（根 `docs/`）：

| 文件 | 改动 |
|------|------|
| `docs/BACKLOG.md` | #42 标「进行中」+ 落地形态定稿；追加 #43（TUI 符号纠正改消费者）、#44（pre-step 路径）、#45（仓库级集成）、#46（TUI 支持 `form:'notice'` 渲染） |
| `docs/implementation/2026-09-27-rule-engine.md` | 本追踪文档；关闭时移入 `docs/archived/` |

### 任务拆分

1. 包骨架与依赖安装 → 验证：`npm --prefix rule-engine run check`
1. 规则模型 + 匹配层 + 两层合并 → 验证：`tests/match.test.ts`、`tests/rules.test.ts`
1. 状态持久化 → 验证：`tests/persist.test.ts`
1. 事件订阅 + 引擎编排（聚合 / 节流 / 去重） → 验证：`tests/engine.test.ts`
1. 注入动作（推迟 + followup + flush） → 验证：`tests/inject.test.ts`
1. 工具族 + provide 只读面 → 验证：`check` + 工具层单测
1. demo（mock 事件流） → 验证：`npm --prefix rule-engine run demo` 输出命中与注入
1. 包文档（README / DESIGN） → 验证：与实现逐条对照

### 明确不做（防范围蔓延）

- 不改 `TUI/**`（符号纠正迁移 → #43；`form:'notice'` 渲染 → #46）
- 不改仓库级脚手架与根文档之外的根文件（根 `package.json`、`scripts/install.sh`、`scripts/test-parallel.sh`、根 `README.md`、`AGENTS.md` → #45）
- 不做真机验证（未授权 U4）；不碰 `~/.dsh/profiles/fff`
- 不做 `agent/pre-step` 注入路径（→ #44）、`tag` / `abort` / `memory` 三类动作、TUI `/rule` 命令面板
- 不用宿主 `ctx.storage` / `storageDomain` 重做持久化（需 profile 配必填 backend，过度设计）
- 不改 `docs/STATUS.md`（由用户择时更新）

## 实现记录

- 2026-09-27：读 handoff、确认工作区（worktree `.worktree/rule-engine`，分支 `feat/rule-engine`，基线 `874c77d`，干净）；用户裁定 U1-U5；`docs/BACKLOG.md` #42 标进行中 + 落地形态定稿 + 追加 #43-#46；本追踪文档建立。
- 2026-09-27：用户追加改文件范围约束（只改 `rule-engine/**` 与根 `docs/**`）→ 原计划 G1-G5 集成动作改为登记 #45。
- 2026-09-27：包骨架（`package.json` / `tsconfig.json` / `cordis.patch.yml` / `.gitignore` / `LICENSE` / `index.ts`）就位。依赖安装踩坑：沙箱下 `npm install` 默认缓存目录 `~/.npm` 只读（EROFS），改用工作区内缓存 `npm install --cache tmp/npm-cache` 成功（tmp/ 已被根 `.gitignore` 忽略）。
- 2026-09-27：实现 8 个源文件（`types` / `match` / `rules` / `persist` / `engine` / `inject` / `tools` / `main`），`npm run check` 通过。
- 2026-09-27：设计修正一处——原设计的 `oncePerTurn` 开关在「同一回合内同正文只注入一次」落地后成为冗余（同一规则同回合正文恒定，去重已覆盖），删除该字段（类型 / 归一化 / 工具参数 / 测试同步），节流面收敛为 `cooldownTurns` + `cooldownMs` + `maxInjectionsPerTurn` + 同回合去重。
- 2026-09-27：单测 5 个文件 49 条（匹配 / 规则层 / 持久化 / 引擎 / 注入器 / 插件入口端到端）全绿；`demo/main.ts` 跑通四条路径（正文命中 / 工具命中 / aborted 不注入 / 工具族增删改查 + 干跑）。
- 2026-09-27：包文档 `README.md`（契约 + 配置示例 + 已知限制）与 `docs/DESIGN.md`（架构 + 9 条设计取舍）落地；`format` 覆盖全部改动文件（YAML 按仓库例外手工保持）。

## 测试与证据

命令（worktree 根执行；包内脚本经 `--prefix`）：

1. `npm --prefix rule-engine run check` → `tsc -p tsconfig.json --noEmit`，**0 error**。
1. `npm --prefix rule-engine run build` → 产出 `dist/index.js`、`dist/src/*.js`、`dist/demo/main.js`（无告警）。
1. `npm --prefix rule-engine test` → `node --experimental-transform-types --test 'tests/*.test.ts'`：**tests 49 / pass 49 / fail 0**（约 110ms）。覆盖：
   - 匹配层（10 条）：关键词大小写、正则 + flags、非法正则降级、谓词与/或关系、空条件按匹配面区分、文本抽取、摘要截断；
   - 规则层（8 条）：归一化缺省与非法输入逐条报错、条件非法项丢弃、两层合并（覆盖 / 屏蔽 / 顺序 / 重复 id）；
   - 持久化（6 条）：round-trip、缺文件、损坏 JSON、版本不符拒载且拒写、形状异常、缺 state 段；
   - 引擎（15 条）：回合正文聚合、缓冲按回合隔离、aborted/error 不注入、工具事件即判、同回合去重、cooldownTurns / cooldownMs、每回合上限、enabled=false、干跑、CRUD + 落盘、跨实例生效、畸形事件、注入器抛错降级；
   - 注入器（6 条）：消息三项硬要求合规 + notice 元数据、同步阶段不调用宿主（红线）、宏任务后 followup + flush、会话非 live、宿主缺面、followup/flush 抛错；
   - 插件入口（3 条）：apply 接线（监听器 + 5 个工具 + `ruleEngine` 服务）、事件 → 注入全链路（含「同步窗口内不得 followup」断言）、缺面降级。
1. `npm --prefix rule-engine run demo`（build + `node dist/demo/main.js`）→ 关键输出：
   - 回合 1（正文含全角括号）：`注入[ascii-symbols] source=rule-engine/notice summary="符号规范提醒"` + `注入[turn-wrapup]`；
   - 回合 2（`rm -rf` 工具调用）：`注入[no-destructive-shell]` + `注入[turn-wrapup]`；
   - 回合 3（`turn/end reason=aborted`）：无注入；
   - `rule_test` 干跑：`{"ok":true,"source":"assistant-text","matched":["ascii-symbols"],"disabled":[]}`；
   - 工具族：`add` ok → `list` 显示 4 条（3 config + 1 runtime）→ `remove` ok。
1. 产物加载：`node -e "import('./dist/index.js')…"` → `entry ok: rule-engine ["agents","sessions"] ["ruleEngine"] exports=28`（bundle 契约三件套 + 28 个具名导出）。
1. `format`（`/home/guochang/fff/scripts/format`）覆盖全部改动的 TS / MD / JSON；`rule-engine/cordis.patch.yml` 按仓库例外（YAML）手工保持。
1. 残留检查：`git status --short` 仅 `docs/BACKLOG.md`（改）、`docs/implementation/`（新）、`rule-engine/`（新）；`rule-engine/tmp/npm-cache`（沙箱下 npm 缓存，31MB）与 `node_modules` / `dist` 均被 `.gitignore` 覆盖，缓存目录已在收尾时删除。

**未验证（受 U4 限制）**：真机（profile `fff` 挂载后 `dsh --profile fff` 实际注入落盘、TUI 渲染形态、新回合时序）。单测已用假 ctx 覆盖到 `apply` 接线与宏任务推迟，但宿主真实 `agents.get` / `followup` / `flush` 行为、`form:'notice'` 在 TUI 的渲染结果仍属推断（来源：handoff §8 调研）。

## 收尾

- 回写文档：新增 `rule-engine/README.md`（模块契约）、`rule-engine/docs/DESIGN.md`（架构与取舍）；根 `docs/BACKLOG.md` 仅改 #42 状态与追加 #43-#46。
- 未回写（本轮范围外，已登记 #45）：根 `README.md` 插件表/目录树/文档索引、`AGENTS.md`「12 个包」→ 13、根 `package.json`/`scripts/` 委托与安装清单。
- 遗留项：#43（TUI 符号纠正改消费者）、#44（pre-step 注入路径）、#45（仓库级集成）、#46（TUI 支持 `form:'notice'` 渲染）；另记已知限制于 `rule-engine/README.md`（节流记账为进程内内存态、逐 delta 实时匹配未实现）。
- 归档：本文件移入 `docs/archived/`（跨包条目归项目级），BACKLOG #42 标「完成」。
