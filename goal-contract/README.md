# @dsh-toolset/goal-contract

DSH（DeepSeek Harness）进程内插件：goal 会话契约起草。经 `tool-ask-user` 面访谈（或参数预填）得到「目标 + Done-when 验证条款」，把条款嵌入 objective 并落 dsh-goal 事件源（`goal/change`），再回读当前 goal 视图做往返比对。

## 能力

注册工具 `goal_contract_draft`：

| 参数 | 说明 |
| --- | --- |
| `objective` | 目标描述（预填；缺省时访谈提问）。不得包含独占一行的 `Done-when:` |
| `clauses` | 结构化条款预填：`[{ id, check, level, command?, outputSchema? }]`（输入 `output_schema` 亦可，归一为 `outputSchema`） |
| `clauses_text` | 自由文本条款（每行一条：`描述`、`描述 → 命令` 或 `[<level>] 描述`）；与 `clauses` 二选一 |
| `max_goal_rounds` | goal 回合上限（正整数，缺省由宿主决定） |

行为：`objective` 与条款齐备时直接创建（非交互路径）；缺任一则逐题访谈（目标 → 条款 → 确认），同阶段校验失败最多重问 3 次，确认题选「取消」即中止。创建成功后回读 `ctx.goals.get(agent)`，解析 Done-when 段并与起草条款比对，返回：

```jsonc
{ "ok": true,
  "goal": { "id": "goal-...", "revision": 1, "maxGoalRounds": 8, "roundsStarted": 0 },
  "contract": { "objective": "...", "clauses": [] },
  "objective_full": "<objective + Done-when 段>",
  "readback": { "objective": "...", "clauses": [], "match": true } }
```

条款 schema 对齐 task-engine 的 `Acceptance`（本包不依赖 task-engine，跨插件通信只经宿主 ctx 服务面）：`id` 非空且唯一、`check` 非空、`level` 显式给出且 ∈ `mechanical` / `semantic` / `human`、mechanical 必须带非空 `command`、条数不超过 32。

`clauses_text` 与访谈自由文本的解析口径：整段以 `[` 开头则按 JSON 数组校验；否则逐行解析（跳过空行与 `#` 注释），`描述 → 命令`（或 `描述 -> 命令`）判为 mechanical，`[mechanical] 描述` 可显式指定层级，既无命令也无层级前缀则判为 human，`id` 自动编号 `c1`…`cN`。

条款以 `Done-when:` 标记段（条款 JSON 数组）嵌入 goal 的 objective 文本——官方 `GoalSnapshot` 无独立契约字段；回读时从该段解析还原。

## 配置

无 bundle 配置字段；依赖宿主服务（`inject: ["tools", "userQuestions", "goals"]`），经 `ctx.get(...)` 取用、直连属性回落。服务缺失时降级：`userQuestions` 缺失则访谈不可用（预填路径不受影响），`goals` 缺失则返回 `ok: false` 并说明原因。

## 使用示例

工具调用（全量预填，非交互）：

```jsonc
{
  "objective": "给 TUI 增加 /loop 面板",
  "clauses": [
    { "id": "c1", "check": "npm run check 退出 0", "level": "mechanical", "command": "npm run check" },
    { "id": "c2", "check": "人工确认面板渲染与停止语义", "level": "human" }
  ],
  "max_goal_rounds": 8
}
```

profile 挂载（smoke 幂等引导独立 profile `goal-contract`，与本包同挂 task-engine）：

```sh
dsh --profile goal-contract --from-default-profile headless --dump-config
dsh plugin --profile goal-contract add '@dsh-toolset/goal-contract@link:<本包路径>'
dsh plugin --profile goal-contract add '@dsh-toolset/task-engine@link:<task-engine 路径>'
```

## 边界与限制

- 只负责「起草 → 落 goal → 条款回读」；条款的判定执行（mechanical 跑命令 / semantic 审计 / human 审批）由 task-engine 的验收阶段承担。
- 已有 goal 时 `goals.create` 失败（如 `GOAL_ALREADY_EXISTS`）原样透传为 `ok: false`。
- headless 会话无 UI answerer 时 `ctx.userQuestions.ask` 以 `NO_PROVIDER` 失败，工具返回可操作反馈（改预填 objective / clauses 重试）。
- `objective` 含独占一行的 `Done-when:` 时拒绝创建（回读边界歧义）。
- 所有失败路径返回 `{ ok: false, error }`，不向宿主抛异常。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # 编译到 dist/
npm run test    # node --test（35 例：访谈状态机 / 条款校验 / goal 事件落地与回读）
npm run smoke   # 真实 dsh 会话联调（需 dsh 0.1.5-rc.2 与模型凭据）
```
