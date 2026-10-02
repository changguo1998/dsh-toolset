# `security-guard` 命令层旁路（接取条目：`docs/BACKLOG.md` #4）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

`metric_loop{measureCmd}`（`metric-loop/src/measure.ts:9-49`）与 task-engine 的 command 后端（`task-engine/src/main.ts:80-87,665`）用系统 shell 执行**模型给的命令串**，但工具名既不在 `SHELL_TOOLS` 也不在 `PLUGIN_FILE_TOOLS` → 命令黑名单层完全未覆盖（上一条目审阅实测：危险命令与读敏感路径的命令在 `measureCmd` 下放行，而 `bash` 同文本被拦）。要按同一描述符机制给命令参数面加覆盖，或明确记为已知边界。

## 调研（2026-10-02）

- 机制现状（`security-guard/src/index.ts`）：`SHELL_TOOLS` → `read-write` 且抽取命令文本过命令黑名单层；`PLUGIN_FILE_TOOLS` 描述符表（pathKeys / pathArrayKeys / writeWhen）+ `pluginFileTool()` + `pluginFilePaths()`；未登记工具 `return null`。
- 待覆盖的命令面（实现时逐一读码核实）：
  - `metric_loop`：`{ action: "start", measureCmd }` —— `measureCmd` 为顶层 string，经 shell 执行。
  - task-engine：`task_execute` 的 executor spec 里可能有 `{ executor: { kind: "command", command } }`（**嵌套**，需读码确认键路径）；`task_stop` 的 mechanical 验收命令来自**帧契约**（`acceptance[].command`），非模型入参 → 见 D4。
  - 其它可能执行模型命令的插件工具：实现时 grep `/bin/sh` / `execFile` / `spawn` 各包。
- 命中面：命令黑名单层（`commandBlacklist.enabled` / `rules` / `allowPatterns`）+ 命令文本里的路径抽取（`extractCommandPaths`）过敏感文件层。

## 决策

- **D1（登记表）**：新增 `PLUGIN_COMMAND_TOOLS: Record<string, { commandKeys: readonly string[]; nestedKeys?: readonly string[] }>`（键名与嵌套形态以实现时读码为准）：先登记 `metric_loop → ["measureCmd"]`；task-engine 若确为嵌套则用 `nestedKeys`（如 `["executor","command"]`）声明，读码后按真实结构登记或明确不登记并说明理由。
- **D2（判定与提取）**：分发处对 `PLUGIN_COMMAND_TOOLS` 命中的工具：按 `commandKeys` / `nestedKeys` 提取命令文本（string 才收），走与 `SHELL_TOOLS` **同一**命令黑名单层与路径抽取（`allowPatterns` 同样生效）；工具名仍在 `PLUGIN_FILE_TOOLS` 时两套都走（互不覆盖）。
- **D3（测试）**：`security-guard/tests/guard.test.ts` 追加：① `metric_loop{measureCmd:<危险命令>}` → 拦（回执含工具名与规则）；② 普通命令（如 `echo ok`）→ 放行；③ 命令文本里含敏感路径 → 敏感层拦；④ 未登记命令工具 / `measureCmd` 非 string / 缺失 → 放行；⑤ 既有 `bash` 与官方工具用例回归。
- **D4（不做／另记）**：task-engine 的 **mechanical 验收命令**来自帧契约（模型经 `task_decompose` 写进 `acceptance[].command`，但执行发生在 `task_stop`；命令文本已在契约里，且引擎侧已有 `commandTimeoutMs`）——是否纳入需评估「模型可间接写命令」的等价性；本次**至少**在 README 写明该边界并记 BACKLOG 观察项（若实现时能低成本覆盖则一并覆盖 `task_decompose` 的 `acceptance[].command`）。
- **D5（文档）**：`security-guard/README.md` 覆盖清单补「插件命令面（`metric_loop.measureCmd` 等）」与边界声明；条目关闭。
- **D6（验证）**：`security-guard` check/build/test（+N 例）；反向验证（临时移除命令登记 → 新增 deny 用例必失败）；全仓 `check` / `build` / `test`。

## 计划改动文件清单

- `security-guard/src/index.ts`、`security-guard/tests/guard.test.ts`、`security-guard/README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 实现记录（已落盘，待审阅后收尾）

`security-guard/src/index.ts`：新增 `PLUGIN_COMMAND_TOOLS` 登记表 + `pluginCommandTool()`（`Object.hasOwn`，原型链属性名视同未登记）+ 命令面判定/提取接线（命令文本走与 `bash` **同一**命令黑名单层与路径抽取，`allowPatterns` 生效；回执前置来源标注「拦截来源：插件命令工具「X」的命令参数（键路径）」）。

登记清单（**实现读码后的真实参数面**，比决策 D1 更完整）：

- `metric_loop` → `commandKeys: ["measureCmd"]`（`action=start` 时经 `/bin/sh -c` 执行）
- `task_decompose` → `commandPaths: ["children[].executor.command", "children[].acceptance[].command"]`
  —— **检查点落在声明处**：命令文本出现在 `task_decompose` 的 children 契约里，而执行发生在
  `task_execute` / `task_stop`（那两个工具的入参只有 `task_id`，不含命令文本）。这同时覆盖了决策 D4
  的「mechanical 验收命令」边界（低成本即覆盖，无需另开观察项）。

`security-guard/README.md`：命令黑名单行补插件命令参数面；新增「插件命令面」条目（含检查点说明与来源标注口径）；「未登记工具仍不拦」边界补两张登记表清单与「只覆盖登记的参数键」说明；回执示例补插件命令工具一例。
`security-guard/tests/guard.test.ts`：新增 6 例（57 = 51 + 6）。

## 测试与证据（2026-10-02）

- `security-guard` **57 例全绿**（`npm run check` exit 0）。
- **反向验证（本轮自查）**：把 `PLUGIN_COMMAND_TOOLS` 临时清空 → **54 pass / 3 fail**（失败恰为命令面 deny 用例）；还原后 57/57（还原自备份副本，字节一致）。
- 全仓：`npm run check` exit 0、`npm run build` exit 0、`npm run test` **20 包全绿**。

## 审阅（子代理，2026-10-02）——结论：**有条件通过**

实测：同一危险命令文本在 `bash` / `metric_loop.measureCmd` / `task_decompose` 的两条嵌套命令路径上**均被同一规则拦截**（来源标注区分 shell / 插件）；真实 `MetricLoopController` + 注入 measure 探针门控验证（危险命令被拦 → measure 0 次调用；`echo 42` 放行 → 1 次）；14 个非 string / 缺失 / 非数组变体全放行（且引擎侧本就拒绝，不会执行）；全仓 child_process 清点确认**无其它模型可达 shell 面**。

| 审阅发现 | 处置 |
|---|---|
| 【中】**P1 状态文件间接旁路**：`metric_loop` 的 `tick` 执行的命令取自状态文件（不在工具入参里）→ 本层看不到（实测 `tick` ALLOW 且 measure 收到危险文本） | 已在 README「边界与限制」补明确条目（含加固方向）；**执行前复查黑名单**记为项目级新条目 |
| 【低】P2 README 快照措辞失准（`snapshotPath` 只写不读；恢复是 `resumeFromSnapshot`，插件未接线） | 记入项目级新条目（文档修正） |
| 【低】P3 宿主日志首行丢规则 id（插件命令工具回执首行是来源标注行） | 记入项目级新条目 |
| 【低】P4 测试缺口：命令层+敏感层同命中用例、`allowPatterns` 对插件命令层**正向**放行断言 | 记入项目级新条目 |
| 提示（非缺陷）两处过度保守：非 start action 带 `measureCmd` 也拦、`executor` 无 `kind` 但带 `command` 也拦 | README 已声明「宁可误拦」，保留 |
| 未验证残余：subagent / audit / entail 子会话内部工具调用是否同走 `tools/pre-execute`；真机会话级端到端 | 记残留（下一轮或另条目） |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理；追踪文档移入 `docs/archived/`。
- 残留：① P2/P3/P4 与「执行前复查」——新条目；② 子会话内部调用是否同走 pre-execute 未验；③ 真机会话级端到端未验。
