# worktree 内 git 提交的无人值守自动放行路径（越界写升级请求的发起）（接取条目：`docs/BACKLOG.md`「调研 worktree 内 git 提交的无人值守自动放行路径（越界写升级请求的发起）」）

状态：已关闭　　开启：2026-10-24　　关闭：2026-10-24
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮范围只到**调研与决策**（实现拆分为两个新条目，见「收尾」）。

## 目标

只读核实宿主侧为何「越界写 = 硬拒」而不是「发起沙箱升级请求」，使 `auto-approve` 已配的 `git-worktree-commit` 白名单空转；评估三条候选路径并给出结论与后续步骤：

- a) 调 permission / approval 旋钮把越界写改为「ask 升级」，让现有白名单生效（保隔离）。
- b) 自建 git 工具插件，工具内显式调用 `ctx.sandboxPolicy.escalate()` 发起升级，经白名单自动放行（代价需 `security-guard` 兜底 hook 风险）。
- c) 把 worktree 会话写根指到仓库根（放弃 worktree 隔离语义，最省事）。

既有结论见 `auto-approve/docs/archived/2026-10-22-worktree-git-escalation.md` 与 `auto-approve/cordis.patch.yml` 的 `git-worktree-commit` 规则。

## 调研

### 0. 结论速览

- 宿主面没有「越界写 = 自动 ask 升级」的机制；`approval/request` 只由工具层在**模型显式带 `sandbox_permissions` + `justification`** 重试时发起（`@deepseek-ai/dsh-sandbox` 的 `approveEscalation`）。「升级请求被发出」缺的一环首先是**模型行为**，其次才是提示可见性（见 §2「提示可见性」）。
- 本环境 Linux 后端为 bwrap：全盘 `--ro-bind` 只读，仅把工作区根可写绑定 → worktree 会话（写根 = worktree 路径）写仓库根 `.git` 得到 EROFS「只读文件系统」，与既有实测一致。
- 三条候选路径：a) 不可行（无此旋钮）；b) 可行但投入最大（新工具包 + 白名单 `tools` 扩展 + security-guard 兜底）；c) 可行且最省事（会话写根指到仓库根，代价是放弃 worktree 隔离）。调研还发现更轻的第 4 条链路：模型按宿主提示对 git 写显式重试升级，现有 `git-worktree-commit` 白名单即可自动放行，**零本仓代码改动**。

### 1. 既有实测结论复核（auto-approve 侧）

- 归档记录 `auto-approve/docs/archived/2026-10-22-worktree-git-escalation.md:50-56` 的实测现象复核**成立**：worktree 会话里 `git add` 直接 EROFS 拒绝（exit 128）、全程无审批面板、会话目录无 `auto-approve-audit.jsonl`。归档「越界写不发升级请求」的归因需要补一层（见 §2）。
- `git-worktree-commit` 规则的正则与档位复核：
  - 定义 `auto-approve/cordis.patch.yml:16-21`：`match: '^git +(?:-C +[^ ]+ +)?(?:add|commit|tag)(?: +[^;&|]*)?$'`（:20）、`to: ['danger-full-access']`（:21）。
  - 判定入口 `auto-approve/src/patterns.ts:13-23`（`normalizeCommand`：折叠空白、去成对首尾引号）；正则**锚定整串**且用 `[^;&|]` 排除复合命令，与归档「只放行三简单形态」的裁定一致（`auto-approve/docs/archived/2026-10-22-worktree-git-escalation.md:27-28`）。
  - 判定链（全链路）：
    1. bash 工具只在 `sandbox_permissions` 与 `justification` 同时出现时走升级（宿主 `packages/shell/tool-bash/src/index.ts:482-484`）→ `approveEscalation`（`packages/sandbox/sandbox/src/escalation.ts:171-208`）→ `approval/request`，reason 形如 `escalate sandbox to danger-full-access: <理由>`（:192）。
    2. 本仓 gate 在 `tools/pre-execute` 记录 `callId → 参数`（`auto-approve/src/main.ts:233-239`、`gate.ts:89-105`）；应答者在 `approval/request` 上反查参数并跑完整阶梯（`main.ts:241-247`、`answerer.ts:63-111`）。
    3. 从 reason 解析目标档（`auto-approve/src/patterns.ts:50-56`、`answerer.ts:46-51`）；升级白名单 `checkEscalationAllow`（`auto-approve/src/rules.ts:155-198`）：目标档必须存在（:160）、`modeAllowed` 校验目标在 `to` 内（:182、`patterns.ts:136-142`）、命令正则命中（:183-188）→ `allowed-once`、`ruleId='git-worktree-commit'`。
    4. 命中后 `approveEscalation` 返回获批档，bash 以 `danger-full-access` 执行（`tool-bash/src/index.ts:485-497`）；该档在 `bash-sandbox` 直接放行、不套 bwrap（`packages/shell/bash-sandbox/src/index.ts:92-97`）。
  - 档位一致性复核：从 `workspace-write` 升 `danger-full-access` 满足宿主严格加宽表 `WIDER_MODES`（`packages/sandbox/sandbox/src/escalation.ts:28-31`）；规则 `to` 与请求档一致，两维判定可命中。
  - **关键约束（影响路径 b）**：命令型白名单规则的工具门缺省是 SHELL_TOOLS（`auto-approve/src/rules.ts:174-180`）——只对 `bash` / `pwsh` / `shell` 生效。自定义 git 工具要命中该规则，必须显式加 `tools` 字段（配置类型已支持：`config.ts:36,347` 解析、`rules.ts:180` 判定）。
  - 归档「规则空转」在「模型从不发起升级」的前提下成立；但链本身**可达**——模型重试时带上升级参数，白名单即命中并无人值守放行（详见 §2「提示可见性」与 §3）。

### 2. 宿主侧只读核实（为何越界写是硬拒而非 ask 升级）

- 版本与位置：全局安装 `~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh`（0.2.1-rc.2，仅编译产物）+ 同版本 `node_modules/@deepseek-ai/dsh-sandbox-*`、`dsh-tool-bash` 等；源码 clone `~/GithubRepos/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，与安装版本一致）。下文行号均指 clone 源码；`docs/host/` 研读口径与源码一致（`HOST-PACKAGES.md:270-275`、`HOST-UPGRADE-0.2.1-rc.2.md:62`、`DSH-CTX-API.md:83-91`）。
- 写根与模式：
  - `ctx.sandboxPolicy.resolve()`：`mode = 显式覆盖 ?? 会话 last sandbox/mode ?? 部署缺省`；`workspaceRoot = session.header.cwd ?? 配置回退根`（`packages/sandbox/sandbox-policy/src/index.ts:164-171`，写根取会话 cwd 在 :168）。
  - 部署缺省 `workspace-write` + approval `ask`（`packages/bundle/base/cordis.patch.yml:246,262`）；本会话运行期事实与之一致（沙箱模式 workspace-write）。permission-presets 的 `workspace-write` 档 = sandbox workspace-write + approval ask（:271-273）。
  - worktree 会话以 worktree 目录为 cwd → 写根 = worktree 目录；仓库根 `.git/`（`worktrees/<名>/index.lock`、共享 `objects` / `refs`）在写根之外。
- 硬拒机制（为何是 EROFS）：
  - Linux 后端 bwrap（`packages/sandbox/sandbox-local/src/index.ts:160-167` 按平台选链，bwrap 优先）；bwrap 参数（`packages/sandbox/sandbox-local/src/profiles.ts:16-23`）：`--ro-bind / /` 全盘只读 + 仅 `workspace-write` 时 `--bind <workspaceRoot>` 可写（另 `--tmpfs /tmp`）。写根之外的一切路径一律 EROFS「只读文件系统」。
  - 本机 `bwrap` 存在（0.9.0）；既有实测错误文案「只读文件系统」对应 bwrap 的拒绝签名 `read-only file system`（`sandbox-local/src/index.ts:207-215`），而非 landlock 的「permission denied」→ 激活后端确为 bwrap。
  - 其余后端同理只放行 `writableRoots`（工作区根 + `/tmp` + 平台临时目录，`packages/sandbox/sandbox/src/roots.ts:31-35`）。
- 「越界写 → ask」机制不存在：
  - `approval/request` 的唯一发起点是工具层 `approveEscalation`（`packages/sandbox/sandbox/src/escalation.ts:171-208`）；bash 工具只在模型显式带 `sandbox_permissions` 时走它（`packages/shell/tool-bash/src/index.ts:482-484`）。**沙箱拒绝本身不触发任何 request**。
  - `ctx.approval` 只有 `ask` / `never` 两个策略，决定的是「已有 ask 交不交应答者」（`packages/interaction/user-approval/src/index.ts:126-141,158-165`；`never` 直接 `rejected`、无人应答 fail-closed `unavailable`）；对沙箱拒绝不发生任何事件。
  - permission-presets 只整体切换会话模式，且 `danger-full-access` 档伴 `approval: never`（`packages/bundle/base/cordis.patch.yml:274-276`）。**现有任何 permission / approval 旋钮都无法把「越界写」变成「ask 升级」**。
  - 接口澄清：宿主 `ctx.sandboxPolicy` 只提供 `resolve` / `overrideOf` / `defaultMode`，**没有** `escalate()` / `approve()` / `check()`（`docs/host/HOST-UPGRADE-0.2.1-rc.2.md:62` 的「resolve/check/approve/escalate」是把 `dsh-sandbox` 的 `approveEscalation` 工具层面混写在了一起）；升级编排在 `@deepseek-ai/dsh-sandbox/escalation.ts` 的 `approveEscalation`，由工具层调用并注入 `approver: ctx.get('approval')`。
- bash 工具升级触发条件：
  - 有沙箱执行器（`ctx.shell.sandboxMode` 非 undefined）时才广播 `sandbox_permissions` / `justification` 两个参数（`tool-bash/src/index.ts:207-208,390-401`）；fff profile 走 `bash-sandbox`（base patch:249-253）→ 参数对模型可见。
  - 校验 `validateBashArgs`（:73-88）：两参数成对、justification 非空；`approveEscalation` 还校验目标属于严格加宽表（`escalation.ts:177-179`）。
- 提示可见性（额外发现，直接影响「模型会不会发起升级」）：
  - 升级提示只渲染在沙箱**确认拒绝**时：`result.sandbox.denied === true` 才给 `[sandbox: escalation available …]` 提示（`packages/shell/tool-bash/src/render.ts:45-51`）。
  - `denied` 由 stderr 与英文签名匹配得到（`packages/shell/bash-sandbox/src/helpers.ts:12-14`；`packages/sandbox/sandbox/src/diagnostics.ts:96-99`；bwrap 签名 `read-only file system`，`sandbox-local/src/index.ts:207-215`）。
  - 实测中 git 以本地化文案报错（「只读文件系统」），**不命中**英文签名 → `denied=false` → 模型看不到升级提示。这是「升级请求不被发出」的一个直接可见原因（宿主侧问题，本仓无法改宿主源码）。
- fs 写工具同理：`fs-sandbox` 对写根之外抛 `FS_SANDBOX_DENIED`（`packages/fs/fs-sandbox/src/index.ts` 头部契约），工具层映射为拒绝标记 + 升级提示，升级仍须模型显式带参数。

### 3. 三条路径评估

- **a) 调 permission / approval 旋钮把越界写改为 ask 升级（保隔离）**：不可行（依据 §2「「越界写 → ask」机制不存在」）。宿主与 profile 配置面都没有「沙箱拒绝 → 发起 approval/request」的开关；approval 策略只作用于已有 ask；permission-presets 只整体切模式且 danger 档 `approval: never`。要以 a 的方式实现必须改宿主源码（不在本仓可改范围，本任务也禁止动宿主/profile）。改动面：无（不可落地）；风险：不适用；能否真机验证：否（无触发点）。
- **b) 自建 git 工具插件，工具内显式发起升级**：可行。新 `git` 工具 schema 限子命令（add / commit / tag，允许 `-C` 前缀）→ 参数校验 → 调用 `approveEscalation({requestedMode:'danger-full-access', …}, {approver: ctx.get('approval'), agent, callId, toolName:'git'})` → 获批后经 `ctx.shell.execute` 以 `sandboxPolicy: {mode:'danger-full-access'}` 执行。白名单侧：`git-worktree-commit` 规则补 `tools: ['git']`（配置面已支持）即可命中。改动面**最大**：新 bundle 包（schema + 升级编排 + 命令执行 + 测试 + README / BACKLOG / DESIGN）+ 白名单 `tools` 扩展 + security-guard 兜底 + 构建与 profile 重挂载。风险：① 工具绕过 bash 的命令文本守卫，git 参数注入面与仓库 hook（pre-commit 等可执行任意代码）需 security-guard 兜底（现黑名单无 git 专项，`security-guard/src/blacklist.ts`）；② danger-full-access 下整条命令不受 bwrap 保护；③ 需与 behavior-correction / auto-approve 的对齐（请求带 `toolName='git'`）。能否真机验证：**能**（worktree 会话调用 git 工具 → approval/request → 白名单 allowed-once → commit 成功且无面板）。这是三条里唯一保留 worktree 隔离并让现有白名单真正生效的路径。
- **c) 把 worktree 会话写根指到仓库根（放弃隔离）**：可行且最省事。写根 = `session.header.cwd`（§2「写根与模式」），在会话创建处把 worktree 会话的 cwd 归一到 git 仓库根（`git rev-parse --show-toplevel`），仓库根 `.git` 与所有 worktree 都落入工作区，写全部允许，白名单从此不需要。改动面**小**（会话创建点若干处：herdr-use 后台会话 / coagent spawn，或收口到 session-paths 的 helper，加单测）。风险：放弃 worktree 隔离——同仓库根下任一 worktree 会话可写其他 worktree 的文件（单人多 worktree 并行开发通常可接受，但属产品取舍）；白名单规则继续空转（本轮不动）。能否真机验证：**能**（worktree 会话 `git add` + `git commit` 直接成功，无 EROFS、无面板）。
- **第 4 条（调研发现，不在任务列的 a/b/c 内）**：不改工具、不加白名单、零代码——让 worktree 会话模型在 git 写失败后**按宿主提示重试**：bash 调用带 `sandbox_permissions: 'danger-full-access'` + `justification`。链今天即可达（§1 判定链 + §2「提示可见性」），现有 `git-worktree-commit` 白名单命中即无人值守放行，保留隔离。堵点全是行为 / 可见性面：① 模型是否知道发起（当前提示因本地化管理消息不匹配而不显示，属宿主侧）；② 模型是否照做（可在 AGENTS.md 或 rule-engine 注入一层指引，小改）。它是最轻的「让白名单生效」路径，应先于 b 做真机验证。

### 4. 调研小结

- 「升级请求不被发出」的真因：宿主把升级设计成**模型显式发起**（带 `sandbox_permissions`），沙箱拒绝本身不含 ask；叠加 git 本地化消息让拒绝分类失配、升级提示不显示，模型在实测中既无提示也未发起。
- 白名单本身（正则 / `to` / 判定链）正确且可达，请求一旦发出即可命中。
- 三条候选路径中 a 不可行；按「改动小 / 可真机验证」排序 c < b；「保留隔离同时让白名单生效」只有 b 与第 4 条路径能做到，而第 4 条零代码。

### 5. 宿主侧问题与本仓绕过的分界（2026-10-24 追加，用户要求写清）

- **宿主侧问题（本仓改不了）**：宿主判断「这次失败算不算沙箱拒绝」靠 `matchesSignature`（`packages/sandbox/sandbox/src/diagnostics.ts:86-93`）＝非零退出 + stderr 含**英文**后端签名（bwrap 的 `read-only file system`）。git 在中文 locale 打印「只读文件系统」→ 不命中 → `sandbox.denied = false` → `tool-bash/src/render.ts:45-51` 不显示 `[sandbox: escalation available …]` → 模型不知道可以升级重试。修它属宿主职责，记为决策 4 第 1 条未决项。
- **本仓拿得到的东西**：`tool/result` 的结构化 payload（`tool-bash/src/index.ts:161-179`）含 `exitCode` / `signal` / `stderr` / `sandbox: {mode, denied, enforcement?}` / `cwd`；而 rule-engine 的 `tool-result` 节点判定文本只有**结果文本**，拿不到 `exitCode`、`sandbox` 与调用参数。
- **分界**：要结构化判据必须自建插件直接订阅宿主 `tool/result` 事件；要零新增监听只能用文本匹配。两者都不改宿主。
- 用户 2026-10-24 裁定：本仓按「rule-engine 注入提醒」处理（见决策 5）。

## 决策

- **决策 1（选路；选项 a / b / c / 不立项）**：选定 **不立项（本轮暂不做）**。理由：① a 排除——宿主与配置面都没有「越界写转 ask」的机制（§3 a）；② b 可行但投入最大，值得立项的前提是「保留隔离 + 白名单生效」成为明确需求；③ c 可行且对症，但放弃隔离是产品取舍，且与 2026-10-24「workspace 口径不另开条目」的既有裁定冲突，应由用户明确同意后另行立项；④ 调研发现更轻的第 4 条原生链路（模型显式重试升级）今天即可让白名单命中——立项前应先真机验证它是否足以解决问题，若可达且可用，b / c 都不需要。依据集中在 §4 调研小结。

- **决策 2（若做，分步计划与验证方式；worktree 内 git commit 真机跑通的最低条件）**：

  - 前置验证（零代码，真机）：在测试 worktree（如 `.worktree/test-approve`）用 herdr 起 fffdsh 会话，agent 建文件后对 `git add` / `git commit` 显式带 `sandbox_permissions: 'danger-full-access'` + `justification` 重试。最低断言：① 会话目录出现 `auto-approve-audit.jsonl` 且 `outcome=allowed-once`、`ruleId=git-worktree-commit`；② commit 成功；③ 全程无人工面板。通过即证明白名单端到端可用，无需任何立项。
  - 若前置验证不可达（模型始终不发起），推荐做 **c**，分步：① 在 `session-paths` 增加 worktree → 仓库根判定 helper（`cwd` 在 git worktree 内返回 `git rev-parse --show-toplevel`，否则原样）；② herdr-use 后台会话创建（`herdr-use/src/actions.ts:680-690` 的 `--cwd`）与 coagent spawn（`coagent/src/actions.ts:333-343`、`launch.ts:42-60`）统一套用；③ 单测（归一纯函数）+ `npm run check` / 各包 test + 构建；④ 真机：worktree 会话 `git add && git commit` 直接成功、无 EROFS、无面板、无审计（不需要审批）。
  - 若用户明确要求「保留隔离 + 白名单生效」，再走 **b**（概要计划见决策 3 备选清单；真机断言同前置验证）。

- **决策 3（计划改动文件清单草案）**：主推 c 的清单见「规划」节；备选 b 的清单见「规划」节第二段。

- **决策 4（宿主侧未决问题，立项前应向宿主 / 主会话确认）**：

  1. 沙箱拒绝分类只按英文 stderr 签名（`diagnostics.ts:96-99` + `sandbox-local/src/index.ts:207-215`），本地化管理消息（如 git「只读文件系统」）不命中 → 模型看不到升级提示；宿主是否有意改为按 errno / 退出码判定，或接受本仓以指令层补提示。
  2. 0.2.1 起 `working_directory` 使执行目录与 `header.cwd` 分离，但 `sandboxPolicy.resolve()` 仍以 `header.cwd` 定写根（`sandbox-policy/src/index.ts:168`）——确认这是预期（写根不随 working_directory 走）；否则 c 路线有更干净的宿主级落点。
  3. danger-full-access 下 git hook（pre-commit 等）不经任何沙箱；宿主是否把「升级后的 hook 边界」列入规划（归档口径目前视为仓库自身内容）。

- **决策 5（第 4 条链路的提示补齐方式；2026-10-24 用户裁定）**：

  - 选项：a 不补，只记宿主未决项 · b 在 `AGENTS.md` 写一条通用指引（会话常驻）· c rule-engine 消费者订阅 `tool-result`、注入重试指引、`delivery: "steer"` · d 自建插件订阅宿主 `tool/result`，用结构化判据（`exitCode` / `sandbox.mode` / 命令形状）后自行 `agent.steer` 注入。
  - **选定 c**（用户 2026-10-24 裁定「用 rule-engine 注入提醒的方式处理」）。
  - 判据（受 §5 约束）：结果文本同时命中 ① `只读文件系统` 或 `read-only file system` ② git 线索（`git` 与 `.git` / `index.lock` 之一）。理由：rule-engine 只拿得到结果文本，加 git 线索可压掉「其它程序也报只读文件系统」的误触发。~~此判据已被 2026-10-24 修订取代（见「决策 5 修订」）~~。
  - **已知脆弱点（必须写在 README 与追踪文档）**：判据依赖宿主的本地化文案，宿主改文案、换 locale 或换后端即失效；拿不到 `exitCode`、`sandbox` 与调用参数。若真机实测不稳，转 d（结构化判据，需自建事件监听）。~~修订后该脆弱点消除。~~
  - 注入形态：`delivery: "steer"` —— 缺省 `followup` 会等到下一回合，模型那时已放弃；`steer` 挂在失败后的 pre-step 上，同回合即可重试。`dedupeInRecord: 1` 防反复提醒。
  - 注入文案草案：「刚才的 git 写被沙箱拒绝（越界写只读文件系统）。若确需写仓库根 `.git`：同一命令加 `sandbox_permissions: \"danger-full-access\"` 与 `justification`（一句话说明为什么必须写 `.git`）重试一次；`auto-approve` 的 `git-worktree-commit` 白名单会自动放行，不弹面板。」
  - 与决策 1 的关系：决策 1 的「不立项」指 a / b / c 三条路径不立项；本项只给第 4 条零代码链路补提示 —— 不新增工具、不改白名单、不动宿主。
  - 落地包待定：候选 `auto-approve`（已有白名单与审计知识），或新增小包。

- **决策 5 修订（判据来源；2026-10-24 用户选定 c）**：

  - **2026-10-24 作废**：`tool/result` 会话事件只带 `message` / `error` / `meta`（`agent-loop/src/tool-calls.ts:282-295`），工具返回值不进事件流，透传无从谈起；改走 `tools/post-execute` + `additionalContexts`（见 `docs/implementation/2026-10-24-escalation-hint-package.md` 决策 10）。配套的「`rule-engine` 透传」条目已标不立项（`docs/archived/2026-10-24-rule-engine-tool-result-context.md`）。

  - 三条走法中选定 **c：扩展 rule-engine 透传结构化 payload**（a = 沿用文本匹配；b = 自建插件直接订阅 `tool/result`）。

  - 现状依据：rule-engine 处理 `tool/result` 时只把 `messageText(data["message"])` 交给 `decide(text, trigger, ctx)`（`rule-engine/src/engine.ts:701-712`），结构化 `value` 被丢弃；扩展后消费者可读 `ctx.toolResult`（建议形状 `{ toolName?, callId?, value? }`，可选字段、向后兼容）。

  - 新判据（取代文案匹配）：`value.exitCode !== 0`（或 `signal` 非空）+ 调用参数命令匹配 `git\s+(add|commit|tag)` + `value.sandbox.mode === "workspace-write"`。`value.sandbox.denied` **不作判据**（对 git 恒 `false`，见 §5）。文案只进日志与注入正文，不作判据。

  - 保留不变：注入仍由 rule-engine 负责（`sources: ["tool-result"]`、`delivery: "steer"`、`dedupeInRecord: 1`），~~落地包仍候选 `auto-approve`~~（见决策 6）。

  - 需补的一环：`tool-result` 事件不自带调用参数，须按 `callId` 回溯 `tool/call` 的参数 —— rule-engine 侧保留最近的 `callId → 参数` 映射（上限 N 条，防内存增长），或一并透传。

- **决策 6（包名与覆盖范围；2026-10-24 用户裁定）**：

  - **新包名 `escalation-hint`**（`@dsh-toolset/escalation-hint`），不挂在 `auto-approve` 里。
  - **范围：整类问题，不只 git** —— 凡是「沙箱拒绝但升级提示缺失」的调用都要覆盖：`bash` / `pwsh` 的越界写、`write` / `edit` / `str_replace_editor` 的越界写。
  - 判据分三层（按可靠性从高到低）：
    1. 结果已含 `[sandbox: escalation available …]`（宿主常量，`escalation.ts` 的 `escalationHintMarker`）→ 跳过，不重复提示。
    2. 结果含 `[sandbox: file access denied under <mode> mode]`（宿主常量 `sandboxDenialMarker`）却**没有**升级提示 → 补提示（判据稳定，与文案本地化无关）。
    3. 无任何 marker、但结构化字段显示「沙箱模式内非零退出 / `FS_SANDBOX_DENIED`」且文案或命令形状指向越界写 → 补提示（已知脆弱层，先只覆盖 `git add|commit|tag` 与常见写命令，逐条加）。
  - 消费者 id 建议 `escalation-hint/sandbox-denial`；注入一律 `delivery: "steer"` + `dedupeInRecord: 1`。

## 规划

计划改动文件清单（草案，实现阶段定稿；本轮不做实现）：

已定（决策 5 + 修订 + 决策 6）：

- `rule-engine/src/types.ts`：消费者 `ctx` 增可选 `toolResult`（建议 `{ toolName?: string; callId?: string; value?: unknown }`），并补文档注释；向后兼容（省略即旧行为）。
- `rule-engine/src/engine.ts`：`tool/result` 分支（`:701-712`）在现有文本之外把 `data` 的结构化 `value` 透传进 `decide` 的 `ctx`；同时维护 `callId → tool/call 参数` 的最近 N 条映射，供消费者按 `callId` 取调用参数。
- `rule-engine/tests/`：`toolResult` 透传、`callId` 回溯、缺字段时旧行为不变、映射上限淘汰。
- 新包 `escalation-hint/`：`src/index.ts`（注册消费者 `escalation-hint/sandbox-denial`：`sources: ["tool-result"]`、`delivery: "steer"`、`dedupeInRecord: 1`，三层判据见决策 6）+ `cordis.patch.yml` + `README.md` + `tests/`（三层判据的命中 / 跳过 / 误报放行、注入文案、去重）。
- 根级接线：`AGENTS.md`（结构与约定清单）、`README.md` / `README.zh.md`（包清单与文档索引）、`scripts/install.sh`（包枚举与 profile 挂载）、`package.json`（workspaces 委托）。
- `auto-approve/README.md`：补一句「本包只在已有 approval 请求时生效；沙箱硬拒的提示由 `escalation-hint` 负责」，避免再次误判为空转。

备选（若扩展 rule-engine 被否决）：新包内直接订阅宿主 `tool/result`，读 `exitCode` / `sandbox.mode` / 调用参数后 `agent.steer` 注入。

主推 c 路径（写根指到仓库根，仅在用户另行要求时）：

- `session-paths/src/`（新增 worktree → 仓库根判定 helper，如 `projectDirFor`：`cwd` 在 git worktree 内返回 `--show-toplevel`，否则原样；纯函数落 `session-paths`，写盘面不动）
- `herdr-use/src/actions.ts`（后台会话创建 `--cwd` 处套用归一，约 :680-690）
- `coagent/src/actions.ts`（spawn 的 `cwd` 校验 / 设定处套用归一，约 :333-343）、`coagent/src/launch.ts`（`cwd` 校验，约 :42-60）
- 各改动包的单测（归一纯函数用例）+ 相关 README / BACKLOG 同步

备选 b（保留隔离的自建 git 工具，仅在用户明确要求时）：

- 新包 `git/`：`src/index.ts`（schema + `approveEscalation` 编排 + 经 `ctx.shell.execute` 执行）+ `cordis.patch.yml` + `README.md` + `tests/`
- `auto-approve/cordis.patch.yml`（`git-worktree-commit` 规则补 `tools: ['git']`，或按新工具名增一条）
- `security-guard/`（git 工具的 hook 风险兜底：守卫或至少 README 说明）
- 相应 BACKLOG / DESIGN / 构建与 profile 重挂载

明确不做：本轮不实现任何改动、不改宿主侧 profile 配置、不动 `auto-approve` 现有规则。

## 实现记录

（本轮不做实现：本任务范围是调研 + 决策，未改任何源码 / 配置 / 宿主侧内容。）

## 偏差

- 计划外新增三个决策：决策 5（提示补齐方式）、决策 5 修订（判据改为结构化 payload）、决策 6（新包 `escalation-hint` 与覆盖范围）。三者均由用户当次明确指示，属范围扩张而非违规。
- 决策 1「不立项」结论未变：a / b / c 三条路径不做，改走「第 4 条零代码链路 + 提示消费者」。
- 原始计划里的「三条候选路径 + 结论归档」已完成；实现部分按用户要求拆成两个新条目。

## 测试与证据

- 全部结论来自只读核实：宿主源码阅读（`~/GithubRepos/deepseek-harness`，tag `dsh-v0.2.1-rc.2`）、`docs/host/` 既有研读、本仓源码阅读。未跑 build / test / format，未改任何文件。
- 关键证据位置：`packages/sandbox/sandbox/src/diagnostics.ts:86-93`（`matchesSignature` 英文签名判定）、`packages/shell/tool-bash/src/index.ts:161-179`（`{exitCode, sandbox:{mode,denied}, cwd…}` 结构化 payload）、`packages/shell/tool-bash/src/render.ts:45-51`（提示只在 `denied` 时渲染）、`auto-approve/src/rules.ts:155-198`（升级白名单判定链）、`rule-engine/src/engine.ts:701-712`（消费者只拿到结果文本）。
- 未做真机验证：第 4 条链路的真机跑通留给 `escalation-hint` 任务（其追踪文档含断言）。

## 收尾

- 条目「调研 worktree 内 git 提交的无人值守自动放行路径（越界写升级请求的发起）」标完成并从 `docs/BACKLOG.md` 移除。
- 实施拆成两个新条目与新追踪文档：新包 `escalation-hint`（`docs/implementation/2026-10-24-escalation-hint-package.md`）、`rule-engine` 消费者透传（`docs/implementation/2026-10-24-rule-engine-tool-result-context.md`）。
- 本文件移入 `docs/archived/`；未回写 DESIGN / README（本轮无实现）。
