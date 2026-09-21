# @dsh-toolset/output-compress

DSH（DeepSeek Harness）进程内插件：把超阈值命令/工具输出压成**确定性摘要 + 切片索引**写进 knowledge-base 的共享 SQLite 库——原始大输出不进模型上下文，事后仍可按需检索并定位回原始字节。

## 能力

订阅宿主 `session/event`（`tool/call` 记 `callId → toolName`，`tool/result` 走摘要管线），满足任一条件即触发：

1. **spill 通知**：宿主 spill-policy 已把大输出落盘，事件文本末尾带
   `(Omitted N bytes. Full formatted result stored at: <locator>. ...)`——解析到非空 locator 即触发（权威信号）；
1. **阈值**：无通知时，事件文本 UTF-8 字节数 ≥ `minBytes`（read 工具被宿主豁免 spill，靠此项兜底）。

取回完整输出（读 spill 文件前 `maxSourceBytes` 字节，超出标 `truncated`）后，在沙箱里跑**一段自包含的确定性派生程序**（非 LLM 抽取），产出：

- `stats`：bytes / chars / lines / maxLineLen / avgLineLen；
- `headings`：markdown `#`–`######` 标题（行号 + 级别，≤40 条）；
- `keyLines`：错误类关键词命中行（error/fail/fatal/panic/exception/timeout…，≤20 条，跳过 >400 字符的长行）；
- `slices`：行区间 + 字符区间 + 80 字符预览 + FNV-1a-32 指纹；
- `textFnv`：全文指纹。

摘要渲染为小体积 Markdown（含 session/seq/tool/source/stats 头与 sections / key lines / slices 三段），经共享库写入器写进 knowledge-base 的**同一个** SQLite 文件（`category`、`target` 均为 `output-compress`，`source.kind = tool_result`，importance 按 isError 取 4 / 2），FTS 索引由 knowledge-base 的库内触发器自动建立。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dbPath` | `OUTPUT_COMPRESS_DB_PATH` → `KNOWLEDGE_DB_PATH` → `~/.dsh/knowledge-base/knowledge.db` | 共享库路径，必须与 knowledge-base 一致 |
| `minBytes` | `16384` | 无 spill 通知时触发摘要的最小文本 UTF-8 字节数 |
| `maxSourceBytes` | `524288` | 读取 spill 文件的字节上限 |
| `kbRetryDelays` | `[1000, 2500, 5000, 10000]` | 库未挂载时的重试退避序列（ms） |
| `project` | `"default"` | 摘要记录的 project 维度（字符串或按调用上下文求值函数） |

写前校验库指纹（`application_id = 0x4b4e4f57`（`'KNOW'`）、`user_version = 1`）与 `sources`/`chunks` 表存在，不符即拒写（`KbNotMountedError`），事件管线降级为 `skipped`，不向宿主抛错。

## 使用示例

profile 挂载（`~/.dsh/profiles/<p>`）：以 `link:` 依赖同时指向本包与 knowledge-base，两者共享同一 `dbPath` 表达式，然后 `dsh --profile <p>` 启动。

检索摘要记录（走 knowledge-base 的检索面，按 category 过滤）：

```ts
bundle.kb.search({ query: "ENOENT", category: "output-compress", project: "default" });
```

命中结果里带 `L<行号>` 区间与 `C<字符区间>`，用 `read offset/limit` 即可定位回 spill 文件中的原始片段。

## 边界与限制

- **不存原文全文**：原始字节由宿主 retention / spill 负责保留；本插件只写入可检索的摘要与切片索引，不让原文进模型上下文。
- **不与 knowledge-base 建立 npm 依赖**：跨 bundle 只通过共享库文件这一宿主共享面通信，因此**不建表、不写 FTS 表**——`chunks` 的索引同步完全依赖 knowledge-base 的库内触发器。
- `slices` 片数是**上限 16**：每片行数取 `max(1, ceil(总行数/16))`，行数少时实际片数更少。
- 触发依赖宿主文案：严格正则锚定 spill 通知字面量，宽松正则兜底宿主文案演进；空 locator 的通知回落阈值判定。
- 失败一律降级：管线内任何抛错都收敛为 `skipped` + 日志；spill 文件暂不可读时降级为「用事件内文本入库」（并在 10s 冷却窗口内不再尝试读该文件），库未挂载时按 `kbRetryDelays` 主动重试（最多 4 次，绕过去重）后放弃。
- 去重表（已处理事件、`callId → toolName`）有容量上限，超出后按插入顺序淘汰最旧项。
- 本包 `cordis.patch.yml` 用 dsh 的 `insert` 方言（非 RFC6902 JSON Patch），故刻意不写注释——仓库统一的 `format` 对 YAML 走 python `yq -y -i .`，会丢注释、导致格式化永不收敛；同目录 `.pi-lens.json` 把该文件排除出 `yaml-schema: JSONPatch` 误报。

## 测试

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run build   # tsc -p tsconfig.json → dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'
npm run smoke   # node smoke/smoke.mjs（真实 dsh headless 会话，需 dsh CLI 与模型凭据）
```

42 例单测（trigger 9 + summary 9 + kb-write 9 + hooks 15），含真实临时 SQLite 库的写入与去重用例。

设计决策见 `DESIGN.md`。
