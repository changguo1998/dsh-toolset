# output-compress 设计

## 问题

工具输出（bash 等）经常远超模型上下文经济线。宿主 spill-policy 已把超 `maxInlineBytes`
（默认 50KB）的完整输出落盘、事件内只留 preview + 通知——原文不进上下文，但**模型事后
无法检索其内容、也无法定位回原文**。knowledge-base 插件解决的是「会话知识沉淀」，不覆盖
「单次大输出的可检索摘要」。本插件补上这一环。

## 核心决策

### 1. 触发：spill 通知优先，阈值兜底

- 宿主 spill-policy 已在事件文本尾部追加固定文案
  `(Omitted N bytes. Full formatted result stored at: <locator>. <retrievalHint>)`；
  解析到非空 locator 即触发（`spill-notice`），这是**权威信号**——宿主已裁定超阈值并
  给出落盘位置。
- 无通知时按 `minBytes`（UTF-8 字节，默认 16384 = 16KB）兜底（`threshold`）：宿主未 spill（read 工具豁免
  spill 以防循环）但输出仍值得摘要。
- 严格正则锚定 retrievalHint 字面量做唯一切分（locator 含 `. ` 也不误切）；宽松正则为
  宿主文案演进兜底，并剥除被贪婪捕获吞入的 hint 后缀。

### 2. 派生：单一程序源、确定性、非 LLM

- `SUMMARY_PROGRAM` 是一段自包含 JS（无 import、无模板串、无 `${`），以 async 函数体
  语义运行，只依赖全局绑定 `input.text(0)` 与 `TextEncoder`。
  绑定调用必须**至少带一个参数**：宿主 worker-thread code-runtime 的 `decodeWorkerJson`
  把空参数列表判为非法（`input.length === 0` → undefined → `binding arguments must be lossless JSON`），零参数调用在真实宿主上必然失败（`node:vm` 无此约束，故单测模拟宿主
  严格编解码来守住这条不变量）。
- **同一程序源**跑在两种执行器上：宿主 `ctx.codeRuntime`（worker-thread 隔离）与
  `node:vm` 进程内回落（codeRuntime 缺失时）。单测断言两者输出逐字节一致——
  「同一输入 → 同一摘要」不依赖执行环境。
- code-runtime 是**可选依赖**，只能经 `ctx.reflect.get('codeRuntime', false)` 读取：
  真实宿主 ctx 是 cordis 代理，直接读未 `inject` 的服务属性会抛
  `cannot get property "codeRuntime" without inject`；该异常若发生在 `apply` 期间会让
  cordis 销毁该 fiber 并静默解绑已注册的事件监听（表现为「插件已挂载但零入库」）。
  无 reflect 层的普通对象宿主（测试替身）才直接读 `codeRuntime` 属性，两种语义不混用。
- 派生内容（全部可重算、无随机、无时间戳）：
  - `stats`：bytes/chars/lines/maxLineLen/avgLineLen；
  - `headings`：markdown `#`–`######` 标题（行号 + 级别，≤40 条）；
  - `keyLines`：错误类关键词命中行（error/fail/fatal/panic/exception/timeout/…，≤20 条、
    单行 160 字符截断、跳过 >400 字符的长行）；
  - `slices`：固定 16 片，每片行号区间 + 字符区间 + 首行预览（80 字符）+ FNV-1a-32 指纹；
  - `textFnv`：全文指纹（沙箱内无 crypto，FNV-1a 足够做派生一致性校验）。
- 结果必须可 JSON 无损序列化：runner 侧做 round-trip 归一（顺带把 vm 跨 realm 对象
  原型收敛回本 realm），再经 `validateSummary` 结构校验；非法即抛错、管线降级。

### 3. 写入：共享库文件，零 npm 依赖

- 与 knowledge-base 的通信面是**同一个 SQLite 文件**（dbPath 解析链：
  config → `OUTPUT_COMPRESS_DB_PATH` → `KNOWLEDGE_DB_PATH` → 默认路径）。
- 写前校验指纹（`application_id='KNOW'`、`user_version=1`）+ `sources`/`chunks` 表存在，
  不符抛 `KbNotMountedError`（拒写，绝不半写/误建表）。
- 不建表、不写 FTS 表：`chunks` 的 FTS5 同步由 knowledge-base 的库内触发器完成，
  本插件只做 `sources`/`chunks` 的普通 INSERT，检索复用同一套 FTS。
- 去重与 knowledge-base 同键：source 级全文 `content_hash`、chunk 级 `content_hash`，
  重复事件（seq 去重 + hash 去重双保险）不产生重复行。
- 两个独立连接（knowledge-base 长连接 + 本插件惰性连接），`PRAGMA busy_timeout=2000`
  消化短暂写竞争（WAL 模式）。
- chunk 预算对齐 knowledge-base：2000 token（≈3 字符/token 估）/ 6000 字符硬限，
  段落边界优先、超限硬切。摘要记录本身通常只有 2–4KB，多数情况单 chunk。

### 4. 记录形状（可检索性）

```
# output-compress <tool> <sessionId8>#<seq>
- source: <spill locator 或 session ref>
- bytes/lines/scannedBytes（截断时标注 truncated）
## sections（标题行号索引）
## key lines（L<n>: 截断文本）
## slices (16)（每片：行区间 / 字符区间 / 预览 / fnv）
```

- 标题含工具名与 `sessionId8#seq`：`title` 直接可 grep；
- key lines 含 `ERROR ...` 原文片段：**FTS 召回靠它**（如冒烟里用 marker 词命中）；
- slices 给出行号/字符区间：模型（或人）拿到召回结果后可用 `read offset/limit`
  精确定位回 spill 文件中的原始区间。

### 5. 失败语义

事件管线**永不向宿主抛错**：任何一步（触发、读 spill、沙箱、写库）失败都收敛为
`skipped` + 日志。spill 文件暂不可读时 10s 退避重试；库未挂载时下次事件重试。
确定性程序 + 去重保证重试幂等。

## 明确不做

- 不把原文全文写入 KB（原始字节归 retention/spill 管）；
- 不引入 LLM 摘要（非确定性、延迟、成本都与「可重算的索引」定位冲突）；
- 不依赖 knowledge-base 的 npm 包/服务接口（跨 bundle 只走宿主共享面）；
- 不改宿主 spill-policy 行为，不替换宿主保留策略。
