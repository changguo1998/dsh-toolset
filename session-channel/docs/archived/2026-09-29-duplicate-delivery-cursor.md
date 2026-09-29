# 重复投递修复：持久游标（接取条目：session-channel「重复投递：回执键 TTL 过期后，会话重启会重新注入旧消息」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

消除「会话重启后重复注入历史消息」：把「发送方等待回执」与「接收方去重」两件事分开——新增**无 TTL 的持久游标键**作为接收方投递位置，`ack:<msgId>` 只服务发送方的 `waitMs` 等待窗口。

## 调研

- 根因（实测）：去重依据是 `ack:<msgId>`（TTL 60s）。TTL 过期后 `isAcked` 判 false；reader 循环对「新跟踪会话」从 `"0"` 起读（`src/index.ts` `noteSession`），于是邮箱流（`MAXLEN ~ 1000`）里的旧消息被重新注入。证据：邮箱流仍有 `1790639300733-0`（`改名后验证`），而 `dsh:session-channel:ack:*` 扫描结果为空（全部过期）。
- 现有游标：`SessionState.lastId`，生命周期仅进程内（`noteSession` 置 `"0"`），重启即丢。
- 相关键位：`inbox:<sid>`（流）、`alive:<sid>`（TTL 15s）、`ack:<msgId>`（TTL 60s）、`meta`。
- 备选修法：Redis Streams 消费组（`XREADGROUP` / `XACK` + PEL / `XAUTOCLAIM`）由服务端管投递状态——更彻底但要引入 consumer 生命周期与 PEL 回收，本轮不做（记入条目「可选升级」）。

## 决策

1. **持久游标键** `dsh:session-channel:cursor:<sessionId>`：值 = JSON `{"id":"<最后成功注入的流条目 id>","ts":<epoch ms>}`，**无 TTL**。
1. **推进时机**：仅当注入成功（`injectUserMessage` 返回 true）后写入；注入失败不推进 → 未投递消息在下次读取时仍会补投。
1. **启动读取**：`noteSession` 后异步读游标；读取完成前该会话不进 reader 的读取集合（`cursorReady` 门），避免「先用 0 读一次」造成的重复窗口；读取失败 → 以 `"0"` 兜底并标 ready（fail-open，宁可补投不漏投）。
1. **去重主依据改为游标**：XREAD 直接以游标 id 为起点，故删除读取循环里的 `isAcked` 逐条跳过（其函数与用例一并移除）；`ackMessage` 保留（发送方 `waitMs`）。
1. **清理**：`start()` 时懒清理——扫描 `cursor:*`，`ts` 超过 7 天（`CURSOR_TTL_MS`）的删除；会话在线与否不参与判定（避免误删活跃会话的历史游标）。

## 规划

1. `src/keys.ts`：加 `cursorKey` / `CURSOR_PATTERN`。
1. `src/broker.ts`：加 `readCursor` / `writeCursor` / `cleanupCursors`；移除 `isAcked`。
1. `src/constants.ts`：加 `CURSOR_TTL_MS`。
1. `src/index.ts`：`SessionState` 加 `cursorReady`；`noteSession` 触发异步载入；reader 只读 ready 会话；注入成功后写游标；`start()` 调清理。
1. 测试：`tests/broker.test.ts`（游标读写/清理、移除 isAcked 断言）、`tests/service.test.ts`（重启后 ack 过期不重复投递；注入失败不推进游标）。
1. 文档：关闭时回写 `session-channel/README.md`（键位表 + 边界：重复投递已修）与 `docs/DESIGN.md`（§3 键位与游标语义、§8 边界）。

计划改动文件清单（**只改这些**）：

- `session-channel/docs/BACKLOG.md`（D1 状态）
- `session-channel/docs/implementation/2026-09-29-duplicate-delivery-cursor.md`（本文件）
- `session-channel/src/{keys,broker,constants,index}.ts`
- `session-channel/tests/{broker,service}.test.ts`
- 关闭时：`session-channel/README.md`、`session-channel/docs/DESIGN.md`

明确不做：消费组（XREADGROUP/PEL）改造、离线队列、委托/状态同步。

## 实现记录

- `src/keys.ts`：`cursorKey(sessionId)`、`CURSOR_PATTERN`（`dsh:session-channel:cursor:*`）。
- `src/constants.ts`：`CURSOR_TTL_MS = 7 天`。
- `src/broker.ts`：`readCursor` / `writeCursor`（无 TTL，值 `{id, ts}`）/ `cleanupCursors`（按 ts 懒清理，形状不符也删）+ 内部 `parseCursor`；移除 `isAcked`（去重主依据改为游标）。
- `src/index.ts`：`SessionState.cursorReady`；`noteSession` 建状态后 `void #loadCursor()`；`#loadCursor` 读游标（读到则作为起点，失败以 `"0"` 兜底并放行）；reader 只取 `cursorReady` 会话（消除「先用 0 读一次」的重复窗口）；`#deliver` 改返回 `boolean`，成功才 `writeCursor`（失败不推进 → 重启仍补投）；`start()` 连接后懒清理过期游标。

## 途中发现（不在本任务范围，已登记模块 backlog D2）

- `connectIntercom` 等含大写 `Intercom` 的标识符未在更名中替换（小写规则未命中）——见 `session-channel/docs/BACKLOG.md` D2（P3）。本任务不改这些文件（`src/client.ts`、各测试文件的引用行除外——本任务本就改 `tests/{broker,service}.test.ts`，但只改游标/回执相关断言，不动 `connectIntercom` 名）。

## 测试与证据

- `tests/broker.test.ts`：新增「投递游标：写入 / 读取 / 懒清理（无 TTL，按 ts 过期删除）」——覆盖写入后可读、TTL = -1、过期游标与形状不符游标被清理、新游标保留；原 `isAcked` 断言改为直接断言 `ack:<id>` 键值。
- `tests/service.test.ts`：原「重启不重复注入」用例改为 D1 回归——投递成功后**手动删除回执键**（模拟 TTL 过期）再重启同会话，断言不重复注入；标题与注释同步为游标语义。
- 结果：`npm --prefix session-channel run test` → 22 例全通过；`npm --prefix session-channel run check` 0 error。
- 真机复验（2026-09-29，通过）：重启前后对比 Redis 状态——游标键值 `ts=1790657907052` 早于本次启动 `1790658088893`，而游标只在注入成功后推进 ⇒ 启动后无成功注入，旧消息未重复投递；随后从另一会话新发一条，接收方正常收到（`[CHANNEL] 游标后第一条`），证明游标不误挡新消息。

## 收尾

- 条目 D1 标记完成并从 `session-channel/docs/BACKLOG.md` 移除（保留未完成项 F1、D2）；本文件移入 `session-channel/docs/archived/`。
- 回写 `session-channel/README.md`：键位表加 `cursor:<sessionId>`、回执键限定为发送方等待窗口；边界条目改为游标语义（含 7 天清理与重投边界）。
- 回写 `session-channel/docs/DESIGN.md`：§3 键位块与「游标语义 / 回执」两条重写（游标无 TTL、读取起点、成功后推进、`cursorReady` 门、懒清理）；§8 补「游标 7 天后被清理 → 该会话重来可能重投历史消息」。
- 途中发现登记：D2（`connectIntercom` 改名遗漏，P3）。
- 门禁：`check` 0 error、`build` 0 error、全仓 16 包 `test` 全绿（session-channel 22 例）。
