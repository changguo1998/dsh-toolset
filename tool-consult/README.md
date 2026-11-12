# @dsh-toolset/tool-consult

## 定位

DSH（DeepSeek Harness）工具咨询插件：模型用一句话描述「要做什么」，插件返回匹配工具（名称 + 一句话简述）并让它们对当前会话可见。咨询工具自身常驻可见。

设计与证据链见追踪文档 `docs/archived/2026-10-22-tool-consult.md`（项目级记录见 `docs/BACKLOG.md` §1「已完成索引」）。

## 能力

- **按需揭示**：缺省只留 11 个核心工具（`bash` / `read` / `glob` / `grep` / `ask_user_question` / `skill` / `hash_read` / `hash_edit` / `write` / `web_search` / `web_fetch`）+ 咨询工具 `consult_tools`。写面只留两个：`write` 负责新建 / 整文件覆写，`hash_read` + `hash_edit` 负责行级锚点读写；`edit` 与 `todo_write` 收进按需揭示。
- **双轨并存**（过渡期）：接入 `tool-surface` 包装层的工具「声明常驻 + 派发拒绝」——注册定义只剩短说明与宽松占位，未揭示时 `tools/pre-execute` 拒绝（文案「tool <name> 未在当前会话揭示…」，`error.info.code = TOOL_NOT_REVEALED`），揭示后放行并把完整说明与 `input_schema` 经 `pinNotes.hold("revealed-tools")` 投递；未接入的工具仍走宿主 `tools.restrict` 遮罩（揭示即放回整份声明）。
- **咨询即授权**：`consult_tools(query | names, limit, reveal, scope, pin)` 返回名称 + 一句话，并把命中项加入当前会话可见集；下一次请求装配时生效（宿主自行发 `request/header` 与 `tool-addition`）。
- **两档作用域**：`revealScope: "session"`（缺省，会话内一直可见、`turn/end` 不收回）与 `"turn"`（仅本回合，回合末按 LRU 收敛、支持 `ttlTurns` 与 `pin`）；逐次 `scope` 覆盖，优先级 逐次 > 配置 > 缺省 `session`。
- **可行动错误**：调用未揭示的工具时返回「先 consult_tools 揭示」的可行动文案，而不是裸的 `unknown tool`。

## 配置

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `maskMode` | `allowlist` | `allowlist` / `denylist` / `off`（`off` 不做工具面管理） |
| `initialTools` | 11 个核心工具（`bash` / `read` / `glob` / `grep` / `ask_user_question` / `skill` / `hash_read` / `hash_edit` / `write` / `web_search` / `web_fetch`） | 支持 `*` / `?` 通配 |
| `disabledWhenTools` | `exit_plan_mode` / `propose_action` / 4 个 `team_task_*` | 显式禁用的官方条件工具：不进检索索引、不进遮罩名单 |
| `applyTo` | `roots` | `roots`（只遮根代理）/ `all` |
| `maxRevealed` | `12` | 仅 `turn` 档：回合内容量上限（`session` 档**不设上限**，2026-10-27 裁定） |
| `revealScope` | `session` | 揭示作用域缺省档 |
| `ttlTurns` | `0` | 仅 `turn` 档：闲置多少回合后收回（0 = 关闭） |
| `maxPinned` | `3` | 仅 `turn` 档：同时钉住的上限 |
| `maxResults` | `5` | 单次返回上限（1 至 20） |
| `audit` | `false` | 预留：写 `tool-consult/*` 审计事件 |

## 用法

profile 的 `cordis.patch.yml` 插入本包（本包自带 `cordis.patch.yml` 时随 bundle 生效）：

```yaml
- insert:
    - id: tool-consult
      name: '@dsh-toolset/tool-consult'
      config:
        revealScope: session
```

根级接线（根 `package.json` 脚本链、`AGENTS.md`、根 README、profile 模板）由主分支统一处理，本包只提供 `dsh.bundle` 契约。

## 边界

- **失败降级**：无 agent 作用域 / `restrict` 抛错 / 名单失配 / 咨询工具重名 / 空交集，一律回退为「不遮罩」，会话不中断。
- **只遮根代理**：缺省 `applyTo: roots`，只处理根代理；`all` 才逐代理挂遮罩。

## 注入通道

- 静态保持：工具总则（功能 → 工具映射）—— 规划为 `ctx.systemPrompt.section`，name `tool-consult/tool-index`、order 4300；内容归 1111 工具说明注册表，本轮只定名与位置。
- 动态保持：被揭示工具的全文本 —— `pinNotes.hold("revealed-tools", ...)` 按「已揭示集合 + 全文源（`toolSurface.lookup`，过渡期退回注册定义）」渲染成「标题行 + 每条 `name:` + 紧凑 JSON（`description` + `input_schema`）」；集合不变则文本同字节，集合变化才重投。
- 一次性注入：咨询结果本身仍随工具回执返回（例外通道）。

## 测试

```sh
pnpm run check             # tsc --noEmit
pnpm run build             # 编译到 dist/
pnpm run test              # node --experimental-transform-types --test 'tests/*.test.ts'
pnpm run test:integration  # 集成层：装配 apply 与宿主接线
pnpm run test:coverage     # 单元 + 集成一起跑，报告落 tmp/cov-tool-consult
```

无依赖环境下可直接跑测试：`node --experimental-transform-types --test tool-consult/tests/*.test.ts`。
