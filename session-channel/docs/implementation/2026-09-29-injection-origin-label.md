# session-channel 注入正文带来源标识（接取条目：`session-channel/docs/BACKLOG.md`「注入正文不显示发送方（视觉层缺来源，D4 的遗留面）」）

状态：规划　　开启：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

接收方在注入正文即可辨识来源：正文由 `[CHANNEL] <正文>` 改为 `[CHANNEL](<来源>) <正文>`，来源 = 发送方别名（有则优先）→ 发送方会话 id → `from` 为空时「未知会话」。D4 已解决数据层（邮箱流 `from`、`source.summary`），本任务补视觉层。

## 调研

（来源：本仓源码 / 实测）

- 注入构造：`src/inject.ts` 的 `buildInjectionMessage(text, from, prefix)` 现输出 `prefix + text`，`source.summary` 已带来源；`INJECTION_PREFIX = "[CHANNEL] "`。
- 调用点：`src/index.ts` 的 `#deliver`（同步方法）→ `injectUserMessage`；其调用方 reader loop 已是 async，可改 `await`。
- 别名结构：`keys.ts` 只有正向键 alias → sessionId，无反向索引；`broker.ts` 的 `setAlias` 保证「一会话一别名」（设新别名先清自身旧别名），故反查 = 扫 `ALIAS_PATTERN` 取首个匹配，复用 `listAliases` 即可。
- 展示层：TUI 按 `source.kind`（`"session-channel"`）分派用户块显示，不解析正文前缀（`TUI/src/app/adapter/normalize.ts:74-96`）→ 文案变化不影响 TUI 分类。
- 真机现状：D4 验证时注入正文为 `[CHANNEL] D4 真机验证消息（自动测试，可忽略）`，无来源标识。

## 决策

- 选项：① 正文并入来源（本任务）；② 依赖宿主渲染 `source` 元数据（宿主面不可控）；③ 维持现状（D4 现象未消除）。
- 选定：①；格式由用户指定：`[CHANNEL](<alias>)`。
- 来源取值：别名优先（`aliasOfSession` 反查），无别名回退会话 id，`from` 为空显示「未知会话」。
- 前缀语义：`INJECTION_PREFIX` 由 `"[CHANNEL] "` 调整为 `"[CHANNEL]"`，正文 = `<prefix>(<来源>) <正文>`；自定义 `prefix` 保持「来源之前的固定前缀」语义。
- 契约影响：用户可见文案变化（前缀 `[CHANNEL] ` → `[CHANNEL](<来源>) `）。仓内无按正文前缀解析的代码（TUI 按 `source.kind` 分派）；`README` 与类型注释同步。

## 规划

计划改动文件清单：

1. `session-channel/src/inject.ts`：正文格式、前缀常量与注释。
2. `session-channel/src/broker.ts`：新增 `aliasOfSession` 反查。
3. `session-channel/src/index.ts`：`#deliver` 改 async + 解析来源标签 + reader loop 改 `await`；工具描述里的前缀说明。
4. `session-channel/src/types.ts`：`prefix` 注释。
5. `session-channel/tests/inject.test.ts`、`tests/service.test.ts`、`tests/apply.test.ts`：存量断言更新 + 新增（别名优先 / 无别名回退 id / 空来源）用例。
6. `session-channel/README.md`：`send` 行与 `prefix` 默认值。
7. 本追踪文档。
8. 根 `README.md`（计划外，用户 2026-09-29 裁定后追加）：插件表前缀描述同步。

明确不做：不改宿主 `source` 渲染；不动 TUI 代码与测试夹具；不做别名反查缓存（消息量低，SCAN 成本可接受）。

## 实现记录

- 2026-09-29：`inject.ts` —— `INJECTION_PREFIX` 改 `"[CHANNEL]"`（去尾空格），`buildInjectionMessage` 正文改为 `${prefix}(${origin}) ${text}`，空来源仍显示「未知会话」；注释同步。
- 2026-09-29：`broker.ts` —— 新增 `aliasOfSession(client, sessionId)`（复用 `listAliases` 扫全表取首个匹配；会话无别名或入参空串 → undefined）。
- 2026-09-29：`index.ts` —— `#deliver` 改 async，新增 `#originLabel`（别名优先 → 会话 id，反查异常记日志并回退 id）；reader loop 改为 `await this.#deliver(...)`；工具描述改为「形如 [CHANNEL](来源) 正文」。
- 2026-09-29：`types.ts` —— `prefix` 注释更新（正文 = `<prefix>(<来源>) <正文>`）。
- 2026-09-29：测试更新与新增 —— `inject.test.ts` 加 `buildInjectionMessage` 形态用例（带来源 / 空来源 / 自定义 prefix），代理宿主用例断言改为 `[CHANNEL](未知会话) 代理注入`；`service.test.ts` 端到端断言改为 `[CHANNEL](sess-a) hello B`，新增「别名优先」用例（无别名 → 会话 id；设别名 → 别名）；`apply.test.ts` 断言改为 `[CHANNEL](sess-x) 自测`。
- 2026-09-29：`README.md` —— `send` 行与 `prefix` 默认值同步。
- 2026-09-29：根 `README.md`（计划外文件，经用户裁定后追加进清单）—— 插件表中 session-channel 行的前缀描述同步为 `[CHANNEL](来源) 正文`。

## 测试与证据

- `npm --prefix session-channel run check` ✓；`build` ✓。
- `npm --prefix session-channel run test`：32 例全通过（含新增 D6 别名优先用例；Redis 真链路未 skip）。
- **真机验证（2026-09-29，通过）**：重启后以 `session_channel` 自发消息，接收侧注入正文为 `[CHANNEL](tui-4a7f65c3-2c35-4d89-9a2c-e4410aa03ba6) D6 真机验证（自动测试可忽略）`——来源可见 ✓（D4 已解决的数据层保持正确）。

## 收尾

（待补）
