# task-engine 命令执行期无复查（接取条目：`docs/BACKLOG.md`「task-engine 命令执行期无复查（同类残余）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

`task_execute` / `task_stop` 执行的命令**只在声明处**（`task_decompose`）过 security-guard；引擎执行时直接 `runShell`（`task-engine/src/main.ts` 的 `runCommand`）与 `acceptance.ts` 执行 `acc.command`，**执行期无检查点**（`grep -rn "inspectCommand\|get('guard')" task-engine/src` 为空）。要补「执行前复查」，复用现成 `GuardEngine.inspectCommand(command, source)`（metric-loop 条目已落地该 API + `provide("guard")` 服务面）。

## 调研

- **命令来源**：`children[].executor.command`（叶子执行）与 `root.acceptance[].command`（mechanical 验收）；后者**不在** `task_decompose` 登记的 `commandPaths` 内（`PLUGIN_COMMAND_TOOLS` 只登记 `children[].executor.command` 与 `children[].acceptance[].command`）→ 执行期复查要**两处都覆盖**。
- **不需要**同步 `unknownToolPolicy` 的键深口径（本路径命令来自显式路径/登记表，不走未登记工具的键名启发）。
- 注入面：`task-engine` 已 `inject: ["tools", ...]`；guard 经 `provide("guard")` 暴露，**惰性 `ctx.get("guard")`**，缺失 fail-open（与 metric-loop 同口径）。

## 决策

- **D1（检查点）**：命令**执行之前**各插一次复查 —— ① 叶子执行（命令后端）；② mechanical 验收（`acc.command`）。共用一个 helper（如 `#checkCommand(cmd, source)`）：`ctx.get("guard")` → `inspectCommand(cmd, source)`；命中即**不执行**，把回执原文作为失败原因（`ok:false` / 验收不通过）；`source` 形如 `task-engine{executor} <frameId>`、`task-engine{acceptance} <frameId>`。
- **D2（fail-open 粒度）**：guard 未挂载或调用抛错 → **告警一次** + 放行（不得让既有流程失败）；抛错**不**每次告警（避免刷屏）。
- **D3（不做）**：不改 `task_decompose` 的声明处检查；不给 `workflow` 的 `script` 上命令层（JS 编排，与 guard 条目同口径）；不新增工具/配置项；不改其它包。
- **D4（测试）**：① 危险命令（**拼接构造**）在执行前被拦 —— 命令**未执行**（探针文件不存在）、返回 `ok:false` 且回执含规则 id 与来源标注；② 普通命令照常执行（值/探针正常）；③ guard 缺失（假 ctx 无 `get("guard")`）→ 放行 + 只告警一次；④ 验收路径同样被拦；⑤ 既有用例不回归（含 `execute → stop → join`）。
- **D5（反向验证）**：撤掉检查 → ①④ 必失败（两态）。
- **D6（文档）**：`task-engine/README.md` 边界段补一句「执行期复查（需 guard 挂载；未挂载 fail-open + 一次告警）」；`docs/BACKLOG.md` 顺带在 `#2`（worktree 隔离）描述里保留「不需同步键深口径」的说明。
- **D7（验证）**：`task-engine` check/build/test + 根 check/test/build + `format`；**真机**（优先）：`task_decompose` 声明含危险命令的任务 → `task_execute` 应被拦；若真机不便，给 dist 级端到端探针证据并记为残余。

## 计划改动文件清单

- `task-engine/src/{main,acceptance}.ts`（执行缝）+ `task-engine/tests/*` + `task-engine/README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「决策」。
1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02）

- `src/main.ts`：新增导出 `makeCommandGuard(ctx, warn)`（惰性 `ctx.get("guard").inspectCommand(command, source)`；**缺失/抛错各只告警一次** + fail-open，两个独立 once 标志按插件实例）；executor 的命令后端在 `runShell` **之前**复查（`source` = `task-engine{executor} <frame>`），命中 → `{ok:false, retryable:false}` + 回执原文；`apply` 把 `runShell` 包成 guarded `runCommand`（`source` = `task-engine{acceptance} <frame>`，命中 → `{code:1, output:回执, blocked:true}`）；文件头注释同步。
- `src/acceptance.ts`：`runCommand(cmd, frame?)` + `blocked?: boolean`；`judgeAcceptance` 传 `frameId`，`blocked` 即 `pass:false` + 回执原文（不按退出码措辞）。
- 新增 `tests/exec-guard.test.ts`（11 例，**5 例经真实 `apply(fakeCtx)` 接线**）；`README.md` 与 `docs/DESIGN.md` 边界段补「执行期复查（需 guard 挂载；未挂载 fail-open + 一次告警）」。
- `security-guard/README.md`（父会话）：检查点边界 bullet 补 task-engine 执行期复查与两条已知边界；`inspectCommand` 入口补调用方。

## 测试与证据（2026-10-02）

- `task-engine`：`check` exit 0、`build` exit 0、**95/95 全绿**（改前 84 → +11）；`npm run smoke:executor` → **SMOKE_PASS**。
- **逐缝反向验证两态**：撤 executor 缝检查 → **4 例失败**（① ② ③ ③′），④ 仍通过；撤验收缝检查 → **2 例失败**（④ 两条），① 仍通过；还原后 11/11 + 95/95（diff byte-identical）。
- **dist 级端到端探针**（真 dist + 真 `/bin/sh` + 假 guard 服务面，两缝）：`GUARD_PROBE_PASS (10/10)`。
- 无半成品帧：executor 命中后帧仍 `pending`、可 `task_implement` / `task_stop` 取回；验收命中落 `acceptance-verdict(pass:false)` 并 `rejectFrame`；`recent()` 可见 `task-engine{executor} c1`。
- 全仓：`npm run check` exit 0、`npm run test` **20 包全 `fail 0`**、`npm run build` exit 0（父会话复跑）。

## 审阅（子代理 `817e5464`）——结论：**有条件通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| P1-1 D7 真机步骤**不可行会假通过**（危险命令在 `task_decompose` 声明处即被拦，`declare_denied=true`，到不了 `task_execute`） | 已改口径：executor 缝用源码/dist 级探针留证；**验收缝**走 Config 侧 `root.acceptance[].command`（不经声明工具）——测试 ④ 已按此实现；真机限制记入残余 |
| P1-2 若测试只用注入 mock/只调导出符，撤掉接线不会失败（D5 退化） | 已满足：**5 例经 `apply(fakeCtx)`**，逐缝撤除均命中预期失败 |
| P2-1 D4 缺「guard 抛错」档 | 已补 ③′（抛错不冒泡、命令照常执行、告警恰好 1 条） |
| P2-2 抛错后**完全静默放行** | 已并入 BACKLOG `#3` 扩写（要求两包统一「抛错一次告警 + 计数」或写进事件流） |
| P2-3 文档同步清单不全 | 已补：`task-engine/docs/DESIGN.md`、`main.ts` 文件头、`security-guard/README.md`（父会话） |
| P3-1 D6「保留键深说明」措辞错（全文无该词） | 已改为在 `#2` 描述里**追加**（含「不需同步键深口径」「复用 makeCommandGuard」「cwd 不在 source 里」三条） |
| P3-2 与 `#2` 交互（易出第三份 `makeCommandGuard` 拷贝；`cwd` 不进 source） | 已写入 `#2` 描述 |
| 范围外观察：TUI `$` 模式执行面不经 guard | 已立项 BACKLOG `#7` |

- 审阅确认的事实：全包**唯一 OS 原语** `execFile("/bin/sh", ["-c", cmd])`，两条生产链均已覆盖、无未包装调用；`workflow` 的 `script` 不经本包 shell；`inspectCommand` 与 `bash` 同规则口径（含 `extractCommandPaths`）。

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① **真机未跑**（沙箱对 `~/.dsh/profiles/fff` 只读，`dsh headless`/`--dump-config` 均 EROFS）——建议用 `dsh headless --patch <repo 内 overlay>`（overlay `- insert:` 挂 security-guard + task-engine，task-engine config 给一条拼接构造的验收命令），断言根验收不通过且探针文件不存在；② executor 缝在真机上由声明处覆盖，执行期为其**纵深防御**；③ `tmp/exec-guard-probe.mjs` 保留可复跑（不在 git 跟踪内）。
