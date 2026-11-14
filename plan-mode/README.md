# @dsh-toolset/plan-mode

DSH（DeepSeek Harness）进程内集成插件：把 **plan 模式三段流程**（探索 → 计划 → 实施）做成流程定义，与 `flow-track` 平级的流程定义插件（决策项 6）。

职责边界（与 task-engine 的分工）：

| 方 | 负责 |
| --- | --- |
| 本包（流程定义方） | 定几个节点、每个节点做什么（spec / 验收 / 粒度 / 前置 / 顺序强制），提供入口工具 `plan_start` |
| task-engine（节点基础工具） | 按节点数组建树（`composeFromNodes`）、顺序强制校验、验收裁决、状态机与查询 |
| pin-note（动态保持） | 把 task-engine 取出的当前节点内容保持在上下文 |

本包**不注入上下文**，也不持有流程开关（流程选择由 `flow-arbiter` 统一仲裁）。

## 三段定义

| 段 | spec | 验收 | 粒度 |
| --- | --- | --- | --- |
| 1 探索 | 摸清现状与约束并列出候选方案 | 语义级：结论写出现状 / 约束 / 候选取舍 | `needDecompose: true`（可再拆） |
| 2 计划 | 给出改动清单与验收口径 | **human**：人工确认计划后再进实施 | `needDecompose: true` |
| 3 实施 | 按计划改动并跑验证 | 语义级：改动与已确认计划一致且验证通过 | `needDecompose: true` |

三段都声明 `enforceOrder`：前序段未完成时 task-engine 拒绝后续段的 `task_implement` / `task_execute` / `task_stop`（同父兄弟序列内强制）。

## 工具面

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `plan_start` | `parent_id?`（缺省当轮根） | 按三段定义一次性建树：内部调 `taskEngine.composeFromNodes`（走 task-engine 既有双门禁），返回 `flow` / `nodes`（三个帧 id）/ `accepted` / `next` |

建树之后：段内细化用 `task_decompose`（三段都可再拆）、段完成用 `task_stop`（计划段的 human 门禁走审批链）、查树用 `task_status`。

## 降级

- `tools` 是硬依赖（装配期注册工具面，`inject: ["tools"]`）。
- `taskEngine` 可选：缺席或未暴露 `composeFromNodes` 时 `plan_start` 返回
  `{ ok: false, error: "task_engine_unavailable", message }`，其余功能不受影响。

## 插件 id

bundle 里的插件 id 是 **`plan-mode-track`**（见 `cordis.patch.yml`）：官方 `@deepseek-ai/dsh-plan-mode` 已占用 `plan-mode` 这个 id（默认停挂见 `profiles/example/cordis.patch.yml`），同名会撞 id。
