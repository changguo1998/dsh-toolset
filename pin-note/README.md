# @dsh-toolset/pin-note

DSH（DeepSeek Harness）进程内集成插件：模型把要点登记为「跨压缩保持」后，**上下文里没有这段正文时**补一次；手动压缩把它移出上下文后，下一步立刻补回。

三个模型侧工具：`pin_note`（登记）/ `note_list`（列出）/ `note_remove`（删除）。

## 定位

宿主的压缩（`compaction-basic`）按比例丢弃历史消息，**没有任何「这段别丢」的通道**：goal / todo 各管自己的语义，记忆库（memory-base）只做检索式召回，都不保证「每轮在场」。本插件补的就是这条通道。

## 机制

| 环节 | 做法 |
| --- | --- |
| 存储 | memory-base 的 `pin` 分类，**会话层**（S 层），随会话结束失效 |
| 注入 | `agent/pre-step` 把「保持项」折叠进 `decision.messages`（照宿主 `agent-instructions` 先例） |
| 去重 | 注入前先读当前上下文（`session.deriveMessages()`, 老宿主回退投影比对）, 同一段正文已在上下文里就不再注入；`agent.inbox` 里本插件的待消费消息只留一条 |
| 压缩后 | 上下文里不再有这段正文 → 下一步重新插入（这就是「跨压缩在场」） |
| 删除 / 清空 | 删掉全部条目后不再注入，`inbox` 残留一并清掉 |

保持项在注入消息里长这样：

```
[pin-note] 跨压缩保持项（2 条, 共 86 字；本会话内一直有效）：
1. 风格
   用户的风格要求是短句直述, 少用形容词与比喻。
2. 第 2 条
   实现思路：先定接口再补实现。
```

## 工具面

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `pin_note` | `content`（必填，≥ 20 字）、`title?` | 登记一条；返回 `{id, total, totalChars, hint?}`（`hint` 为超建议体量的提示） |
| `note_list` | 无 | 列出本会话全部保持项（`id` / `title` / 内容摘录 200 字 / 字数）与合计字数 |
| `note_remove` | `id`（正整数） | 删一条；不存在返回 `not_found` |

工具描述写明引导口径：只保留大致思路、用户的风格要求这类要点，不贴大段原文；建议总量 < 10K 字符（**不做硬限制**，超了只提示）。

## 配置

`cordis.patch.yml` 的 `config`：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 显式 `false` 时停止注入（工具仍注册，登记照常写入） |
| `maxNotes` | `50` | 一次读回的最大条数 |

## 边界

- **同一段正文只落一条**：注入消息按 `user/message` + `surfaceOp: append` 进会话日志；上下文里已有同一段正文（按正文比对，不看 source / id）时不再插，压缩把它移出后才会再插一次（这正是目的）。
- **只做会话级**：S 层的库位置按 `sessionId` 解析，其它会话读不到；跨会话保持请用 memory-base 的项目层。
- **每条 ≥ 20 字**：`preWrite` 拒绝过短内容，避免碎片登记把注入撑长。
- **结构性依赖**：读走 `whenReady().tiers.openExisting("session", sessionId)`（`bundle.tiers` 属 memory-base 内部结构面，不是公开服务契约）；全局 `list({tier: "session"})` 不可靠（跳过 S 层，且只遍历已打开的库），故不走它。
- **降级**：`ctx.memory` 缺席或 `registerKind` 抛错时只告警，不注册工具、不注入，不让宿主启动失败。
- 不替换 goal / todo / `present`：那些各有自己的语义与渲染面。

## 测试

```sh
cd pin-note
pnpm run check   # tsc --noEmit（含 tests）
pnpm test        # node --test：存储 8 例 + 注入 6 例 + 接线 17 例
pnpm run build   # 编译到 dist/
```

真机验证（人工）：登记一条 → 下一步的回执里出现 `[pin-note]` 注入 → 手动 `/compact` 后下一步仍出现 → `note_remove` 删掉后不再出现。
