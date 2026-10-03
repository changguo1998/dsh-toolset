# profile 挂载面扩张（接取条目：`docs/BACKLOG.md`「profile 挂载面扩张（排除客户端 UI / Web / 运维面 / 实验编排）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按用户 2026-10-02 裁定「profile 尽量挂载所有官方包，web / 客户端这类不用挂载」，把 fff profile 的挂载面从「base + 本仓 18 包」扩到「base + 本仓 18 包 + 可挂的官方行」，并产出**实测校正过**的挂载清单。分四步：① 挂载状态实测（只读）→ ② 候批 → ③ 排除项 → ④ 落 profile（备份 + 征得同意）→ 重启 → 健康检查 → 可回滚。

## 调研（2026-10-02，全部只读）

### 步骤① 挂载状态实测（已完成）

数据源：`dsh --profile fff --dump-config`（宿主 0.2.0-rc.2，850 行，退出 0、stderr 空）→ `tmp/hostdoc-020/dump-020.yml`（临时采集物，未入库）。

- **dump 共 114 行**：官方行 95（含同一包的第二入口行 `plugin-manager/tools`、`tool-subagent-control/list-agents`）+ 本仓 `@dsh-toolset/*` 18 行 + TUI 自插的 `tool-ask-user`。
- **`HOST-PACKAGES.md` 的「已挂载」标记零偏差**：§1 列 92 个包，与 dump 的官方包集合逐个比对——「doc 有 dump 无」为空，「dump 有 doc 未标」只有 `tool-ask-user`（文档按口径排除）与两个第二入口行。即**笔记不需要修正标记**，只需按 0.2.0 补 `otel`（已随上一条目完成）。
- 与 0.1.7 相比多出的正是 `dsh-base` 新增的 `otel` 行（92 = 91 + 1）。

### 步骤② 候选池（口径修正 + 实测派生）

原条目列的 21 个候选里 15 个**未在任何官方组合里作为行出现**。**审阅修正（判据）**：这 15 个里只有 `chunked-list`、`llm-deepseek` 是真·纯库（无插件导出）；其余 13 个（`session-query` / `session-persistence` / `spill` / `attachment` / `fs` / `fs-local` / `shell` / `subprocess` / `sandbox` / `bash-local` / `pwsh-local` / `tool-present` / `tool-str-replace-editor`）**都是合法 cordis 插件**（内存挂载 `ctx.plugin()` 全部 MOUNT-OK）。因此不挂它们的真实理由是：**① 无官方用法（任何官方组合都没把它们选作行）；② 缝包自己 `super(ctx, "fs"/"shell"/"subprocess"/"sandbox"/"sessionPersistence"/"sessionQuery")` 注册同名服务，而 fff 已由持有行（`fs-sandbox` / `bash-sandbox` / `subprocess-local` / `sandbox-local` / `session-persistence-jsonl` / `session-query-sqlite`）注册同一服务 → 重复注册**。另外 `tool-present` 实为官方行（`dsh-web-app/presets/{cordis,ptc,standard}.patch.yml` 三处插入），应进候选池。

**行形式修正**：官方行不只有「整包」一种，还有**子路径行**（如 `@deepseek-ai/dsh-scope/invariant`、`session/invariant`、`agent/invariant`、`agent-loop/invariant`、`plugin-manager/tools`、`headless/startup` 等共 9 条）。裸 `@deepseek-ai/dsh-scope` **没有插件导出**，按整包名挂会抛 `invalid plugin, expect function or object with an "apply" method`；官方只在 `dsh-sdk-minimal` 以 `dsh-scope/invariant` 挂它。候选池必须把「包名行 ∪ 子路径行」一起算，否则会派生出非法裸行。

**本次采用的挂载性判据（修正后）**：`已安装 ∧ 在任一官方组合（含 `dsh-web-app/presets/\*.patch.yml`）中作为 `name:` 行出现（整包或子路径）∧ 未被排除 ∧ 当前未挂载 ∧ 不与既有行重复注册服务`。实测派生 107 项（= 277 已装 ∧ 官方行 203 条 ∧ 未挂 93 的去重结果），扣除按裁定排除的族（client / api / experimental / preset / schedule / time-context / web-app 等 77 个）与本次补充排除的 13 条（`acp` / `acp-app` / `headless` / `sdk-*` / `host-*` / `cordis-*-runner` / `tool-cordis` / `session-log-export`）后，**实际可挂池 = 16 个**：

```
file-reference-local invariants message-feedback office-to-pdf session-reference session-stats
session-turn-outline skill-office terminal terminal-bash tool-bash-persistent
tool-pwsh-persistent tool-workspace-dependencies workspace workspace-changes
```

加上审阅补入的 `tool-present`（官方行，模型侧交付声明工具）与 `agent-tool-presentation`（只在 `presets/ptc.patch.yml`，非排除族）后上限为 18。**本批 10 行 ≈ 把可挂池里不需要单独评估的部分一次取完**（16 − 本批推迟的 5 个 `office-to-pdf` / `skill-office` / `tool-bash-persistent` / `tool-pwsh-persistent` / `tool-workspace-dependencies` − 裸 `scope` 形式非法 = 10）。

（安装树对照：装 277 个 `dsh-*`；官方行基线 **203** 条（13 个 `cordis.patch.yml` + `dsh-web-app/presets/{cordis,ptc,standard}.patch.yml`；只扫前者会漏 `agent-tool-presentation` / `tool-present` / `tool-ask-user` / `agent-preset` / `persona`）；当前已挂 92 个包。）

### 步骤③ 排除项（用户裁定 + 本次补充）

- **按裁定排除**：客户端 UI（`dsh-client-ui-*` 53 个；`dsh-client*` 整族已装 62 个）、Web 类（`host-webserver` / `web-frontend` / `web-app`）、运维面（`plugin-manager` / `config-editor` / `hmr`）、实验编排（`experimental-*`）、preset 家族、会话格式迁移库（`session-format*`）、API 控制面（`api-*`）、`win32-process` / `schedule` / `time-context`。
- **本次补充排除（附理由）**：`session-log-export`（描述即「Web Session-log export command」，Web 面）；`acp` / `acp-app` / `sdk-app` / `sdk-jsonrpc-server` / `headless`（替代 app 入口，不是本 TUI profile 的插件行）；`host-directory-picker-auto` / `host-open-in-app` / `host-plugin-inventory` / `host-product-telemetry-otel`（Web/Desktop/遥测运维面）；`cordis-client-runner` / `cordis-host-runner` / `tool-cordis`（cordis 开发者/检视面，先不铺）。

### 待验证的风险项（不在本批，需单独试）

- **工具名冲突**：`tool-bash-persistent` / `tool-pwsh-persistent` 与已挂的 `tool-bash` / `tool-pwsh` 可能注册同名工具（持久 shell 变体），直接挂有重复注册风险；`tool-str-replace-editor` 是模型侧编辑工具，与 `hash-edit` 的取舍属条目 #2（复用审计）结论，先不挂。
- **重资产**：`office-to-pdf` / `skill-office`（LibreOffice 预编译资产）→ 需单独确认体积与启动耗时。
- **`tool-workspace-dependencies`**（模型侧包管理工具）→ 需单独评估。

### 步骤④ 执行方式的实测约束（审阅者隔离 DSH_HOME 实测）

- **新增行必须用 `- insert:`**：按 fff 现有的 `- id: xxx` / `name:` 写法追加 → stderr 打 `patch: entry "xxx" not found`，**退出码仍是 0**（静默失败）。
- **`--dump-config` 不能当健康检查**：它不实例化插件（连无插件导出的包也零告警通过）；必须**真机启动**一次。
- profile 目录必须可写：`loadProfile` 会执行 `removeLinkProjections`（unlink + rmSync）。
- `dsh --profile <new>` 对不存在的 profile 直接硬报错（需先写 `package.json`）。
- 包在共享安装树里**不需要** `pnpm install`：dsh 的运行时解析拦截按「安装作用域闭包」供给每个 profile（`workspace-changes` 等不在 profile 链接农场里也能解析）。

## 决策

- **D1（判据）**：挂载性以「官方组合中是否作为行出现」为准（见上），不按包是否注册服务判断；原清单里的库/缝包不作行挂载。
- **D2（第一批）**：本批挂 **10 行**（低风险、加法、无同名工具）——`session-stats`、`session-turn-outline`、`session-reference`、`message-feedback`、`workspace-changes`、`file-reference-local`、`terminal`、`terminal-bash`、`invariants`、`workspace`。全部为投影 / 服务 / 事件面扩展，不改既有工具名。
- **D3（执行方式，按用户 2026-10-02 选择）**：**跳过临时 profile，直接落 fff**——改前备份 `~/.dsh/profiles/fff/cordis.patch.yml`，用**一个 `- insert:` 块**追加 10 行；回滚 = 删该块（或还原备份）。落成后用**第二次 PTY 真机启动**（不打断用户当前会话）做健康检查：stderr 无 `did not activate`、无服务/工具重复注册报错；用户重启后再做会话内生效确认（`ctx.workspaceRegistry` / `ctx.messageFeedback` / `ctx.terminals` / `sessionStats` 投影、`@file` 引用）。

> 2026-10-04 更正：该「PTY 真机启动无激活告警」为**假通过**——`message-feedback` 的 `Config.maxNoteBytes` 自 0.1.7-rc.2 起即 `.required()`，缺 `config` 必报 `1 entry did not activate`（隔离 DSH_HOME 克隆 A/B 已复现并确认补 `maxNoteBytes: 8192` 后归零）；检查 recipe 捕获口径的洞记在 `docs/archived/2026-10-04-message-feedback-activation-failure.md`。

- **D4（文档回写）**：落成后按实测更新 `HOST-PACKAGES.md`——§1 清单（92 → 102）、§2 每行 `已挂载` 标记、各分类标题的「已挂载 N」、§0「小计自洽性」。`scripts/install.sh` **本身不用改**（它只 `cp profiles/example/*`）；要改的是仓库内 `profiles/example/cordis.patch.yml`（加同一个 `- insert:` 块）——但 install.sh 对已存在的 `cordis.patch.yml` 默认「保留已有」，**老机器不会自动获得新行**，需 `--force` 或手工追加（写入文档）。排除口径也要落进 `HOST-PACKAGES.md` §0，避免下一轮重新派生同样的候选池。
- **D5（不做的事）**：不挂无官方用法的缝包（会重复注册服务）、不挂形式非法的裸 `scope`、不动排除项、不改本仓插件代码。
- **D6（第二批选题）**：① `invariants` 目前是**空注册表**（已挂集合里无任何包 inject 它），真实注册方是 4 条 `*/invariant` 子路径行（`session` / `agent` / `agent-loop` / `scope`）→ 第二批与它们同批；② `tool-present` / `agent-tool-presentation`（会改模型工具面，需单独裁定）；③ `office-to-pdf` / `skill-office`（重资产）、`tool-bash-persistent` / `tool-pwsh-persistent`（与已挂 `tool-bash` / `tool-pwsh` 可能同名，需先验）、`tool-workspace-dependencies`；④ `session-reference` 隐式依赖 `session-query-sqlite` 提供的 `sessionQuery`——移除后者会让它失效（写入文档）。

## 计划改动文件清单

- 仓库外：`~/.dsh/profiles/mounttest/`（新建临时 profile）、`~/.dsh/profiles/fff/cordis.patch.yml`（追加行；改前备份）
- `docs/host/HOST-PACKAGES.md`（挂载标记按实测回写）
- `scripts/install.sh`（如需与新挂行对齐）
- `docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）
- 本追踪文档（唯一过程记录）

## 执行记录（2026-10-02）

1. **备份**：`~/.dsh-mount-backup-2026-10-02/cordis.patch.yml.before-mount`（15153 B，改前快照）。
1. **落 fff**：向 `~/.dsh/profiles/fff/cordis.patch.yml` 尾部追加**一个 `- insert:` 块**（10 行）；顺带把该文件里 `# (与宿主 dsh 同版, 当前 0.1.7-rc.2)` 的陈旧注释改为 `0.2.0-rc.2`。文件 489 → 516 行。
1. **健康检查（第二次实例，未打断用户会话）**：
   - `dsh --profile fff --dump-config`：退出 0、**0 条 `patch: entry` 告警**、新 10 行全部在位、总行数 114 → 124。
   - PTY 真机启动（`script -qec "dsh --profile fff"`，25 s 超时终止）：无 `did not activate` / `already provided` / `duplicate` / `conflict` / `invalid plugin`（stderr 关键词扫描为空），插件自报日志照常在位。
1. **仓库侧回写**：
   - `docs/host/HOST-PACKAGES.md`：§1 标题与清单（92 → 102，追加 10 个包名与说明）、§0「小计自洽性」与新增「挂载面扩张排除口径」条目、§2 四个分组计数（会话 21→27 / 基础设施 7→8 / 终端 0→2 / 其他 0→1）、10 行 `已挂载` 标记、§3 六条服务索引的挂载状态。
   - `profiles/example/cordis.patch.yml`：追加同一个 `- insert:` 块（新机器一键安装即带这批行；注意 `install.sh` 对**已存在**的 `cordis.patch.yml` 默认「保留已有」——老机器需 `--force` 或手工追加）。

## 审阅（子代理，2026-10-02）

**结论：有条件通过**（判据被推翻 → 已改写）。审阅者独立复现了 6 项检查（挂载标记零偏差、行形式与可挂性、候选池派生、10 行体检、执行方案、漏项），并在隔离 `DSH_HOME` 里**真机跑了「fff 克隆 + 10 行」**：

- **推翻**：原判据「15 个库/缝包不可作行」——其中 13 个实为合法 cordis 插件（内存挂载 MOUNT-OK），不挂的真实理由是「无官方用法 + 与已挂持有行重复注册同名服务」；`tool-present` 实为官方行。判据与依据已按此改写。
- **补正**：裸 `dsh-scope` 无插件导出（官方用 `dsh-scope/invariant` 子路径行）→ 候选池必须把「整包行 ∪ 子路径行」一起算；`invariants` 单挂是空注册表（注册方是 4 条 `*/invariant` 子路径行）→ 记入第二批。
- **执行约束**：新增行**必须** `- insert:`（`- id:/name:` 静默失败且退出码 0）；`--dump-config` 不实例化插件、**不能**当健康检查 → 本次改为真机 PTY 启动验证。
- **本批结论**：10 行 peer / inject 全部可满足、无同名工具或服务、真机启动零告警 → **保留全部 10 行**。

## 验证汇总

| 项 | 结果 | 证据 |
|---|---|---|
| 挂载状态实测（步骤①） | 通过 | §1 的 92 个已挂标记与 dump 零偏差（唯一口径差是 TUI 自插的 `tool-ask-user`） |
| 落 fff | 通过 | patch 489 → 516 行；备份 `~/.dsh-mount-backup-2026-10-02/` |
| 组合解析（`--dump-config`） | 通过 | 退出 0、**0 条 `patch: entry` 告警**、10 行全部在位、总行 114 → 124 |
| 真机激活（第二次实例 PTY 启动 25 s） | 通过 | stderr 无 `did not activate` / 重复注册 / `invalid plugin`；插件自报日志在位 |
| 会话内回归（重启后工具面抽查） | 通过 | `context_report`（67 回合 / 849 步）与 `fs_digest` 正常返回，无回归 |
| 仓库侧回写 | 通过 | `HOST-PACKAGES.md`（§0 / §1 / §2 / §3 共 25 处 + 清单行）、`profiles/example/cordis.patch.yml`（同一 `- insert:` 块） |

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理；其余条目按当前顺序重编（复用审计 → #1，结构能力线 → #2..#5，独立修复 → #6/#7，executor 隔离 → #8，STATUS 对齐 → #9），§2 顺序依据与 §3 里程碑同步。
- 第二批选题（`invariants` 配 4 条 `*/invariant` 子路径行、`tool-present` / `agent-tool-presentation`、`office-to-pdf` / `skill-office`、`tool-*-persistent`、`tool-workspace-dependencies`）与排除口径已写入 `HOST-PACKAGES.md` §0 与本文件 D6；**未单独立 BACKLOG 条目**（用户裁定的口径是「尽量挂、排除项不挂」，第二批属同一裁定的延续，需用户择时决定是否继续）。
- 残余风险：`session-reference` 隐式依赖 `session-query-sqlite` 提供的 `sessionQuery`（移除后者会让它失效）；`invariants` 当前是空注册表。
- 本追踪文档移入 `docs/archived/`。

1. 交子代理审阅本文件「调研 + 决策」（用户流程要求）。
1. 回写文档 → 关闭条目 → 归档 → 提交（每条目一次提交）。
