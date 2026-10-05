# 共享库写入口径统一（接取条目：`docs/BACKLOG.md`「`knowledge-base` ↔ `output-compress` 共库直写无统一口径」）

状态：关闭（并入 BACKLOG 新条目「重新设计长期记忆模块逻辑」，不单独实施）　　开启：2026-10-05　　关闭：2026-10-05
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

消除 `output-compress` 与 `knowledge-base` 共写同一 SQLite 库时的口径分歧：两包写入共享库的条目应经同一套入库规则（类型白名单 / 最小长度 / 隐私拒绝模式），而不是靠人工同步两份实现。

## 调研

来源：两包源码实测（`grep` + 逐文件阅读），无真机运行。

### 结论

分歧确认存在，且分歧点是**闸门位置**，不是「有没有闸门」：

- `knowledge-base` 的闸门挂在**事件钩子层（调用方）**，不在核心 `put()` 里；
- `knowledge-base/src/knowledge.ts:234 put()` 自身**无任何过滤**；
- `output-compress` **完全不过闸** —— 它有自己的写入器实现，直插同一组表。

即闸门是「调用方自觉」：换一条路调 `put`，闸门就被绕过。

### 证据

**1. knowledge-base 的带闸门写路径**（`knowledge-base/src/hooks.ts`）

```
:301  if (!allowsType(this.#rules, event.type)) return this.#skip("type");   // 类型闸门
:302  const summary = summarizeEvent(event.type, event.data);
:304  const verdict = checkContent(this.#rules, summary.content);            // 内容闸门
:305  if (!verdict.accept) return this.#skip(verdict.reason ?? "empty");
:308  const result = this.#kb.put({ ... });                                  // 落库
```

`checkContent`（`knowledge-base/src/rules.ts:80-92`）判三件事：空文本 / 短于 `minChars` / 命中拒绝模式。拒绝模式含 `DEFAULT_DENY_PATTERNS`（`rules.ts:22-29`）：PEM 私钥、`sk-` 密钥、GitHub token、AWS access key id、Bearer token、`password|passwd|pwd|secret|token|api_key = value` 形态。

**2. 闸门不在核心**

`knowledge-base/src/knowledge.ts:234 put(input: PutInput): PutResult` 内无过滤逻辑。包内另一条写路径 `WritePolicy.writeBack` / `backfill`（`knowledge-base/src/writepolicy.ts:78,96`）同样直接调 `put`，靠调用方先过滤；实测这两条方法**包内无生产调用方**（仅 `knowledge-base/tests/writepolicy.test.ts` 与 `knowledge-base/demo/main.ts` 使用，另经 `bundle.policy` 对外暴露，见 `knowledge-base/src/index.ts:96,130`）。`consolidate.ts` 只做提升 / 合并 / 淘汰，不写入。

**3. output-compress 不过闸**

- `output-compress/src/` 全目录检索 `deny|pattern|secret|redact|persistRules|checkContent` → **零命中**。
- 写路径：`output-compress/src/hooks.ts:348-358` 渲染摘要记录 → `:359-377` 组装 `KbPutInput` → `:378 writer.put(putInput)`。
- 写入器：`output-compress/src/kb-write.ts:111 SharedKbWriter`，自实现 `put()`（`:183`），直插 `sources` / `chunks`（`:202`、`:218-223`）。它只做三件事：库指纹校验（`:145` 比对 `application_id` / `user_version`）、必备表检查（`:164`）、`content_hash` 去重（`:191`、`:215`）——**没有内容闸门**。

**4. 写入内容含逐字原文，不是纯抽象**

摘要由 `renderSummaryRecord` 渲染，上游 `SummaryJson`（`output-compress/src/summary-program.ts:41-49`）含三类**原文**文本：

- `headings[].text` —— section 标题原文
- `keyLines[].text` —— top-N 关键行原文（仅按单行上限截断）
- `slices[].preview` —— 切片首行预览原文

所以工具输出里的凭据形态字符串会被**逐字**带进库，而 `DEFAULT_DENY_PATTERNS` 在写入前没有被检查。触发面举例：`cat .env`、`env`、`curl -H "Authorization: Bearer …"` 这类工具结果。

**5. 服务面不足以承载写入**

`knowledge-base/src/index.ts:273-286` 的 `knowledge` 服务只暴露 `getSummary` / `whenReady` / `consolidate` / `lastConsolidation` —— **没有写入方法，也没有规则判定方法**。

### 硬约束（决定可选方案的空间）

`output-compress/src/kb-write.ts:4-5` 明写设计口径：

> 硬约束：不引入 knowledge-base 的 npm 依赖，也不创建任何表

两包共享面 = **同一个 SQLite 库文件**，仅此。所以「复用同一份规则代码」不能靠 import 实现——两包各自 `files: ["dist", …]` 独立构建，跨包相对 import 会破坏发布契约。

### 影响面

- **隐私**：`output-compress` 是唯一「把工具输出派生后写库」的路径，恰是凭据最易出现的来源。
- **一致性**：两包在 chunk 语义上已刻意对齐（`kb-write.ts:77-79` 注释「移植 knowledge-base 的 chunkContent 行为」），但**规则面没对齐**——属于半对齐：结构对齐、闸门缺失。

### 补充：库实测（2026-10-05，只读打开真库）

库：`~/.dsh/knowledge-base/knowledge.db`，533 MB，`user_version=1`、`application_id=0x4b4e4f57`（指纹与 `kb-write.ts:17-19` 一致）。

结构：12 张表（2 张用户表 `sources` / `chunks` + 10 张 FTS5 影表）、2 个索引、3 个触发器。行数：`sources` 40,503、`chunks` 49,831。

按 `category` 分布：`tool/result` 48,437、`output-compress` 518、`todo/write` 333、`approval/decided` 249、`compaction/summary` 198、`goal/change` 95、`plan/mode` 2。

**用 `DEFAULT_DENY_PATTERNS` 全库回扫（只计命中数，不输出命中内容）：**

| 路径 | 扫描行数 | 命中行数 | 命中日期范围 |
|---|---|---|---|
| `category='output-compress'`（**不过闸**） | 518 | 1（`key = value`） | 2026-09-19 |
| `category='tool/result'`（过闸，对照组） | 48,438 | 90（`key = value` 89 + `sk-` 3） | 2026-09-14 至 2026-10-01 |

**解读：**

1. **闸门有效**：过闸路径在 2026-10-02（`knowledge-base` commit `30a3485`）之后**零命中**。
1. **条目 #1 的机制缺口被实测证实**：`output-compress` 在闸门上线后仍写入 **290 行**（2026-10-02 起 102 / 55 / 128 / 5），全部未过任何内容闸门；这 290 行**恰好**不含凭据形态字符串——是运气，不是防护。
1. **新发现（存量问题，已登记 BACKLOG，不在本条目范围）**：库中存在 91 行闸门上线前的凭据**形态**条目（可能是真凭据，也可能是误报）。命中为形态匹配，需逐条判定。

## 决策

**裁定作废（2026-10-05）**：用户指示将本条目并入新条目「重新设计长期记忆（知识库 / 持久记忆）模块逻辑」，A / B / C 三选一未作裁定、不再单独实施。下列候选方案仅作历史记录，供后续设计阶段参考。

候选方案：

| # | 方案 | 单一规则源 | 引入 npm 依赖 | 改动面 | 风险 |
|---|---|---|---|---|---|
| A | `output-compress` 自带一份拒绝模式表（复制常量 + 指向来源的注释） | ✗ 两份 | 否 | 小（1 包） | 模式表漂移；需加一条「两包常量一致」的测试兜底 |
| B | `knowledge-base` 服务面新增**只读判定**方法（如 `checkContent(text)`），`output-compress` 经 `ctx.get('knowledge')` 调用，命中即跳过写入 | ✓ | 否（运行时服务查找，非 npm 依赖） | 中（2 包，含跨包接口新增） | 服务缺失时的降级口径需明确（安全面应 fail-closed） |
| C | 整条写入路径改经服务面（新增 `put`），弃用 `SharedKbWriter` | ✓ | 否 | 大（2 包，动了既有写入器与库指纹校验 / 去重姿势） | 与「共享面 = 库文件」的既定口径冲突；回归面最大 |

倾向 **B**：真正消除口径分歧（规则单一源），保持 `output-compress`「不引 npm 依赖 + 不建表」的硬约束，且运行时服务查找是本仓既有姿势（先例：`metric-loop` 经 `ctx.get('guard').inspectCommand` 复用 `security-guard` 的判定，见 `metric-loop/src/index.ts:11-18`）。C 的额外收益只是「少一份写入器实现」，却要推翻既定的共享面口径，代价不成比例。

## 规划

**计划改动文件清单（待裁定后收敛；未列出的文件一律不改）**

方案 B 命中时：

- `knowledge-base/src/index.ts` —— 服务面新增判定方法
- `knowledge-base/src/rules.ts` —— 如需导出已编译规则或判定包装
- `output-compress/src/kb-write.ts` —— 写入前调用判定，命中即跳过
- `output-compress/src/index.ts` —— 服务查找接线（`ctx.get('knowledge')`）
- `knowledge-base/tests/`、`output-compress/tests/` —— 新增用例
- 两包 `README.md` —— 写入口径

方案 A 命中时：

- `output-compress/src/kb-write.ts`
- `output-compress/tests/`
- 两包 `README.md`

**明确不做**

- 不改 `knowledge-base/src/knowledge.ts` 的 `put()` 核心签名（只有 C 方案需要）
- 不动 profile patch 的 `dbPath` 配置——共库是既定设计，不是本次问题
- 不新建表、不改 schema（`KB_SCHEMA_VERSION` 保持 1）

## 实现记录

- 2026-10-05：接取条目并标记「进行中」；完成现状调研（含真库实测，见上），**无代码改动**。
- 2026-10-05：用户指示——本条并入 BACKLOG 新条目「重新设计长期记忆（知识库 / 持久记忆）模块逻辑」（该条目已吸收本条与库实测中新发现的两项），本条**不单独实施**；A / B / C 裁定作废。BACKLOG 中对应条目已移除并标记关闭。

## 测试与证据

无测试与实现证据——本任务仅完成调研（只读：源码阅读 + 真库只读回扫），未产生代码改动，故无实现证据。

## 收尾

- 回写文档：仅 `docs/BACKLOG.md`（移除本条目、新增设计条目并登记归入项）与本文件。
- 遗留项：全部转入 BACKLOG 条目「重新设计长期记忆（知识库 / 持久记忆）模块逻辑」的归入项，包括写入口径（原 A / B / C 议题）、`project` 分区、容量边界、存量回扫。
- 归档：本文件由 `docs/implementation/` 移入 `docs/archived/`；`docs/implementation/` 为空目录，不保留。
- BACKLOG 清理：已移除（未完成项只留其他条目）。
