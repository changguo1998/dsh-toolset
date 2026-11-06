# @dsh-toolset/flow-track

DSH（DeepSeek Harness）进程内集成插件：把本仓「标准流程」从「文档规范 + agent 自觉」固化成机制——**阶段模板注入 + 流程记录入库 + 推进状态与合规提示**。

**只提示不拦截**（决策项 4.3 = b 中档）：不挡任何工具调用，语气是带路而不是执法。

## 三件组合

| 件 | 存放位置 | 说明 |
| --- | --- | --- |
| 阶段模板 | `src/stages.ts` | 八阶段（目标 / 调研 / 决策 / 规划 / 实现 / 测试 / 审查 / 收尾），每阶段 = 单动作 spec + 验收口径 + 门禁 + `deps`；模型据此手动 `task_decompose` |
| 流程记录 | memory-base（kind `flow`，P 层） | `flow_record` 写、`flow_status` 读；`title` = `<slug>@<阶段>`，`content` = 状态行 + 正文 |
| 推进状态 | `src/status.ts` + `src/observe.ts` | 只读 `taskEngine.query()` 的快照推当前阶段；另订阅 `session/event` 数写类工具调用做合规提示 |

## 阶段模板

| 阶段 | 单动作 spec | 门禁 | 前置 |
| --- | --- | --- | --- |
| 1 目标 | 写清任务目标与验收口径 | mechanical | - |
| 2 调研 | 读相关代码与宿主面，结论带来源锚点 | mechanical | 1 |
| 3 决策 | 决策项按数字、选项按字母列候选并选定 | mechanical | 2 |
| 4 规划 | 写计划改动文件清单与明确不做 | mechanical | 3 |
| 5 实现 | 按清单改动并追加实现记录 | mechanical | 4 |
| 6 测试 | 跑相关 test 与 check:docs 并补「测试与证据」 | mechanical | 5 |
| 7 审查 | 交审查方审阅 diff 与效果，结论入档 | **human**（`approval.request`） | 6 |
| 8 收尾 | 归档追踪文档、清理 BACKLOG 条目并按需回写文档 | mechanical | 7 |

提交询问点（阶段 3 / 5 / 6 / 8 之后的四处）落在阶段内部，阶段 7 的 human 门禁即「人工确认 / 审阅」那一次。

## 注入时机与内容

注入有两道门槛：**配置 `enabled` 与进程内开关都打开**，且 **memory-base 里有未完成阶段的流程记录**（某任务最新一条非 `-` 阶段不是「收尾」）。开关缺省关闭，用户面 `/flow-track on|off|status`、模型面 `flow_enable` 都能切；状态只在内存，进程结束即回到关闭。

`rule-engine` 消费者：`id = flow-track`、`sources = ["turn-start", "user-message"]`、`delivery = "inject"`、`dedupeInRecord = 1`。不给固定 `summary`，rule-engine 按正文派生摘要，因此**同一正文每会话只投一次**（记录推进、提示内容变化后仍会再投）。三类内容按固定顺序合并成一条：

1. **当前推进状态**（有阶段树时）：`当前阶段：3/8 决策 / 门禁：mechanical / 下一步：阶段 4 规划`；
2. **阶段模板**（无阶段树**且**本轮有写类工具调用时）：八阶段全文 + 建树提示；
3. **合规提示**（本轮有写类工具调用且没有任何流程记录时）：提示先登记条目 / 建追踪文档或用 `flow_record` 记录，明写「只提示, 不拦截」。

门槛不满足（开关关闭，或没有未完成阶段的流程记录）→ **不注入**（阶段模板与合规提示一并静默）。

## 工具面

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `flow_record` | `slug`、`stage`（八阶段或 `-`）、`status`（start / done / blocked / note）、`body?` | 按顺序写：首条必须是「目标」；之后只能写当前阶段（**替换**该阶段记录）或下一阶段（追加）；跳过与倒回被拒绝；写后清掉本会话的「未记录」观测 |
| `flow_status` | `slug?` | 读开关态（`enabled`）、是否有未完成流程（`active`）、当前阶段（序号 / 名称 / 门禁 / 帧标题）与最近记录 |
| `flow_enable` | `enabled`（布尔） | 切换注入开关（进程内, 缺省关闭, 不落盘）；回执带 `enabled` 与 `active` |
| `flow_remove` | `id` 或 `slug`（二选一） | 删流程记录：`id` 删一条、`slug` 删该任务全部（回 `removed` 条数）；删后刷新注入缓存 |
| `flow_rollback` | `slug?`、`stage`（八阶段） | 回退到更早阶段：清掉目标之后的记录与全部 `-` 备注（目标阶段记录保留）；只删不写，回退后再用 `flow_record` 更新内容 |

用户面同款入口：`/flow-track on|off|status`（命令缺省展示开关与活跃流程状态）。

顺序规则（每个 `slug` 独立判定，当前阶段 = 该任务时间线上最新一条非 `-` 记录的阶段）：`目标` → `调研` → `决策` → `规划` → `实现` → `测试` → `审查` → `收尾`；`-` 只作整体备注，不参与当前阶段推导。

## 配置

`cordis.patch.yml` 的 `config`：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 显式 `false` 时 `decide` 恒 `null`（工具仍可用） |
| `sources` | `["turn-start", "user-message"]` | 唤醒节点 |
| `delivery` | `"inject"` | 投递方式 |

## 边界

- **阶段名靠标题匹配**：任务帧标题需以阶段名开头（`决策` 或 `决策：机会成本` 都行）；标题不合规范时状态段退化为「没有可识别的阶段树」。
- **顺序约束只看记录**：当前阶段按该 slug 最新一条非 `-` 记录判定，不读任务树快照；任务树停在别处也不影响写入判定；历史脏数据（阶段名不在八阶段内）会被拒绝写入并提示用 `flow_remove` 清掉。
- **不自动建树**：`taskEngine` 服务面只读（`query` / `frameStack`），本包不 import 引擎内核，建树仍由模型调 `task_decompose`。
- **记录缓存有延迟**：`decide` 是同步的，读库是异步的，故注入里的「最近记录」来自缓存；缓存由挂载、`flow_record` 写入、`session/event` 三处刷新。
- **合规判据只到工具名**：只要调用过 `write` / `edit` / `bash` / `pwsh` / `str_replace_editor` / `hash_edit` / `ast_replace` / `script_run` 就算「写过」，不解析改了哪些文件；判据失真时改提示文案，不升级为拦截。
- **正文入库不改文档体系**：决策项 3 = b（全文入库）的追踪文档规则改动未并入本包，现有 `docs/implementation/*.md` 写法不变。
- **降级**：`ruleEngine` 缺席 → 告警且不注册（插件不注入）；`memory` 缺席 → 工具返回 `unavailable`、注入恒 `null`（判断不了有没有未完成流程）；`taskEngine` 缺席 → 状态段退化，只给「最近记录」。
- **开关决定一切注入**：`enabled` 配置与进程内开关都打开、且有未完成阶段的流程记录才注入；因此开关关闭时阶段模板与合规提示一并静默（同一门槛）。
- **服务读取必须经反射面**：本包只 `inject: ["ruleEngine"]`，`memory` / `taskEngine` / `tools` / `logger` 都用 `ctx.reflect.get(name)` 读；直接访问 `ctx.memory` 这类未 inject 的服务属性在 cordis 里会抛 `cannot get property "x" without inject`（真机实测，2026-11-06）。
- **HMR 重载**：写入句柄按 memory 服务对象缓存在 `globalThis`（键 `dsh-toolset.flow-track.scopes`），重载后复用同一个句柄，不会因「分类 `flow` 已注册」丢掉写入能力。

## 测试

```sh
cd flow-track
pnpm run check   # tsc --noEmit（含 tests）
pnpm test        # node --test：阶段 6 例 + 状态 7 例 + 存储 13 例 + 观测 6 例 + 注入 9 例 + 顺序 12 例 + 接线 24 例
pnpm run build   # 编译到 dist/
```

真机验证（人工）：`/flow-track status` 看到「已关闭」→ `/flow-track on` 后仍不注入（没有未完成流程）→ `flow_record` 写「目标」后下一回合注入出现「最近记录」→ 建八阶段树后注入出现「当前阶段：N/8 …」→ 依次推进验证跳阶段被拒、同阶段再写是替换 → `flow_rollback` 回退并确认后续记录与 `-` 备注被清 → 走到「收尾」后注入消失 → `/flow-track off` 后即使有未完成流程也不注入。
