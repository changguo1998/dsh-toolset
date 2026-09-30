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
name: code-review            # 小写 [a-z0-9-]{1,32}；即命令名
description: 结构化评审       # 命令目录 / 补全展示
input: 文件路径或 diff 范围    # 参数提示（可选）
model: deepseek-v4-pro       # 模板级默认模型（仅本次调用；可省）
steps:
  - id: review               # 步骤 id（可省，缺省 step1…；串链引用用）
    type: agent              # agent（子代理）| prompt（注入当前会话）
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
单双引号字符串、整行 `#` 注释；**不支持**流式集合（`{}` / `[]`）与锚点，遇到即报错（避免静默错读）。
坏模板不拖垮加载：记入错误清单，`/tpl list` 可见。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dirs` | 随包 `templates/` | 模板目录（相对路径相对包根解析） |
| `userDir` | `$DSH_HOME/command-templates` | 用户目录（同名覆盖随包） |
| `maxSteps` | `12` | 单次运行步骤上限 |
| `maxBestOf` | `8` | `bestOf` 上限 |
| `stepTimeoutMs` | `600000` | 单个 agent 步骤超时 |
| `reservedNames` | `["list", "show", "reload"]` | 入口保留子命令名（模板同名则无法调用，加载时告警） |
| `disabled` | `false` | `true` = 只加载不注册 |

## 服务面

`ctx.get("commandTemplate")` → `{ list, get, errors, reload }`（只读查询 + 热重载；键清单与服务面同步，
测试守卫 `SERVICE_FACE_METHODS`）。

## 使用

```sh
/playbook list                                  # 列模板（随包 5 个 + 用户模板）
/playbook code-review README.zh.md               # 跑一个模板（模板名 + 参数）
/playbook show code-review                       # 看解析结果
# 用户模板：写一个 .md 到 ~/.dsh/command-templates/ 后 /playbook reload
```

## 边界

- 不实现执行器：`agent` 步骤走宿主 `ctx.subagents` **服务面** `start(name, request)`（一次性运行；宿主写父会话 catalog 并发生命周期事件，模型覆盖仅本次）；
  task-engine 的叶子 `executor` 声明（项目级「task-engine 执行扩展」）落地后，改为经该声明选择后端。
- 不改 TUI：模板命令经宿主命令注册表自动出现在补全里（TUI 本地命令同名时本地优先）。
- 不做模板市场 / 版本管理 / 参数类型校验（参数一律按文本展开）。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # tsc → dist/
npm run test    # node --test（8 例：解析 / 参数 / 双源 / 步骤 / 服务与命令注册）
```
