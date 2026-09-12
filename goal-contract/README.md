# @dsh-toolset/dsh-goal-contract

DSH（DeepSeek Harness）goal 会话契约起草插件：interview 式提问（经
`tool-ask-user` / `ctx.userQuestions` 面）起草「目标 + Done-when 验证条款」，
经官方 `dsh-goal` 服务（`ctx.goals`）落 **goal 事件源**（`goal/change` 会话
事件），并回读当前 goal 视图解析条款做往返比对。

## 契约

- **条款 schema** 字段对齐 `task-engine` 的 `Acceptance`（三级验收）：
  `{ id, check, level: mechanical | semantic | human, command?, outputSchema? }`
  （mechanical 必须带可执行 `command`）。
- **无 npm 级耦合**：本包不依赖 `task-engine`（也不 import `@deepseek-ai/cordis`，
  dsh workspace 包）；schema 通过对齐源文件获得，运行时只经宿主
  `ctx.get(...)` / 直连属性面取 `userQuestions` / `goals` 服务。
- **条款持久化**：官方 `GoalSnapshot` 无独立契约字段，条款集以机器可读的
  `Done-when:` 标记段（条款 JSON 数组）嵌入 goal 的 `objective` 文本；
  回读时从 `ctx.goals.get(agent)` 的 objective 解析还原。

## 工具

`goal_contract_draft`（model 侧）：

| 参数 | 说明 |
| --- | --- |
| `objective` | 目标描述（预填；缺省时访谈提问） |
| `clauses` | Done-when 条款（结构化预填，字段见上） |
| `clauses_text` | Done-when 条款（自由文本，每行一条：「描述」或「描述 → 命令」；与 `clauses` 二选一） |
| `max_goal_rounds` | goal 回合上限（缺省宿主 256） |

行为：`objective` 与 `clauses` 齐备 → 直接创建；缺任一则逐题访谈
（目标 → 条款 → 确认，`ask_user` 单选确认，每阶段最多重问 3 次）。
创建成功后回读当前 goal 视图，解析 Done-when 段并与起草条款比对，
返回 `{ ok, goal: {id, revision, ...}, contract, objective_full, readback: { clauses, match } }`。

## 本地迭代

```sh
npm run check   # tsc --noEmit
npm run test    # node --test（interview 状态机 / 条款校验 / goal 事件落地）
npm run build   # dist/
npm run smoke   # 真实 dsh 会话（独立 profile dsh-goal-contract）
```

迭代回合：改代码 → `npm run build` → 重启挂本 profile 的 `dsh` 会话。

## 挂载到 profile（独立 profile 示例）

smoke 幂等引导 `~/.dsh/profiles/dsh-goal-contract`：headless 默认 profile
创建 → `dsh plugin --profile dsh-goal-contract add '@dsh-toolset/dsh-goal-contract@link:<worktree>/goal-contract'`
→ 同挂 `@dsh-toolset/dsh-task-engine`（link）。手工挂载等价命令：

```sh
dsh --profile dsh-goal-contract --from-default-profile headless --dump-config
dsh plugin --profile dsh-goal-contract add '@dsh-toolset/dsh-goal-contract@link:<本包路径>'
dsh plugin --profile dsh-goal-contract add '@dsh-toolset/dsh-task-engine@link:<task-engine 路径>'
```

## 边界

- 本插件只负责「起草 → 落 goal → 条款回读」；条款的判定执行（mechanical 跑
  命令 / semantic 审计 / human 审批）由 `task-engine` 的验收阶段承担。
- headless 会话无 UI answerer 时 `ctx.userQuestions.ask` 会以 `NO_PROVIDER`
  失败（宿主行为），工具会给出「改预填 objective/clauses 重试」的明确反馈。
