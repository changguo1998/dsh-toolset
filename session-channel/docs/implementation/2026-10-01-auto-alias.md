# 会话别名自动生成（≤8 字符名词性单词或名字）（接取条目：`session-channel/docs/BACKLOG.md`「F1 会话别名自动生成（≤8 字符名词性单词或名字）」）

状态：决策　　开启：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新会话无需手工设置即有**带类型前缀的**名词性别名（词 ≤8 字符 + 前缀 `ui-` 用户启动会话 / `sub-` 子代理会话）；冲突自动重试；`alias list` 可见；`alias set` 可覆盖；既有行为（显式别名、来源标签、寻址）不变。

## 调研

- 别名核心在 `src/broker.ts`：`setAlias`（校验 1-32 位 `[A-Za-z0-9_-]`、保留字表 9 项、被占用需 `force`、自动清自身旧别名）、`aliasOfSession` / `listAliases` / `clearAliasesOf`；键 `aliasKey(alias) → sessionId`，**无 TTL**。
- 会话发现：`src/index.ts` 的 `#host.on("session/event")` → `noteSession(session)`——**首次**见到某会话 id 时建 `#sessions` 条目（写在线键 / 载游标 / announce），会话 id 与 cwd 均来自该事件。
- 别名消费面（现状）：状态栏 `@别名` 段、`send` 来源标签、`channel_delegate` 寻址。

## 决策

1. **词源 + 类型前缀（用户 2026-10-01 追加）**：内置词表（**≤8 字符** ASCII 名词 / 名字，如 `otter` `lyra` `comet`；用户裁定词表长度限制不缩减），置于 `src/index.ts`；别名 = `${前缀}${词}`（总长 ≤ 12，仍在 1-32 校验内），**前缀按会话类型**：`header.origin === "subagent"` 或 `header.delegationDepth > 0` → `sub-`，否则 `ui-`（宽容读取，会话事件已给出）。测试强制词表合法（≤8、`[A-Za-z]`、非保留字、无重复）。
1. **生成时机**：`noteSession` **首次见到会话**时自动写入（仅当 `aliasOfSession` 为空）——等价「启动即生成」且对既有别名零影响；子代理会话同样生成（前缀 `sub-`）。
1. **冲突策略**：随机取词（全表）→ 拼成 `${前缀}${词}` → `setAlias`；`alias_taken` 时重试（≤8 次）；其它错误 / 异常静默放弃（别名是增强项，不影响通道功能）。
1. **清理**：不随会话结束清理——与显式别名同生命周期（无 TTL），靠 `alias clear` 手工清；`alias set` 可随时覆盖。
1. 备选（未选）：首次「用到时」懒生成——状态栏 / `send` 之前无别名，违背「启动即有」。

## 规划

计划改动文件清单（**只改这些**）：

1. `session-channel/src/index.ts`：词表（96 词）+ `aliasPrefixFor` / `pickAutoAlias`（纯函数，随机源可注入）+ `#autoAlias` + `noteSession` 首见处触发 + `SessionChannelDeps.random`。
1. `session-channel/tests/alias.test.ts`：词表合法性 / 前缀 / 取词 / 首见生成（集成，真实临时 Redis）/ 既有别名不动 / 不重复写。**另改**（预期行为变化）：`tests/apply.test.ts`、`tests/service.test.ts`——来源标签由「回退会话 id」改为自动别名，D6 用例加「等别名写入后清掉」以保留 id 回退分支。
1. `session-channel/docs/BACKLOG.md`：条目「完成」标记与收尾清理。
1. 本追踪文档。

明确不做：不改 `setAlias` 校验与保留字表；不改工具面；不做 TTL / 清理策略；不改 TUI。

## 实现记录

1. 2026-10-01 `src/index.ts`：新增 `AUTO_ALIAS_WORDS`（96 词，≤8 字符）、`AUTO_ALIAS_TRIES = 8`、`aliasPrefixFor`（`origin === "subagent"` / `delegationDepth > 0` → `sub-`，否则 `ui-`）、`pickAutoAlias`（随机源可注入）与 `#autoAlias`（首见且无别名 → `setAlias`；`alias_taken` 重试 ≤8，其它静默）；`noteSession` 首见分支挂 `void this.#autoAlias(session, sessionId)`；`SessionChannelDeps` 增 `random?`。
1. 2026-10-01 测试：`tests/alias.test.ts` 增 4 例（词表 / 前缀 / 取词 / 首见生成集成）；按预期行为变化更新 `tests/apply.test.ts`（D4 来源标签 → `来自 ui-…`）与 `tests/service.test.ts`（端到端来源标签 → `ui-…`；D6 的「无别名回退」前先等别名写入再清掉）。
1. 途中：首见生成的异步写入与测试清别名存在竞态 → D6 用例改为「等别名出现 → 清 → 等清空」，确定性 ✓。

## 测试与证据

- 单测：`cd session-channel && npm run test` → 45 pass / 0 fail（含新增 4 例；集成例走真实临时 Redis）。
- 全量：`npm run test`（根）→ 16 包全绿（session-channel 45 / TUI 1228 / 0 fail）。
- 机械门禁：`npm run check` exit 0；`npm run build` exit 0（session-channel 包内）。
- 真机确认（点 3 前）：重启后本会话应得 `ui-…` 别名（状态栏 `@别名` 段 + `alias list` 可见）；起一个子代理 → 其会话得 `sub-…` 别名（状态列 Agents 行显示别名）。

## 收尾

（待写）
