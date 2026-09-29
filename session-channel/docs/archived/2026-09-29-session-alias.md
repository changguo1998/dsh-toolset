# 会话别名（可读寻址）（接取条目：session-channel「会话别名（可读寻址）」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

同时接取的条目（同任务多条目，按规范允许）：session-channel「工具描述残留旧前缀 `[INTERCOM]`」（同一描述段落内顺手修正）。

## 目标

给每个会话起人类可读别名，`send` 的 `to` 支持别名寻址；含 `alias set/list/clear` 管理面；顺带修正工具描述里的旧前缀。

## 决策（条目「开放问题」的落地口径）

1. **字符集**：`[A-Za-z0-9_-]{1,32}`（不允许中文与空格：终端宽度与寻址解析歧义），不合法 → `alias_invalid`。
1. **保留字**：`inbox/alive/ack/cursor/alias/meta/peers/send/status` → `alias_reserved`（与键命名空间、工具动作名冲突）。
1. **唯一性**：一会话一别名——为同一会话设新别名时自动移除其旧别名（回 `replaced`）；别名被**别的**会话占用时拒绝（`alias_taken` 并回 `holder`），显式 `force: true` 才覆盖。
1. **生命周期**：别名键**无 TTL**（别名是用户意图，不随会话离线过期）；由 `alias clear` 手工清理，或在设新别名时自然顶替。不做自动过期（与游标键的 7 天懒清理不同）。
1. **寻址优先级**：会话 id 精确匹配 → 别名 → `cwd:<绝对路径>`；三者都不命中 → 空结果（发送方报 `target_offline`）。
1. **调用方会话**：工具层从宿主 `exec.agent.session` 取调用方会话 id，`alias set` 的 `to` 缺省即「当前会话」；非 agent 调用方须显式传 `to`。

## 规划

计划改动文件清单（**只改这些**）：

- `session-channel/docs/BACKLOG.md`（F1 与 D3 状态）
- `session-channel/docs/implementation/2026-09-29-session-alias.md`（本文件）
- `session-channel/src/keys.ts`（别名键 / 扫描模式 / 字符集 / 反解）
- `session-channel/src/broker.ts`（`setAlias` / `listAliases` / `clearAlias` / `clearAliasesOf` / `resolveAlias` + `resolveTarget` 优先级）
- `session-channel/src/index.ts`（服务方法 `aliasSet/aliasList/aliasClear` + 工具动作 `alias` + 描述修正）
- `session-channel/tests/alias.test.ts`（新增）
- 关闭时回写：`session-channel/README.md`、`session-channel/docs/DESIGN.md`

明确不做：TUI 侧显示（属 TUI #48）、别名自动过期、中文别名、跨机解析。

## 实现记录

- `src/keys.ts`：`aliasKey` / `ALIAS_PATTERN` / `ALIAS_RE` / `aliasFromAliasKey`。
- `src/broker.ts`：`resolveAlias`、`listAliases`（扫描 + 排序）、`setAlias`（校验 → 冲突判定 → 顶替自身旧别名 → 写入）、`clearAlias`、`clearAliasesOf`；`resolveTarget` 改为「会话 id 精确 → 别名 → `cwd:`」。
- `src/index.ts`：`aliasSet` / `aliasList`（带在线标记）/ `aliasClear` 服务方法；工具新增 `alias` 动作（`op=set|list|clear`，`name`、`to`（缺省调用方会话）、`force`），`execute` 改为接收 `exec` 以解析调用方会话；工具描述补 `alias` 并修正旧前缀 `[INTERCOM]` → `[CHANNEL] `。

## 测试与证据

- 新增 `tests/alias.test.ts`（7 例）：set→resolve→list→clear（含无 TTL 断言）；一会话一别名（`replaced`）；占用冲突与 `force` 覆盖（含 `holder`）；字符集与保留字校验；寻址优先级（id 精确优先于同名别名、别名、`cwd:`、未知目标空结果）；经别名投递到目标邮箱流；`clearAliasesOf` 按会话清理。
- 结果：`npm --prefix session-channel run test` → 29 例全通过（原 22 + 新 7）；`run check` 0 error。
- 真机复验（2026-09-29，通过）：重启后工具实测——`alias set name=docs`（`to` 缺省解析为调用方会话 `tui-c04543b2…`，证明 `exec.agent.session.id` 链路可用）→ `alias list`（别名带 `online: true`）→ `send to=docs` 返回 `delivered: true` 且入站注入到达（`[CHANNEL] 别名寻址自检（to=docs）`）。
- 同任务条目 D3 一并验证：`grep -rn "INTERCOM" src tests README.md docs/DESIGN.md` 零结果。

## 收尾

- 条目 F1（别名）与本任务一并接取的 D3（旧前缀）标记完成并从 `session-channel/docs/BACKLOG.md` 移除（保留未完成项 D4）；本文件移入 `session-channel/docs/archived/`。
- 回写 `session-channel/README.md`（别名键、别名规则与用法、寻址优先级）与 `session-channel/docs/DESIGN.md`（§3 键位与寻址解析、§7 工具动作与调用方会话解析）——已在本任务内完成。
- 途中发现另登记 D4（发送方标识恒为空，P2）。
