# @dsh-toolset/goal-contract

DSH（DeepSeek Harness）进程内插件：goal 会话契约起草。经 `tool-ask-user` 面访谈（或参数预填）得到「目标 + Done-when 验证条款」，把条款嵌入 objective 并落 dsh-goal 事件源（`goal/change`），再回读当前 goal 视图做往返比对。

## 能力

注册工具 `goal_contract_draft`：

| 参数 | 说明 |
| --- | --- |
| `objective` | 目标描述（预填；缺省时访谈提问）。**首行必须是一句话概括**且 **≤40 显示列**（约 20 个汉字 / 40 个英文字符）——状态列只显示首个逻辑行（行数由列宽决定，不截断），全文经宿主 `/goal` 命令输出读；超限在起草阶段报错（访谈路径重问、预填路径直接失败）。不得包含独占一行的 `Done-when:` |
| `clauses` | 结构化条款预填：`[{ id, check, level, command?, outputSchema? }]`（输入 `output_schema` 亦可，归一为 `outputSchema`） |
| `clauses_text` | 自由文本条款（每行一条：`描述`、`描述 → 命令` 或 `[<level>] 描述`）；与 `clauses` 二选一 |
| `max_goal_rounds` | goal 回合上限（正整数；缺省不传、由宿主决定，自动化场景建议给小值） |

行为：`objective` 与条款齐备时直接创建（非交互路径）；缺任一则逐题访谈（目标 → 条款 → 确认），同阶段校验失败最多重问 3 次（含「首行概括 > 40 显示列」），确认题选「取消」即中止。创建成功后回读 `ctx.goals.get(agent)`，解析 Done-when 段并与起草条款比对，返回：

```jsonc
{ "ok": true,
  "goal": { "id": "goal-...", "revision": 1, "phase": "…", "maxGoalRounds": 8, "roundsStarted": 0 },
  "contract": { "objective": "...", "clauses": [] },
  "objective_full": "<objective + Done-when 段>",
  "readback": { "objective": "...", "clauses": [], "match": true } }
```

**流程与落点**（实现见 `src/interview.ts` / `src/tool.ts`）：

- **访谈**：三阶段状态机 `ask-objective → ask-clauses → ask-confirm`（纯函数，无宿主依赖）；每阶段向宿主 `ctx.userQuestions.ask` 提交**单题**（透传 `agent` 与 `signal`），答案映射回状态。预填字段跳过对应提问；`objective` 与条款齐备时直接转 `done`、不追问确认（headless 无 UI answerer，smoke 依赖这条非交互路径）。同阶段校验失败把错误拼进下次提问重问，累计 3 次超限转 `aborted`（防无限循环）；`done` / `aborted` 为终态。
- **落点（dsh-goal 事件源）**：`ctx.goals.create(agent, { objective: <objective + Done-when 段>, maxGoalRounds? })`——写的是官方 `goal/change` 会话事件（durable）；本包不自行 append 事件，TUI 状态列与 `/goal` 读的是同一 goal 面。
- **回读比对**：`ctx.goals.get(agent)` 取当前 goal 视图（服务未暴露 `get` 时回落 `create` 返回值）→ `parseContract` 还原条款 → `clausesEqual` 深比较得 `readback.match`；回读解析异常不翻转 `ok`，以 `readback.error` 说明（失败仍拿到创建结果）。

条款 schema 对齐 task-engine 的 `Acceptance` / `AcceptanceLevel`（`task-engine/src/types.ts`；本包字段见 `src/types.ts` 的 `ContractClause` / `ClauseLevel`；两包无代码依赖，跨插件通信只经宿主 ctx 服务面）：`id` 非空且唯一、`check` 非空、`level` 显式给出且 ∈ `mechanical` / `semantic` / `human`、mechanical 必须带非空 `command`、条数不超过 32。三级语义与 task-engine RET 验收同口径：mechanical = 验收命令退出码 0 即过 / semantic = 结构化裁决（`outputSchema` 可选，宿主侧校验）/ human = approval 链人工确认；**判定执行由 task-engine 的验收阶段承担**，本包只做起草与回读。

`clauses_text` 与访谈自由文本的解析口径：整段以 `[` 开头则按 JSON 数组校验；否则逐行解析（跳过空行与 `#` 注释），`描述 → 命令`（或 `描述 -> 命令`）判为 mechanical，`[mechanical] 描述` 可显式指定层级，既无命令也无层级前缀则判为 human，`id` 自动编号 `c1`…`cN`。

条款以 `Done-when:` 标记段（条款 JSON 数组）嵌入 goal 的 objective 文本——官方 `GoalSnapshot` 无独立契约字段；回读时从该段解析还原。

## 配置

无 bundle 配置字段；宿主服务经 `inject: ["tools", "userQuestions", "goals"]` 声明，取用与降级如下：

| 宿主服务 | 用途 | 缺失降级 |
| --- | --- | --- |
| `tools` | 注册 `goal_contract_draft` | `ctx.tools.register` 不可用 → stderr 告警、插件不做事，不抛错 |
| `userQuestions` | 访谈提问：`ask({ questions: [单题], agent?, signal? })` | 返回「宿主 userQuestions 服务不可用（tool-ask-user 未挂载）；请改为预填 objective 与 clauses 后重试」；提问调用抛错（如 headless 无 answerer 的 `NO_PROVIDER`）同口径给可操作反馈 |
| `goals` | 落 goal `create(agent, { objective, maxGoalRounds? })`；回读 `get(agent)` | 返回「宿主 goals 服务不可用（dsh-goal 未挂载），无法落 goal」 |

取用顺序为 `ctx.get("<name>")` 优先、直连属性（`ctx.userQuestions` / `ctx.goals`）回落——宿主面形状不固定，本包不 import `@deepseek-ai/cordis`（结构化最小型见 `src/types.ts`）。

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

profile 挂载（smoke 幂等引导独立 profile `dsh-toolset-goal-contract`，并同挂 task-engine 作共存验证——本包不使用其服务）：

```sh
dsh --profile dsh-toolset-goal-contract --from-default-profile headless --dump-config
dsh plugin --profile dsh-toolset-goal-contract add '@dsh-toolset/goal-contract@link:<本包路径>'
dsh plugin --profile dsh-toolset-goal-contract add '@dsh-toolset/task-engine@link:<task-engine 路径>'
```

## 边界与限制

- 只负责「起草 → 落 goal → 条款回读」；条款的判定执行（mechanical 跑命令 / semantic 审计 / human 审批）由 task-engine 的验收阶段承担。
- 只经模型工具 `goal_contract_draft` 暴露能力：不注册 slash 命令、不 provide ctx 服务（`goalContract` 取不到，TUI `/contract` 走内置同构回读）、无 CLI / 面板面。
- 不写 task-engine 的服务面，包间无 `link:` 依赖；运行期零依赖（`dependencies` 为空）。
- 一个会话同时只有一个 goal：`create` 撞上既有 goal 时把宿主错误码（如 `GOAL_ALREADY_EXISTS`）包进 `ok: false` 返回，不自动覆盖 / 追加。
- `max_goal_rounds` 仅透传宿主上限，本包不驱动续轮（续轮由宿主 goal 面负责，TUI 的 `⟳` 只展示其 armed / disarmed）。
- headless 会话无 UI answerer 时 `ctx.userQuestions.ask` 以 `NO_PROVIDER` 失败，工具返回可操作反馈（改预填 objective / clauses 重试）。
- `objective` 含独占一行的 `Done-when:` 时拒绝创建（回读边界歧义）。
- 所有失败路径返回 `{ ok: false, error }`，不向宿主抛异常。

## 文件结构与相关文档

```text
goal-contract/
  src/
    index.ts       # bundle 入口：name / inject / apply；注册 goal_contract_draft
    tool.ts        # 工具工厂：参数编译、访谈驱动、create / 回读编排（依赖注入，可单测）
    interview.ts   # 访谈状态机（纯函数：提问文案、答案迁移、重问上限）
    clauses.ts     # 条款校验 validateClauses + 文本解析 parseClauseText
    contract.ts    # Done-when 段嵌入 / 回读（buildObjective / parseContract / clausesEqual）
    types.ts       # 领域类型 + 宿主结构化最小型（不 import cordis）
  smoke/smoke.mjs  # 真实 dsh 联调（独立 profile，见「测试」）
  tests/           # node --test：clauses / contract / interview / tool
```

| 相关文档 | 关系 |
| --- | --- |
| `task-engine/README.md` | 条款 schema 的对齐源与验收执行方（RET 三级路由） |
| `docs/ARCHITECTURE-REUSE.md` | 复用审计：§0 结论「保留」、§3 已复用的官方面（inject `tools` / `userQuestions` / `goals`） |
| `docs/host/DSH-CTX-API.md` §0 | bundle 导出契约（`name` / `inject` / `Config` / `apply`；本包无 `Config`） |
| `TUI/docs/DESIGN.md`「命令实现落点」 | 下游消费者：TUI `/contract` 的取用与内置同构回读兜底 |

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # 编译到 dist/
npm run test    # node --test（37 例：clauses 8 / contract 9 / interview 7 / tool 13——访谈状态机 / 条款校验 / 落 goal 与回读）
npm run smoke   # 真实 dsh 会话联调（需 dsh 0.2.0-rc.2 与模型凭据）
```
