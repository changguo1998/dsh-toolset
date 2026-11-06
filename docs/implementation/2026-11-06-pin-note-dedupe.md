# pin-note 注入按上下文正文去重

接取条目：`docs/BACKLOG.md`「pin-note 注入按上下文正文去重」

## 目标

- 注入前读当前上下文；同一段正文已在上下文里就不再注入；压缩把它移出上下文后才补回；长回合只出现一段。
- 验收：单测覆盖「已在上下文 → 不注入」「上下文没有 → 注入」「内容变化 → 只补新段」；真机会话全文检索 `[pin-note]` 每段只一条。

## 调研

- 现有去重两处：`pin-note/src/index.ts:127`（`claimed` 批次 + `alreadyInSurface` 合成 `supplied`）、`pin-note/src/index.ts:238`（本步决策消息里已有同 payload 直接返回）。
- `alreadyInSurface` 读会话投影的方式是 `session.surface.nodes` + `session.eventAt`（`pin-note/src/index.ts:97`）；宿主 dsh-session 0.2.1-rc.5 已把 `eventAt` / `snapshotEvents` / `ownEvents` 标 `@deprecated`「new calls are prohibited」（`node_modules/.pnpm/@deepseek-ai+dsh-session@0.2.1-rc.5_*/lib/types/index.d.ts:208`），替代读面是 `deriveMessages(): Message[]`（同文件 `:347`）。
- 实测重复：会话 `tui-b39ace72-0f4c-46f9-b5f8-c75c8a09612f` 的 step 79 与 step 84 各落一条 `user/message`，`source.kind` 同为 `pin-note`、`id` 同为 `cfdd75dd-0139-489e-9cb0-9bf6b93b22ba`、正文逐字相同 —— 投影比对没命中，inbox 里的同一条被再次 claim。
- `Message.content` 是 `ContentBlock[]`（`node_modules/.pnpm/@deepseek-ai+dsh-llm@0.2.1-rc.5_*/lib/types/message.d.ts:124`），文本块形如 `{ type: "text", text }`。
- 参考先例：宿主 `agent-instructions` 用 payload 深比较去重（`pin-note/src/inject.ts:5` 注释已记）；本仓 `flow-track` 的去重口径是「同一正文每会话只投一次」（`flow-track/src/index.ts:252`）。

## 决策

1. 去重判据：**a 选定** —— 按渲染后的整段正文相等判断（上下文中任意消息的正文等于目标正文即视为已有）；b. 只比 payload（现状，受 `source` / `id` 差异影响）；c. 按每条保持项分别比对（会在上下文里留多段，违背「只看到一段」）。
2. 读上下文的接口：**a 选定** —— 优先 `session.deriveMessages()`；缺它时回退旧的 `surface` + `eventAt` 路径（测试替身与老宿主仍可用）。
3. 内容变化后的旧段：**b 选定** —— 宿主没有删除历史消息的面，不尝试清理旧段，只保证新段不重复、旧段随压缩自然消失。

## 计划改动文件清单

- `pin-note/src/inject.ts`：新增正文相等工具（从消息里取文本块后比较）。
- `pin-note/src/index.ts`：上下文检查改用 `deriveMessages`，保留旧路径回退；`supplied` 判定改走正文相等。
- `pin-note/tests/inject.test.ts`、`pin-note/tests/main.test.ts`：新增上下文去重与压缩后补回用例。
- `pin-note/README.md`：去重口径与注入时机。

**明确不做**：不改 `store.ts` / `tools.ts`；不改注入渲染格式；不新增配置项；不动 memory-base。

## 实现记录

（实现后补）

## 测试与证据

（实现后补）

## 偏差

（实现后补）

## 收尾

（关闭时补）
