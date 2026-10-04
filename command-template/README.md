# @dsh-toolset/command-template

DSH 进程内插件：**模板体系**——把「多步 / 可复用」的提示词流程写成模板文件，注册为 slash 命令。
执行机制全部复用宿主（命令面、会话注入、一次性子代理），本包只负责**格式、入口与编排**。

## 能力

- **双源模板**：仓库随包 `templates/`（范例）+ 用户 `$DSH_HOME/command-templates`（新增 / 覆盖，同名用户优先）。
- **统一入口**：`/playbook <模板> [参数]`（只占一个命令名）；管理：`/playbook list`、`/playbook show <模板>`、`/playbook reload`。
- **步骤类型**：`prompt`（把展开后的文本注入当前会话）、`agent`（一次性子代理运行，可覆盖模型）。
- **编排**：顺序串链（`{{stepId}}` 引用前序产出）、`bestOf: N` 并行候选 + `judge` 裁判选最佳。
- **模板级模型选择**：`model`（模板级）/ 步骤级 / 裁判级覆盖，**仅作用于该次运行**，不改会话默认。
- **降级**：`commands` 未挂载 → 告警不崩；`agent` 步骤缺 `subagents` 面 → 该步以 `step_failed` 报错（不静默忽略模型覆盖）。

## 模板格式

`*.md` = YAML 子集 front-matter + 正文（无 `steps` 时正文即单个 `prompt` 步骤）。

```md
---
name: code-review            # 模板名（小写 [a-z0-9][a-z0-9-]{0,31}，首字符须字母/数字）
                             #   经 /playbook <模板> 调用，模板不占独立命令名
description: 结构化评审       # 命令目录 / 补全展示
input: 文件路径或 diff 范围    # 参数提示（可选）
model: deepseek-v4-pro       # 模板级默认模型（仅本次调用；可省）
steps:
  - id: review               # 步骤 id（可省，缺省 step1…；串链引用用）
    type: agent              # agent（子代理，缺省）| prompt（注入当前会话）
    prompt: |                # 支持 $ARGUMENTS / $1..$9 / {{前序步骤 id}}
      评审范围：$ARGUMENTS
    model: deepseek-flash    # 步骤级覆盖（可选；须与当前 profile 的 provider 匹配，
                             #   如 provider 为 ustc 时要用该网关暴露的模型 id）
    bestOf: 3                # >1 时并行候选（可选）
    judge:                   # 裁判步（bestOf 时可选）
      prompt: 选最佳候选并给最终结论
      model: deepseek-v4-pro
---
```

解析器只支持手写模板需要的子集：标量、嵌套映射（缩进）、块序列（`- `）、块标量（`|` / `>`）、
单双引号字符串、整行 `#` 注释（**行尾** `#` 不剥离，会原样进入值）；流式集合（`{}` / `[]`）
遇到即报错，锚点（`&x` / `*x`）不做锚点解析、按普通标量字面读入——避免半吊子支持带来的静默错读。
坏模板不拖垮加载：记入错误清单，`/playbook list` 可见。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dirs` | 随包 `templates/` | 模板目录（相对路径相对包根解析） |
| `userDir` | `$DSH_HOME/command-templates` | 用户目录（同名覆盖随包） |
| `maxSteps` | `12` | 单次运行步骤上限 |
| `maxBestOf` | `8` | `bestOf` 上限 |
| `stepTimeoutMs` | `600000` | 单个 agent 步骤超时 |
| `totalTimeoutMs` | `maxSteps × stepTimeoutMs`（随包配置下 = `7200000`） | 一次运行的总预算：只约束 agent 步之和（语义 = agent 步**启动闸门**；非正 / 非有限 = 不设；超限 → `run_timeout`） |
| `reservedNames` | `["list", "show", "reload"]` | 入口保留子命令名（模板同名则仍会加载并出现在 `list` 里，但无法经入口调用，加载时告警）；**入口命令名本身恒保留**（`/playbook playbook` 走管理面 = list，与 `reservedNames` 配置无关） |
| `disabled` | `false` | `true` = `apply()` 立即返回：不加载模板、不注册命令、不提供 `commandTemplate` 服务面（离线排障） |

## 服务面

`ctx.get("commandTemplate")` → `{ list, get, errors, reload }`（只读查询 + 热重载；键清单与服务面同步，
测试守卫见 `tests/template.test.ts`——断言服务面键与 `SERVICE_FACE_METHODS` 相等、且每个键在
`CommandTemplateService` 上有同名方法；键漂移 / 方法改名即红）。

## 使用

```sh
/playbook list                                  # 列模板（随包 5 个 + 用户模板）
/playbook code-review README.zh.md               # 跑一个模板（模板名 + 参数）
/playbook show code-review                       # 看解析结果
# 用户模板：写一个 .md 到 ~/.dsh/command-templates/ 后 /playbook reload
```

## 随包模板

| 模板 | 用途 |
| --- | --- |
| `code-review` | 对文件 / 改动做结构化评审（问题 / 风险 / 建议） |
| `adversarial-review` | 对抗评审：正方结论 → 反方攻击 → 裁决 |
| `codebase-audit` | 代码库审计：按区域并行排查问题 → 汇总清单 |
| `deep-research` | 多源调研一个主题：并行取证 → 汇总 → 交叉验证 |
| `multi-perspective` | 同一问题的多角色视角（产品 / 实现 / 运维 / 用户） |

## 边界

- 不实现执行器：`agent` 步骤走宿主 `ctx.subagents` **服务面** `start(name, request)`（一次性运行；宿主写父会话 catalog 并发生命周期事件，模型覆盖仅本次）；
  task-engine 的叶子 `executor` 声明（项目级「task-engine 执行扩展」）落地后，改为经该声明选择后端。
- **终态与回收**：`start` 与「等宿主结算（`settleRun`）」都放在取消信号**竞速**里——宿主结算面可能**无界**（`await run.result`；已确认：真机出现过 `command/run` 无 `command/done` 的悬挂；未确认：具体触发条件）。竞速落败（调用方取消 / `stepTimeoutMs` 超时）时**抛可读文案**（区分「被调用方取消」与「步骤超时（N ms）后中止」，带子会话 id）→ `steps.ts` 转 `step_failed` → `run()` 返回 `kind:"error"`；同时**发起**回收但**不等待**（宿主 in-process `dispose()` 内部 `await run.result`，等它等于换个地方无界等待）。据此**本仓侧任何路径都回终态**（宿主侧 `subagent/end` 等生命周期事件仍取决于 `run.result`，本仓补不了）；
  - **总预算**（2026-10-04）：`totalTimeoutMs` 缺省 = `maxSteps × stepTimeoutMs`（随包配置下 = `7200000` ms）——把最坏上界显式化；语义是 agent 步的**启动闸门**（预算不足不再启动新步；每步有效超时 = `min(stepTimeoutMs, 剩余)`；`prompt` 步零耗时、不受约束），**不是**「命令必在 deadline 前返回」。缺省配置下它对随包模板实际不会触发（名义上界），需收紧请显式配置；注意 `bestOf` 并行 + `judge` 会让单步最坏 ≈ `2 × stepTimeoutMs`（故「重步 ≥ 7 个」时缺省预算才可能生效）；超限返回 `run_timeout`（文案含已用 / 预算 ms 与已完成步骤）；**预算可见性**（2026-10-04）：`/playbook show <模板>` 输出 `budget: <生效值> ms` 并标注来源（`（缺省 = maxSteps × stepTimeoutMs）` 或 `（config.totalTimeoutMs）`），与运行侧共用 `budgetOrInfinity()`（内部先算 `effectiveBudget()` 再做「非正 / 非有限 → 不设预算」归一）一处口径；
- 不改 TUI：入口命令 `/playbook` 经宿主命令注册表自动出现在补全里（TUI 本地命令同名时本地优先）。
- 不做模板市场 / 版本管理 / 参数类型校验（参数一律按文本展开）。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # tsc → dist/
npm run test    # node --test（26 例：解析 / 参数 / 双源 / 步骤与预算 / 服务与命令注册 / 子代理面）
```

## 文档

- `docs/DESIGN.md`：架构与机制取舍（单一入口 / 双源目录 / 失败面错误码 / 取消与终态语义）
- `docs/BACKLOG.md`：本包未完成项（当前为空）
- `docs/archived/`：变更过程与历史决策
