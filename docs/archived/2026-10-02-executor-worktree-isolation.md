# executor 隔离落地（自建简易 worktree）（接取条目：`docs/BACKLOG.md`「executor 隔离落地（自建简易 worktree）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

叶子 `executor` 已支持 `cwd` 透传但**无隔离**；官方 316 个公开包内**无** worktree 实现（`docs/host/HOST-PACKAGES.md:473`），第三方 `dsh-git-worktree` 为实验包 → **用户裁定自建简易版**：executor 增补 `isolate: "worktree"`，引擎建/回收 worktree，路径作为 `cwd` 传给 `subagent` / `command` 后端。**边界（简单版）**：不自动 merge、不做审查/checkpoint、不处理远程、不并发复用同一 leafId。

## 调研

- 执行缝：`task-engine/src/main.ts` 的 executor 叶子执行路径（命令后端 `runShell`、subagent 后端 `ctx.subagents`）；`cwd` 已是既有透传项。
- 命令执行：`git worktree add/remove` 用 `execFile`（**不经 shell**），命令文本经**现成** `makeCommandGuard`（前一条目刚落地；`metric-loop` 亦有一份）→ 复用，避免第三份拷贝。
- 已知边界（来自前条目审阅）：`inspectCommand` 的敏感层按**命令文本里的路径**解析，**看不到 executor 的 `cwd`** → `source` 串应带 cwd。

## 决策

- **D1（声明面）**：叶子 `executor` 增补 `isolate?: "worktree"`（缺省不隔离，**既有行为逐字不变**）；仅对叶子生效，Composite/非叶子声明 `isolate` 给清晰报错。
- **D2（建与放）**：执行前 `git worktree add <repo>/.worktree/<leafId> -b dsh/<leafId>`（`execFile`，`cwd` = 仓库根；仓库根取 `git rev-parse --show-toplevel` 或宿主 workspace 根），成功后把该路径作为 `cwd` 传给后端；`.worktree/` 已在仓库忽略内否需确认（需时加 `.gitignore` 条目）。
- **D3（复查）**：`git` 命令经**复用** `makeCommandGuard`（source 形如 `task-engine{worktree} <leafId> cwd=<repo>`）；命中即不执行建/删，按失败返回回执原文。
- **D4（回收）**：`stop` / `join` / 失败路径 `git worktree remove --force <path>` + `git branch -D dsh/<leafId>`；**回收失败保留现场**并在回执/结果里给出路径（不静默）。
- **D5（幂等与冲突）**：同一 leafId 二次执行 → 若 worktree 已存在则**复用**（不再 `add`）；分支已存在则 `-B` 或复用；不同 leaf 各自独立目录与分支。
- **D6（不做）**：不自动 merge；不做审查/checkpoint；不处理远程；不引入配置项或新工具；不改 `security-guard` / `metric-loop`。
- **D7（测试）**：① 不隔离时行为逐字不变（既有用例回归）；② 隔离时：worktree 建出、命令在 worktree 里跑（探针文件落在 worktree 而非主树）、主树 HEAD/工作区不变；③ 回收：`remove` 后目录消失、分支删除；④ 回收失败保留现场（模拟 `remove` 失败）；⑤ `git` 命令被 guard 拦（假 guard 命中）→ 不建、返回回执；⑥ 幂等（同 leafId 二次执行复用）；⑦ 非 git 仓库/无仓库根 → 清晰错误；⑧ `source` 串含 `cwd`。
- **D8（文档）**：`task-engine/README.md` + `docs/DESIGN.md` 边界段补「`isolate:"worktree"` 语义与简单版边界（不 merge / 保留现场策略 / guard 看不到 cwd）」。
- **D9（验证）**：`task-engine` check/build/test + 根 check/test/build；反向验证（撤建/撤回收 → 对应用例必失败，两态）；`smoke:executor`；真机（若沙箱允许）或 dist 级端到端探针（真 `git` + 临时仓库）。

## 计划改动文件清单

- `task-engine/src/{types,main,engine}.ts`（+ 可能的 `.gitignore`）、`task-engine/tests/exec-isolate.test.ts`（新）、`task-engine/README.md`、`task-engine/docs/DESIGN.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「决策」。
1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02）

- `src/types.ts`：叶子 `ExecutorSpec` 增补 `isolate?: "worktree"`（可选字段 → 声明/事件/快照回放兼容）。
- `src/gate.ts`：值域校验 + **仅 `command` 后端**（宿主子代理请求面无 cwd，见下）+ 必须给 `cwd`；非叶子声明由既有规则拒绝；**新增 `GateRule "isolate-id"`**（`validateIsolateId`：危险词分片拼接 + 敏感形状 → 声明期拒绝并给「改 id」指引）。
- `src/main.ts`：worktree 隔离器 —— 仓库根只在**声明的 `cwd`** 下跑 `git rev-parse --show-toplevel`（**不回退 `process.cwd`**）；leafId 经 `worktreeSegment()` 安全化（`[A-Za-z0-9_-]` + 短哈希）**并断言最终路径位于 `<repo>/.worktree/` 之内**（修掉 `../../evil` 路径穿越）；`git` 命令复用 `makeCommandGuard`（`source` 形如 `task-engine{worktree} <leafId> cwd=<repo>`，**仅可审计、不参与判定**）；`-B` 前先 `git worktree prune`（修掉「already used by worktree」死结）；git 调用超时 60s；执行期兜底 `checkIsolateDecl`。
- **回收策略（按审阅修订）**：**不带 `--force`**；回收前查 `git status --porcelain` —— **非空则保留现场**（把路径 + 取回提示写进 `plan/frame-completed/failed.notice` 与 stop 反馈），并**跳过 `branch -D`**；干净才 `worktree remove`，成功后再 `branch -D`（容忍「已不存在」）；回收失败不阻断 `stop`/`join`。
- `src/engine.ts`：新增 `TerminalHook`（done / failed 时触发回收）。
- 新增 `tests/exec-isolate.test.ts`；`README.md` + `docs/DESIGN.md` 边界段更新（含「成功也会回收」语义与「仅 command 后端」）。
- `docs/host/HOST-PACKAGES.md`（父会话）：追加宿主事实「子代理请求面无 cwd」（`SubagentStartRequest` 无该字段、`resolveChildCwd` 只有部署级 > 父会话、`AgentOptions` 仅 4 字段）。

## 测试与证据（2026-10-02）

- `task-engine`：`check` exit 0、`build` exit 0、**109/109 全绿**（改前 95 → +14）；父会话复跑一致。
- **反向验证两态**（实现者，父会话观察到变异态）：撤实现相关分支 → 一次观测到 **11 例失败**（98 pass / 11 fail）；还原后 109/109。
- 收录的判定口径（实现者实测）：`git init`（**无需提交**）即可 `worktree add`；`D7④` 用 `git worktree lock` 构造回收失败；幂等判定用 `git worktree list --porcelain`（**不用** fs 存在判断，空目录会被 `add` 接管）。
- 全仓：`npm run check` exit 0、`npm run test` **20 包全 `fail 0`**、`npm run build` exit 0（父会话复跑）。

## 审阅（子代理 `29d4e8a2`）——结论：**不通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| **高**：D4 回收会丢产出（`--force` 全删 + 成功也删 + 删分支） | 已改：默认无 `--force`、`porcelain` 非空即**保留现场**并跳过 `branch -D`、成功也回收的语义写进 README/DESIGN |
| **高**：D2/D7 与实现相反（`isolate` 只对 `command` 生效） | 已改文档 + 在 `docs/host/HOST-PACKAGES.md` 落宿主事实（父会话） |
| 中：崩后注册残留（`-B` 撞「already used by worktree」） | 已改：`-B` 前 `prune` |
| 中：guard 误拦自身命令（`id_rsa` 形/含黑名单词的 id） | 已改：gate 新增 `isolate-id` 规则，声明期拒绝并给改 id 指引 |
| 中：`source` 带 cwd 被当作缓解 | 已改文档：仅「便于审计定位」，**不参与判定** |
| 低：`-B` 前提 / 测试构造 / 超时 60s 写进设计 | 已写；abort/卸载孤儿记残余 |
| 漏项：README:85「隔离未实现」、`docs/BACKLOG.md` 落点写「透传 subagent」 | README 已改；BACKLOG 行随本条目关闭（落点描述的错误在本文档纠正） |

- 审阅实测参考：`worktree add/remove/branch -D/rev-parse` 对 guard **默认全放行**；路径/leafId 含黑名单词或敏感形状会被拦（**连回收命令也会被拦**）→ 回收失败路径按「保留现场 + 回执」处理。

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① **跨进程残留不回收**（reclaim 只认内存 held；进程重启后终态 worktree 不回收）→ 建议后续条目按 `worktree list --porcelain` 重算；② **abort / interrupted / 卸载**路径无清扫 → 孤儿；③ worktree 内**无 `node_modules`**（叶子命令依赖它会失败）；④ 目标仓未忽略 `.worktree` 时主树 `git status` 会多出 `?? .worktree/`（本仓已忽略）；⑤ git 全局配置（hooks / 别名 / 签名）仍是隐式依赖；⑥ **真机未跑**（沙箱对 `~/.dsh/profiles/fff` 只读）→ 建议 `dsh headless --patch <overlay>` 或重启后实测；⑦ 实现者**收尾终报未到**即由父会话按已复核状态关闭（pkg/repo 全绿 + 反向验证已观察）。

## 补记：实现者终报要点（2026-10-02，归档后回填）

- **diff 规模**：`src/types.ts` +24/-1；`src/engine.ts` +104/-41（新增 `TerminalHook` + `TaskEngineOptions.onFrameTerminal`，`rejectFrame` 改 async，`completeUp/tryJoinParent` 回传注记，`stop` 成功路径可带终态注记）；`src/main.ts` +461（`makeWorktreeIsolator` ensure/reclaim/reclaimAll + `worktreeSegment` + `checkIsolateDecl`，command 分支覆盖 `cwd`，unload 兜底 async disposer）；`src/gate.ts` +89（isolate 规则 + `validateIsolateId` + `GateRule "isolate-id"`，**计划外文件**：id 规则只能落此处，且与 `tools.ts` 入参校验共用一个门禁）；`README.md` +51、`docs/DESIGN.md` +25（新增「executor 隔离」段与取舍 12）；`tests/exec-isolate.test.ts` 新增 950 行 / 14 例。
- **14 例清单**：① 不隔离回归；② 隔离生效（探针落 worktree、主树 status 空 + HEAD 不变、分支 `dsh/c1`）；③ 回收（stop→done：目录消失 + 分支删除 + 注册表清）；④ 回收失败保留现场（`git worktree lock`）；⑤ 假 guard 命中（不建不执行 + 建前调用序列 `[rev-parse, add]` 即止）；⑥ 幂等（注册表 porcelain：3 条注册 = 主树 + c1 + c2）；⑦ 非 git 仓库清晰报错；⑧ source 串含 cwd；⑨ 声明面（非叶子/非法值/`subagent`/`workflow`/缺 cwd）；⑩ 非终态失败不回收；⑪ 脏树取舍（提示 + 不删目录/分支）；⑫ id 穿越/非法引用名（`../../evil`、`frame.lock` → 安全化 + 注册表全在 `.worktree/` 内、仓库外无残留）；⑬ 卸载孤儿（干净删、脏留 + 告警给路径）；⑭ id 禁词（危险词与 `id_rsa` 形状 → 声明期拒绝 + 改 id 指引；不隔离叶子不受影响）；⑮ 崩后残留 prune（断言 prune 索引 < `-B` 索引）。
- **反向验证三处变异**：撤建（ensure 直通）→ **11 例失败**（②③④⑤⑥⑦⑩⑪⑫⑬⑮），3 例通过（①⑨⑭ 不依赖建）；撤终态钩子（`terminalNotice` 返回 undefined）→ ③④⑪ 失败（⑬ 仍绿＝卸载走 `reclaimAll` 独立入口）；`reclaim` 整体置空 → ③④⑪⑬ 失败。三态均已还原，还原后 109/109。
- **补充命令结论**：`task-engine` `smoke:executor` → **25 PASS + SMOKE_PASS**；`format` 已对 5 个改动文件 + 2 个 md 执行。
- **安全化规则（最终）**：leafId 非 `[A-Za-z0-9_-]` → `_`；被清洗过则追加 sha1 前 8 位防撞名；建前断言 `resolve(root, seg)` 落在 `<repo>/.worktree/` 之内（前缀 + sep 校验），不满足拒绝执行。
- **回收顺序（最终）**：注册表 `worktree list --porcelain`（不在册＝已回收，幂等）→ 目录不在但注册残留 → `prune` → 目录在 → `status --porcelain` 非空＝**保留现场**（路径 + 取回提示 + 跳过 `branch -D`）→ 干净才 `remove`（**永不 `--force`**）→ 成功才 `branch -D`（分支不在＝视为成功，不依赖本地化文本）。guard 命中（含回收命令被拦）一律回执原文 + 保留现场。
- **未覆盖的终止路径（口径修正）**：abort/resume 把在途帧回收为 `pending` 时**不回收**（重入按注册表复用现场，**属设计而非遗漏**）；跨进程重启后内存 `held` 丢失、不主动回收（靠注册表复用 + prune）；回收失败/脏树现场不自动清理；unload 有 best-effort 兜底（干净删、脏留并告警）。
- **补充残余**：隔离区**无 `node_modules`**（未做软链/安装）；真机 DSH（真宿主 + 真 subagent）未跑 —— 验证方式是「真实 git + 临时仓库 + 假宿主面 `apply` 接线」+ dist 级 smoke。
