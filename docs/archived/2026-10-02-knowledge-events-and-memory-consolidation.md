# 会话事件自动入知识库 + 记忆 auto-consolidation（接取条目：`docs/BACKLOG.md`「会话事件自动入知识库」、「记忆 auto-consolidation（自动巩固）」）

状态：实现　　开启：2026-10-02　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. **会话事件自动入知识库**：把现有「类型白名单写直达」升级为**按规则入库**——过滤规则（类型 + 最小长度 + 拒绝模式）、**隐私边界**（敏感内容不入库）、**容量边界**（项目 token 预算守卫：超限先压缩低价值条目再硬淘汰）；去重与检索沿用现状（`content_hash` 去重 + FTS5 双索引检索）。
1. **记忆 auto-consolidation**：把已存在的 `promote` / `evictStale` / `compress` 组合成**一次巩固**（提升高频高重要度、合并相似条目、淘汰陈旧项），并支持**自动触发**（启动后一次 + `compaction` 完成后，带进程内节流），产出可读报告。

## 调研

**#1 现状（读码）**

- 写直达链路已存在：`hooks.ts` 的 `DEFAULT_PERSIST_TYPES`（`tool/result`、`feedback/record`、`plan/mode`、`goal/change`、`todo/write`、`approval/decided`、`compaction/summary`）→ `summarizeEvent` → `KnowledgeService.put`。
- 已有：按 ~2K token 分块、`content_hash` 去重（chunk 级）、`source.kind = "session"` 溯源、FTS5（porter + trigram）+ LIKE 兜底检索、`tokenBudgetUsage(project)` 只读估算。
- **缺**：① 内容级过滤（当前只看类型；空文本以外不设门槛，也没有最小长度 / 拒绝模式）；② **隐私边界**（无任何敏感内容过滤，密钥 / 令牌形态内容会原样入库）；③ **容量边界**（`tokenBudgetUsage` 只是读数，写入路径无预算守卫，超限不会自动压缩 / 淘汰）；④ 事件入库的观测（`handle` 静默跳过，无法知道「滤掉多少」）。

**#2 现状（读码）**

- 已有显式接口：`promote({project, limit})`（按 `importance × 时间衰减` 排序取候选）、`staleCandidates`（TTL + 低重要度）、`compress(ids)`（正文压成首行 + summary）、`evict(ids)`、写策略 `evictStale({compressFirst})`（先压缩降级再硬淘汰）。
- **缺**：① **合并相似条目**（同 `target` 下重复 / 近似重复内容没有合并动作）；② **组合策略**（提升 → 合并 → 淘汰 目前要调用方自己编排）；③ **自动触发**（README 明示「本插件内无启动 / compaction / 定时触发」，`pending` 为内存态）；④ 巩固结果的报告 / 日志。

## 决策

| # | 决策点 | 选定 | 理由 |
|---|--------|------|------|
| D1 | #1 过滤规则的形态 | 新增 `persistRules`：`{ types?: string[]; minChars?: number; denyPatterns?: string[] }`，与既有 `persistTypes` 并存（`persistTypes` 仍是一等配置，未配 `persistRules.types` 时沿用白名单或 `null`） | 向后兼容（现有 profile 配置不动）；类型 / 长度 / 模式三层是「按规则」的最小完备集 |
| D2 | 隐私边界的实现层 | **入库侧内容过滤**（`denyPatterns` + 内置默认模式：`sk-…` / `Bearer …` / `-----BEGIN … PRIVATE KEY-----` / `password=` / `token=` 等），命中即**整条不入库**并计数 | 与 security-guard（命令 / 文件级防护）职责不重叠：这是「内容写进库」前的最后一道闸；整条拒绝而非打码，避免半脱敏泄漏 |
| D3 | 容量边界的触发点 | 写入路径内的**守卫**：`put` 成功后若 `tokenBudgetUsage(project) > maxTokensPerProject`，按「低重要度 + 最旧」顺序 `compress` 再从最旧 `evict`，直到回落（每次最多 N 条，避免长事务）；配置 `maxTokensPerProject`（缺省不设限） | 条目要求的是「容量边界」而非调度器；放在写入路径可保证「入库后不会无限长」 |
| D4 | #2 合并相似的判据 | 同 `target` 分组内，**归一化后完全相同**或**一条是另一条的子串且长度占比 ≥ 0.8** → 保留 `importance` 高者（同分保留更新者），淘汰其余；报告 `merged` 明细 | 无语义模型可用（本包零模型依赖）；上述判据可机械判定、零误合并风险，语义相似留给后续条目 |
| D5 | #2 提升动作 | 对 `promote` 候选中「被引用过（`last_referenced > created_at`）且 `importance < 5`」的条目 `importance + 1` | 复用既有排序口径；「高频」以「被检索命中过」为机械代理（`search` 会刷新 `last_referenced`） |
| D6 | #2 自动触发时机 | 新增 `autoConsolidate: { enabled?: boolean; onStart?: boolean; afterCompaction?: boolean; minIntervalMs?: number }`：`apply` 后（可选）与 `compaction/end` 事件后（可选）触发一次，进程内按 `minIntervalMs`（缺省 10 min）节流；失败只 `warn` | 与宿主事件面一致（compaction 是知识库天然的低谷点）；节流避免长会话里反复扫库 |
| D7 | 观测口径 | 入库侧与巩固侧都返回 / 记录**计数报告**（`accepted / skippedNoText / skippedPattern / skippedShort / deduped`、`promoted / merged / compressed / evicted`）；巩固报告可经 `provide('knowledge')` 读取最近一次 | 静默跳过不可排查，报告是「自动」类功能的最低可观测性 |

## 规划

### 计划改动文件清单

| 文件 | 改动 |
|------|------|
| `knowledge-base/src/rules.ts` | 新增：过滤规则类型 + `compileRules()` + `checkRules(rules, type, content)`（内置隐私模式 + 自定义 `denyPatterns`）；返回 `{accept, reason}` |
| `knowledge-base/src/hooks.ts` | `SessionHooks` 接 `rules`（类型 / 长度 / 拒绝模式）与容量守卫；`handle` / `handleResult` 返回摄入计数；保留 `persistTypes` 兼容路径 |
| `knowledge-base/src/budget.ts` | 新增：容量守卫 `enforceBudget(kb, {project, maxTokens, ...})`（低重要度 + 最旧 → `compress` → `evict`，返回计数） |
| `knowledge-base/src/consolidate.ts` | 新增：`ConsolidationService`（`plan()` 只读预演 + `run()` 执行）+ 提升 / 合并 / 淘汰三段策略 + 报告类型 + 进程内节流 |
| `knowledge-base/src/index.ts` | Config 扩展（`persistRules` / `maxTokensPerProject` / `autoConsolidate`）；`apply` 里接线（启动后一次 + `compaction/end` 后触发、节流、warn 兜底）；`provide('knowledge')` 暴露 `consolidate()` 与 `lastConsolidation()` |
| `knowledge-base/src/schema.ts` | 需要时补索引（`chunks(project, target, importance)` / `last_referenced`）——先量测再决定 |
| `knowledge-base/tests/rules.test.ts`、`tests/budget.test.ts`、`tests/consolidate.test.ts` | 新增：规则过滤（含隐私模式命中即拒）、容量守卫（压缩 → 淘汰序）、巩固三段（提升 / 合并 / 淘汰）+ 节流 + `plan()` 零副作用 |
| `knowledge-base/tests/hooks.test.ts`（既有则扩） | 规则接入后的跳过计数与 `persistTypes` 兼容 |
| `knowledge-base/src/{knowledge,memory}.ts` | 仅在需要时补查询面（如按 `target` 列候选、`importance` 更新语句）；无必要时不改 |
| `knowledge-base/README.md`、`knowledge-base/docs/DESIGN.md` | 能力 / 配置 / 边界与设计取舍同步（过滤规则、隐私边界、容量守卫、自动巩固触发与节流） |
| `docs/BACKLOG.md`、本追踪文档 | 条目状态与过程记录；关闭时清理并归档 |

## 实现记录

1. **调研（2026-10-02）**：读码确认现状——写直达链路（白名单 → `summarizeEvent` → `put`）、已有接口（`put`/`search`/`touch`/`evict`/`staleCandidates`/`compress`/`tokenBudgetUsage`/`promote`、写策略三接口）；确认缺口四项（内容级过滤、隐私边界、容量边界、入库观测）与 #2 缺口四项（合并相似、组合策略、自动触发、报告）。
1. **决策（2026-10-02）**：D1-D7 见上表（关键取舍：规则向后兼容、隐私整条拒绝、容量守卫放写入路径、合并只做机械判据、提升以「被检索命中过」为代理、自动触发只在静态 project 下、自动类功能必须可观测）。
1. **实施（2026-10-02）**：新增 `src/rules.ts`（三段规则 + 六类内置隐私模式 + 非法模式降级）、`src/budget.ts`（压缩降级 → 小步硬淘汰）、`src/consolidate.ts`（提升 / 合并 / 淘汰编排 + `plan()` 只读预演 + 报告）；`src/hooks.ts` 接规则与容量守卫并加计数与单条结果；`src/knowledge.ts` 补 `budgetCandidates` / `boostCandidates` / `setImportance` / `targetRows`；`src/index.ts` 扩 Config（`persistRules` / `maxTokensPerProject` / `autoConsolidate`）、接自动触发（启动后 + compaction 后 + 节流 + warn 兜底）与 `provide('knowledge')` 的 `consolidate` / `lastConsolidation`；README（能力 / 配置 / 边界 / 测试）与 DESIGN（新增 §7 入库规则与容量 / §8 自动巩固，原 §7 → §9）同步。
1. **实施期调整（2026-10-02）**：容量守卫的硬淘汰步长改为按 `batch` 硬上限（`Math.min(EVICT_STEP, batch - evicted)`）——测试暴露原实现单轮可超 `batch` 条，与文档口径不符。

## 测试与证据

| 命令 / 检查 | 结果 |
| --- | --- |
| `cd knowledge-base && npm run check` / `npm run build` | 0 error |
| `cd knowledge-base && npm test` | `tests 57 / pass 57 / fail 0`（原 39：+ rules 4、budget 3、hooks-rules 6、consolidate 5 = +18） |
| 根 `npm run check` / 根 `npm run test` | `exit 0`（`error TS` 计数 0）/ `exit 0`（16 包全 `OK`，knowledge-base `pass 57`） |
| 隐私边界行为 | `OPENAI_API_KEY=sk-…` 事件 → `accepted:false, reason:"pattern"`、库内 0 条、`stats.skipped.pattern=1`（含 6 类内置模式的样本表测试） |
| 容量边界行为 | 超预算事件 → 先 `compress` 回落（条目保留）；仍超预算 → 按「低重要度 → 最旧」淘汰且高重要度最后（`batch` 上限生效） |
| 自动巩固行为 | 启动后一次（`lastConsolidation` 非空）→ `compaction/end` 再触发；`minIntervalMs` 窗口内跳过（报告不变）；`enabled:false` 完全不跑 |
| 巩固三段行为 | `plan()` 零副作用（报告有候选、库与条目数不变）；提升（被引用条目 3 → 4，未引用不动）；合并（同 target 近似重复保留高重要度并删重复项）；淘汰（TTL 外低重要度先压缩再删） |

## 交接

**状态**：两条条目（「会话事件自动入知识库」「记忆 auto-consolidation」）实现完成、单测与全包验证通过；关文件与条目清理随收尾。

**未做 / 转出**：

1. `docs/STATUS.md` 的 knowledge-base 行单测数仍是 39（本次授权语境只覆盖 task-engine 行）→ 属条目「`docs/STATUS.md` 对齐现状」范围。
1. 跨进程巩固调度不做（无守护进程 / 定时器）——设计取舍，见 DESIGN §8；需要时由宿主或上层显式 `consolidate.run()`。
1. 语义相似合并不做（当前判据是机械的：完全相同 / 子串 + 长度占比）——见 DESIGN §7/§8 与 README 边界。

## 收尾

- 「会话事件自动入知识库」「记忆 auto-consolidation（自动巩固）」：标「完成」并从 `docs/BACKLOG.md` 清理；本文件移入 `docs/archived/`。
- **回写**：`knowledge-base/README.md`（能力 / 配置 / 边界 / 测试计数 39 → 57）、`knowledge-base/docs/DESIGN.md`（§7 入库规则与容量、§8 自动巩固、原 §7 → §9）。
- **临时物**：`tmp/kb-check.log`、`tmp/kb-test.log` 删除。
