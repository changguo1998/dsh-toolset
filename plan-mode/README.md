# @dsh-toolset/plan-mode

DSH（DeepSeek Harness）进程内集成插件：把 **plan 模式三段流程**（探索 → 计划 → 实施）做成流程定义，与 `flow-track` 平级的流程定义插件（决策项 6），并在探索 / 计划段做**写面拦截**与**权限预设切换**（只读，多一道宿主沙箱兜底）。

职责边界（与 task-engine 的分工）：

| 方 | 负责 |
| --- | --- |
| 本包（流程定义方 + 写面守卫） | 定几个节点、每个节点做什么（spec / 验收 / 粒度 / 前置 / 顺序强制），提供入口工具 `plan_start`；探索 / 计划段拦截写类工具、切 `read-only` 预设、注入阶段约束 |
| task-engine（节点基础工具） | 按节点数组建树（`composeFromNodes`）、顺序强制校验、验收裁决、状态机与查询 |
| pin-note（动态保持） | 阶段注入与轮询恢复的 carrier（`pinNotes.hold("plan-mode")`） |
| flow-arbiter（流程仲裁） | 会话级选中与入口裁决（切走时本包恢复预设） |

## 三段定义

| 段 | spec | 验收 | 粒度 |
| --- | --- | --- | --- |
| 1 探索 | 摸清现状与约束并列出候选方案 | 语义级：结论写出现状 / 约束 / 候选取舍 | `needDecompose: true`（可再拆） |
| 2 计划 | 给出改动清单与验收口径 | **human**：人工确认计划后再进实施 | `needDecompose: true` |
| 3 实施 | 按计划改动并跑验证 | 语义级：改动与已确认计划一致且验证通过 | `needDecompose: true` |

三段都声明 `enforceOrder`：前序段未完成时 task-engine 拒绝后续段的 `task_implement` / `task_execute` / `task_stop`（同父兄弟序列内强制）。

## 写面拦截（探索 / 计划段只读）

- 挂 `tools/pre-execute`，按会话映射（`plan_start` 建树时登记）与当前段判定：
  - 探索 / 计划段拒绝写类工具，回执 `info.code === "plan_stage_readonly"`，并写明当前段、为什么不能写、下一步做什么；
  - 计划段人工确认（done）后放行，实施段全程放行；
  - `flow_select` / `plan_start` / `task_*` 等任务面工具不受影响（流程推得动）。
- 命令白名单（决策项 9，`shell-parse` 解析，认不出放行）：重定向 `>` / `>>` / `&>`、`tee`、`sed -i` / `perl -i`、`mv` / `cp` / `rm` / `mkdir` / `touch` / `truncate` / `dd`、`python -c`。
- 工具分类：`bash` / `shell` / `pwsh` / `herdr_run` / `herdr_text` 按命令白名单判；`run_code` / `script_run`（代码体判不出）与 `workflow` / `task_execute`（派生会话里拦不住）一律拒；直接写面（`write` / `edit` / `apply_patch` / `patch` / `hash_edit`）恒拒。
- 带写开关的工具按开关判：`ast_replace` 不带 `write: true` 是 dry-run，`md_logic` 非 `replace` 只读，都不拦。

## 权限预设切换与恢复

- 进入（`plan_start` 建树成功）：切到 `read-only` 并记住进入前的预设；二次进入沿用首次记录的原预设（决策项 10），不把上一次设的 `read-only` 记成原值。回执带 `presetSwitched` / `presetNote`。
- 恢复点（决策项 8）：计划段到终态（完成或失败）恢复原预设并保留映射（实施段仍能报段位）；切走 / 树完成 / 会话结束 / 插件卸载恢复并清映射。
- 轮询：计划段终态与切走没有宿主事件可听，挂在 `pinNotes.hold("plan-mode")` 的 provider（每步一次、带 `sessionId`）上查快照与 `flowArbiter.current`。
- 覆盖保护：`restored` 为假而当前预设已被手动改过时，跳过 `set`、只清记录并告警，不拿旧值覆盖用户的选择。

## 阶段注入

探索 / 计划段注入只读原因与下一步，实施段注入已放行，未知段不输出（与轮询共用同一个 provider）。

## 降级

- `tools` 是硬依赖（装配期注册工具面，`inject: ["tools"]`）。
- `taskEngine` 缺席：`plan_start` 返回 `{ ok: false, error: "task_engine_unavailable", message }`，其余功能不受影响。
- `permissionPresets` 缺席 / 预设名不含 `read-only` / 原值 `custom`（切了恢复不回去）/ `set` 抛错：不切预设，只靠本仓拦截，回执与告警注明「权限面未切换」。
- `pinNotes` 缺席：无阶段注入也无轮询恢复，只剩会话结束与插件卸载两条恢复入口；实施段会一直停在只读，告警一次。
- `flowArbiter` 缺席：「切走」恢复不生效，其余恢复入口不变。
- `ctx.on` / `ctx.provide` 缺席：对应功能（拦截 / 服务面）不生效并告警，不阻断启动。

## 插件 id

bundle 里的插件 id 是 **`plan-mode-track`**（见 `cordis.patch.yml`）：官方 `@deepseek-ai/dsh-plan-mode` 已占用 `plan-mode` 这个 id（默认停挂见 `profiles/example/cordis.patch.yml`），同名会撞 id。
