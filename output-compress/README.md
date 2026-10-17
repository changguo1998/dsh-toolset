# @dsh-toolset/output-compress

DSH（DeepSeek Harness）进程内插件：把超阈值命令/工具输出压成**确定性摘要 + 切片索引**写进**自持**的 `digest.db`（每会话一个文件），`is_error` 摘要另经 memory-base 的作用域句柄写入知识库——原始大输出不进模型上下文，事后仍可按需检索并定位回原始字节。

## 能力

订阅宿主 `session/event`（`tool/call` 记 `callId → toolName`，`tool/result` 走摘要管线），满足任一条件即触发：

1. **spill 通知**：宿主 spill-policy 已把大输出落盘，事件文本末尾带
   `(Omitted N bytes. Full formatted result stored at: <locator>. ...)`——解析到非空 locator 即触发（权威信号）；
2. **阈值**：无通知时，事件文本 UTF-8 字节数 ≥ `minBytes`（read 工具被宿主豁免 spill，靠此项兜底）。

取回完整输出（读 spill 文件前 `maxSourceBytes` 字节，超出标 `truncated`）后，在沙箱里跑**一段自包含的确定性派生程序**（非 LLM 抽取；首选宿主 `ptcRuntime` 沙箱，服务缺失或运行期不可用时回落 `node:vm`，同一程序源两处执行），产出：

- `stats`：bytes / chars / lines / maxLineLen / avgLineLen；
- `headings`：markdown `#`–`######` 标题（行号 + 级别，≤40 条）；
- `keyLines`：错误类关键词命中行（error/fail/fatal/panic/exception/timeout…，≤20 条，跳过 >400 字符的长行）；
- `slices`：行区间 + 字符区间 + 80 字符预览 + FNV-1a-32 指纹；
- `textFnv`：全文指纹。

摘要渲染为小体积 Markdown（含 session/seq/tool/source/stats 头与 sections / key lines / slices 三段），写入自持 `digest.db`（`digests` 单表 + FTS5，`content_hash` 幂等）；**`is_error` 行**另经 memory-base 的作用域句柄 `put` 写入知识库（`kind = digest`、`tier = session`、`source.kind = tool_result`、importance 取 4），FTS 索引由 memory-base 的库内触发器建立。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sessionDir` | （无） | digest.db 落点的**显式覆盖**；配了就优先用它，且仍要求目录已存在（插件只校验、不 mkdir）。缺省按会话经 `session-paths` 的 `sessionDirFor` 推导 |
| `minBytes` | `16384` | 无 spill 通知时触发摘要的最小文本 UTF-8 字节数 |
| `maxSourceBytes` | `524288` | 读取 spill 文件的字节上限 |

自持 `digest.db`（`application_id = 0x44494745`（`'DIGE'`）、`user_version = 1`）：digests 单表（结构化列 + FTS5）+ 底线闸 + `content_hash` 幂等 + 100 MB 自管容量；落点不可推导（`session-paths` 缺失且无覆盖）或指纹不符即跳过（告警），不向宿主抛错。

## 使用示例

profile 挂载（`~/.dsh/profiles/<p>`）：以 `link:` 依赖指向本包。落点缺省由 `session-paths` 服务按会话推导（该包未挂载时可用 `config.sessionDir` 显式覆盖）；memory-base 可选（缺失时 digest 照常入本地库，仅 `is_error` 摘要不进知识库，并打一次性告警）。

检索 `is_error` 摘要（走 memory-base 的检索面，按 `kind` 过滤）：

```ts
await memory.search({ query: "ENOENT", kind: "digest", tier: "session" });
```

检索本地索引（属主自有入口，只覆盖本会话）：

```ts
searchDigests(db, "ENOENT", { limit: 10 }); // db 即 <会话目录>/digest.db
```

命中结果里带 `L<行号>` 区间与 `C<字符区间>`，用 `read offset/limit` 即可定位回 spill 文件中的原始片段。

## 边界与限制

- **不存原文全文**：原始字节由宿主 retention / spill 负责保留；本插件只写入可检索的摘要与切片索引，不让原文进模型上下文。
- **与官方 `spill-policy` / `compaction-tool-result-pruner` 的分工（不构成双重截断）**：`spill-policy` 决定「超 `maxInlineTokens` 的结果在上下文里留什么」（preview + 落盘通知，原文写 spill 文件；`read` 工具被它内置豁免，故本插件才有阈值兜底这一路）；`compaction-tool-result-pruner` 在压缩时对 tool-result surface 节点做 head/middle/tail 裁剪（免模型、可重放安全）。两者都只改**上下文呈现**，不产摘要、不入库；本插件只在事件流之外有界读取 spill 文件（≤ `maxSourceBytes`）派生摘要并写库，也不改写会话上下文——三方各管一层，唯一重叠的「取数」动作也只是一次有上限的只读。
- **不与 memory-base 建立 npm 依赖**：跨 bundle 只经服务面（`ctx.get('memory')` 的 `registerKind`（拿写入句柄）/ `checkPrivacy`）与一份必须一致的隐私常量（`deny-patterns.ts` 同源复制 + 指纹封印对拍测试）通信。
- **底线闸自足（设计 §5）**：写入前过本包 `deny-patterns.ts` 六类形态模式（与 memory-base 同源复制，跨包指纹封印对拍）；能取到 `ctx.get('memory').checkPrivacy(text)` 则叠加 profile denyPatterns。
- `slices` 片数是**上限 16**：每片行数取 `max(1, ceil(总行数/16))`，行数少时实际片数更少。
- 触发依赖宿主文案：严格正则锚定 spill 通知字面量，宽松正则兜底宿主文案演进；空 locator 的通知回落阈值判定。宿主在同时省略整张图片时会在省略句与定位句之间插入 ` Omitted N images.`，该形态两个正则都不命中 → 回落阈值判定（不会误写，只是少了 spill 权威信号）。
- 失败一律降级：管线内任何抛错都收敛为 `skipped` + 日志；spill 文件暂不可读时降级为「用事件内文本入库」（并在 10s 冷却窗口内不再尝试读该文件）；落点不可推导（`session-paths` 缺失且无覆盖）时该会话整条管线 `skipped.session-dir-missing`；memory-base 缺面时 `is_error` 行停在「未推」（`push_state = 'none'`），句柄就绪后由 `promotePending` 重试——三种情况各只记一次日志。
- 去重表（已处理事件、`callId → toolName`）有容量上限（1024 / 256），超出后**整体清空**（不是淘汰最旧项）；同时保持打开的会话库连接上限 32（超出按最早打开淘汰）。
- 本包 `cordis.patch.yml` 用 dsh 的 `insert` 方言（非 RFC6902 JSON Patch），故刻意不写注释——仓库统一的 `format` 对 YAML 走 python `yq -y -i .`，会丢注释、导致格式化永不收敛；同目录 `.pi-lens.json` 把该文件排除出 `yaml-schema: JSONPatch` 误报。

> **架构（2026-10-17 重定）**：本包**自持 `digest.db`**（I 索引层，属主为本包，**每会话一个文件**、落在宿主会话目录内）；不再共库直写（`kb-write.ts` 已拆除）。`is_error` 行经 memory-base 的**作用域句柄** `put` 写入（`registerKind({kind: "digest", writableTiers: ["session"]})`，提升链 `promote` 已随 memory-base 重设取消）；`searchDigests` / `readDigest` 为属主自有回读入口（命中刷新 `referenced_at`）。I 层容量 100 MB（每会话每文件）与过期由本包自管。

## 测试

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run build   # tsc -p tsconfig.json → dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'
npm run smoke   # node smoke/smoke.mjs（真实 dsh headless 会话，需 dsh CLI 与模型凭据）
```

55 例单测（trigger 9 + summary 9 + digest-db 7 + deny-parity 2 + hooks 28），含真实临时 SQLite 库的写入与去重用例。

设计决策见 `DESIGN.md`。
