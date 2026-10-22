# @dsh-toolset/tool-consult

DSH（DeepSeek Harness）工具咨询插件：模型用一句话描述「要做什么」，插件返回匹配工具（名称 + 一句话简述）并让它们对当前会话可见。咨询工具自身常驻可见。

设计与证据链见追踪文档 `docs/implementation/2026-10-22-tool-consult.md`（项目级条目见 `docs/BACKLOG.md` §2「5. 工具咨询插件」）。

## 能力

- **按需揭示**：缺省只留 9 个核心工具（`bash` / `read` / `write` / `edit` / `glob` / `grep` / `todo_write` / `ask_user_question` / `skill`）+ 咨询工具 `consult_tools`，其余工具用宿主 `tools.restrict` 收进「按需揭示」集合。
- **咨询即授权**：`consult_tools(query | names, limit, reveal, scope, pin)` 返回名称 + 一句话，并把命中项加入当前会话可见集；下一次请求装配时生效（宿主自行发 `request/header` 与 `tool-addition`）。
- **两档作用域**：`revealScope: "session"`（缺省，会话内一直可见、`turn/end` 不收回）与 `"turn"`（仅本回合，回合末按 LRU 收敛、支持 `ttlTurns` 与 `pin`）；逐次 `scope` 覆盖，优先级 逐次 > 配置 > 缺省 `session`。
- **可行动错误**：调用被遮罩的工具时返回「先 consult_tools 揭示」的可行动文案，而不是裸的 `unknown tool`。
- **失败降级**：无 agent 作用域 / `restrict` 抛错 / 名单失配 / 咨询工具重名 / 空交集，一律回退为「不遮罩」，会话不中断。

## 配置

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `maskMode` | `allowlist` | `allowlist` / `denylist` / `off` |
| `initialTools` | 9 个核心工具 | 支持 `*` / `?` 通配 |
| `applyTo` | `roots` | `roots`（只遮根代理）/ `all` |
| `maxRevealed` | `12` | `session` 档新增揭示硬上限；`turn` 档回合内容量上限 |
| `revealScope` | `session` | 揭示作用域缺省档 |
| `ttlTurns` | `0` | 仅 `turn` 档：闲置多少回合后收回（0 = 关闭） |
| `maxPinned` | `3` | 仅 `turn` 档：同时钉住的上限 |
| `maxResults` | `5` | 单次返回上限（1 至 20） |
| `audit` | `false` | 预留：写 `tool-consult/*` 审计事件 |

## 接入

profile 的 `cordis.patch.yml` 插入本包（本包自带 `cordis.patch.yml` 时随 bundle 生效）：

```yaml
- insert:
    - id: tool-consult
      name: '@dsh-toolset/tool-consult'
      config:
        revealScope: session
```

根级接线（根 `package.json` 脚本链、`AGENTS.md`、根 README、profile 模板）由主分支统一处理，本包只提供 `dsh.bundle` 契约。

## 开发

```sh
npm run check   # tsc --noEmit（需要已安装 typescript）
npm run build   # 编译到 dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'
```

无依赖环境下可直接跑测试：`node --experimental-transform-types --test tool-consult/tests/*.test.ts`。
