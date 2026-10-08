# output-compress 设计

## 1. 问题

工具输出（bash 等）经常远超模型上下文经济线。宿主 spill-policy 已把超 `maxInlineTokens`（`dsh-base` 装配值 12500 token，见 `dsh-base/cordis.patch.yml` 的 `spill-policy` 行）的完整输出落盘、事件内只留 preview 与通知——原文不占上下文，但**模型事后无法检索其内容，也无法定位回原文**。memory-base 解决的是「会话知识沉淀」，不覆盖「单次大输出的可检索摘要」，本插件补上这一环。

与另外两条官方「结果面」通道的分工（三方各管一层，**不构成双重截断**）：

| 组件 | 管什么 | 改上下文？ | 产摘要 / 入库？ |
| --- | --- | --- | --- |
| `spill-policy`（宿主，已挂载） | 超阈值结果在上下文里留什么：preview + 落盘通知，原文写 spill 文件；内置豁免 `read` 工具 | 是（替换结果内容） | 否 |
| `compaction-tool-result-pruner`（宿主，已挂载，`ctx.toolResultPruner`） | 压缩时对 tool-result surface 节点做 head/middle/tail 裁剪（免模型、可重放安全） | 是（裁剪历史呈现） | 否 |
| 本插件 | 读 spill 文件做确定性派生，把摘要 + 切片索引写进共享库 | 否 | 是 |

唯一重叠的动作是「取数」：本插件从 spill 文件有界读取 ≤ `maxSourceBytes` 字节，只读、不动原文。

## 2. 触发：spill 通知优先，阈值兜底

- 宿主已在事件文本尾部追加固定文案 `(Omitted N bytes. Full formatted result stored at: <locator>. <retrievalHint>)`；解析到非空 locator 即触发（`spill-notice`）——宿主已裁定超阈值并给出落盘位置，这是权威信号（同时省略整图时省略句后还会插一段 ` Omitted N images.`，该形态不命中正则、回落阈值判定）。
- 无通知时按 `minBytes`（UTF-8 字节，默认 16384）兜底（`threshold`）：宿主对 read 工具豁免 spill（防「读 spill 文件又生成 spill」的循环），其输出仍可能值得摘要。
- 解析用严格正则锚定 retrievalHint 字面量做唯一切分（locator 本身含 `. ` 也不会误切），宽松正则兜底宿主文案演进，并剥除被贪婪捕获吞入的 hint 后缀；只认文末通知。
- 空 locator 的通知不视为权威信号，回落阈值判定。

## 3. 派生：单一程序源、确定性、非 LLM

`SUMMARY_PROGRAM` 是一段自包含 JS（无 import、无模板串、无 `${`），按 async 函数体语义运行，只依赖全局绑定 `input.text(...)` 与 `TextEncoder`。

- 绑定调用必须**至少带一个参数**：宿主 PTC 沙箱（`ptc-runtime-node`）的绑定参数解码（`decodePtcJsonWire`）把空参数列表判为非法（`length === 0` → undefined → `binding arguments must be lossless JSON`），零参数调用在真实宿主上必然失败；`node:vm` 无此约束，故单测模拟宿主的严格编解码来守住这条不变量。
- 派生内容全部可重算（无随机、无时间戳），输出带 `version`（当前 1）并强校验，便于日后识别摘要来源版本。
- 结果必须可 JSON 无损序列化：runner 侧做 round-trip 归一（顺带把 vm 跨 realm 对象原型收敛回本 realm），再经 `validateSummary` 结构校验；非法即抛错、管线降级。
- 精确阈值：headings ≤40 条（单标题 1–120 字符）、keyLines ≤20 条（跳过 >400 字符长行、单行截断 160 字符）、slices ≤16 片（每片 `max(1, ceil(行数/16))` 行）、每片预览 80 字符、指纹 FNV-1a-32（沙箱内无 crypto，FNV 足够做派生一致性校验）。

## 4. 执行沙箱：宿主 PTC 运行时可选，`node:vm` 回落

- 首选宿主 `ctx.ptcRuntime`（`ptc-runtime` 缝，`ptc-runtime-node` 实现为沙箱 Node 进程；0.1.7 由 `code-runtime` 改名）；未挂载或运行期不可用时回落 `node:vm`（进程内，默认 30s 超时）执行**同一程序源**——「同一输入 → 同一摘要」不依赖执行环境。
- `ptcRuntime` 是**可选依赖**，只能经 `ctx.reflect.get('ptcRuntime', false)` 读取：真实宿主 ctx 是 cordis 代理，直接读未 `inject` 的服务属性会抛错，该异常若发生在 `apply` 期间会导致监听未注册（表现为「插件已挂载但零入库」）。无 reflect 层的普通对象宿主（测试替身）才直接读属性，两种语义不混用。

## 5. 写入：共享库文件，零 npm 依赖

- 与 memory-base 的通信面是**同一个 SQLite 文件**（dbPath 解析链见 `README.md` 配置表）。
- 写前校验指纹（`application_id = 0x4b4e4f57`、`user_version = 1`）+ `sources`/`chunks` 表存在，不符抛 `KbNotMountedError`（拒写，绝不半写或误建表）。
- 不建表、不写 FTS 表：`chunks` 的 FTS5 同步由 memory-base 的库内触发器完成，本插件只做 `sources`/`chunks` 的普通 INSERT，检索复用同一套 FTS。
- 去重与 memory-base 同键：source 级 `(content_hash, kind)`、chunk 级 `content_hash`（均 sha256），重复事件不产生重复行；`chunk_count` 只按实际新增块数增量更新。
- `PRAGMA busy_timeout = 2000` 消化与 memory-base 长连接的短暂写竞争（WAL 模式）。
- chunk 预算对齐 memory-base：2000 token（≈3 字符/token 估算）/ 6000 字符硬限，段落边界优先、超限硬切。
- **共库直写的边界（与 memory-base 口径一致）**：本包只做「库指纹校验 + `content_hash` 去重」，memory-base 的入库规则（`persistRules` 隐私拒绝模式 / `minChars`）、容量守卫（`maxTokensPerProject`）与 `hooks.stats` 计数**不覆盖**本包的写入；反向地，memory-base 的淘汰 / 自动巩固 / 容量守卫按 `chunks` 全表作业，会一并作用到本包写入的行（`category`/`target` 均为 `output-compress`、importance 取 4/2，TTL 到期后同样先压缩降级再硬淘汰）。对端口径见 `memory-base/README.md`「边界与限制」与 `memory-base/docs/DESIGN.md` §9。

## 6. 记录形状（可检索性）

摘要记录正文（Markdown）：

```
# output-compress 摘要
- session / seq / tool / source（spill locator，或 inline-event-text 标注）
- retrieval（宿主 retrievalHint）/ totalBytes / scannedBytes（截断时加注）
- fingerprint(fnv1a32) / stats: lines= bytes= maxLine= avgLine=
## sections (<n>)   标题行号索引
## key lines (<n>)  L<行号>: 截断文本
## slices (<n>)     #<序号> L<起>-<止> C<起>-<止> fnv=<指纹> "<预览>"
```

- 知识库行的 `title` 另带工具名与 `sessionId8#seq`，便于直接 grep；`category`/`target` 固定为 `output-compress`，检索时按此过滤。
- **FTS 召回主要靠 key lines 的原文片段**（错误文本留在记录里）；slices 给出行号/字符区间，模型或人拿到召回结果后可用 `read offset/limit` 精确定位回 spill 文件中的原始区间。

## 7. 失败与重试语义

事件管线**永不向宿主抛错**：除下述降级路径外，任何一步（触发、取 spill、沙箱、写库）失败都收敛为 `skipped` + 日志。

- **spill 文件暂不可读**：不 skipped，而是降级为「用事件内文本继续入库」；该 locator 进入 10s 冷却窗口，窗口内不再尝试读取（本次不重试读）。
- **库未挂载**：按 `kbRetryDelays`（默认 1s / 2.5s / 5s / 10s）主动定时重试写入，最多 4 次；重试绕过事件 seq 去重（内容 hash 去重仍生效，故重试幂等），`dispose` 时清理定时器。
- 无触发条件或文本为空时返回 `none`，不做任何写入。

## 8. 明确不做

- 不把原文全文写入知识库（原始字节归宿主 retention / spill 管）；
- 不引入 LLM 摘要（非确定性、延迟、成本都与「可重算的索引」定位冲突）；
- 不依赖 memory-base 的 npm 包或服务接口（跨 bundle 只走宿主共享面）；
- 不改宿主 spill-policy / compaction-tool-result-pruner 的行为，也不改写会话上下文（呈现层职责归它们；分工见 §1 表）。
