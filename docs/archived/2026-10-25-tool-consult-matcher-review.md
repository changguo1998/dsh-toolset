# 评估 tool-consult 的匹配算法与预览上限（接取条目：`docs/BACKLOG.md`「tool-consult matcher 评估」）

状态：已关闭　　开启：2026-10-25　　关闭：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点; 计划外的文件不改。
首轮只建立文档 (接取), 调研与实现均未开始; 2026-10-25 补调研轮: 只读实验, 未改代码, 仓库内只改本文件.

## 目标

依据真实误用样本评估 `tool-consult` 的 BM25 参数、短语加成与 `oneLine` 预览上限是否需要调整；无证据不动算法。

## 调研

已知量: `K1 = 1.2` / `B = 0.75` (`tool-consult/src/matcher.ts:58-59`), 名称精确 +20 / 包含 +10 / 描述包含 +4 (`:155-159`), 预览上限 80 字符 (`:96-101`); 描述与别名修完后真机 12 条查询达标 (`docs/archived/2026-10-24-tool-description-review.md`「收尾」).

### 1. 打分链路

1. 语料与索引: `tool-consult/src/main.ts:181-190` 把宿主 `tools.schemas()` 投影成 `{name, description, parameters}`, 交给 `createMatcher`. `indexDoc` (`tool-consult/src/matcher.ts:68-93`) 按字段加权累加词频: 名称 6 / 名称前缀 3 / 别名 4 / 工具级描述 2 / 参数键名 1 (`:49-55`); 文档长度取加权词频之和 (`:90-92`), df 按 token 计.
2. 分词: `tool-consult/src/tokenize.ts:97-142`. ASCII 先按非字母数字边界切分, 再按驼峰切分, 转小写, 单字符与停止词丢弃 (`:102-109`); CJK 取二元组, 单字串回落为单字 (`:110-119`). 文档侧保留词频, 查询侧 `uniqueTokens` 去重 (`matcher.ts:140`).
3. BM25: `idf = ln(1 + (N - df + 0.5) / (df + 0.5))` (`matcher.ts:132-135`); 长度归一化 `norm = 1 - B + B * len / avgLen`, 单个命中项 `idf * f * (K1 + 1) / (f + K1 * norm)` (`:150-152`).
4. 短语加成: `phrase` 是整条去掉首尾空白的查询 (小写); 名称全等 +20, 名称包含 +10 (`phrase` 长度至少 2), 描述包含 +4 (`matcher.ts:141`, `:155-159`). 三项都是整串子串比较, 只有查询恰好等于名称或出现在描述里时才触发.
5. 排序与数量: 分数降序, 同分按名称字典序 (`:163`); `slice(0, limit)` (`:164`); limit 缺省取 `config.maxResults = 5` (`tool-consult/src/config.ts:78`), 硬上限 20 (`tool-consult/src/tool.ts:17`).
6. 预览: 每条命中经 `oneLine` 渲染成回执的一行 (`tool.ts:116`, `:130`, `:218`, `:248`); `oneLine` 折叠空白, 取首个 `。！？.!?` 之前 (含标点), 超过 max (缺省 80) 时切到 79 字符再加 `…` (`matcher.ts:96-101`). 预览只影响回执文本, 不参与打分与排序.
7. 测试面: `matcher.test.ts:21-80` 8 条单测只断言名次与 `oneLine` 边界, 不写死分数; `retrieval.test.ts:204-311` 的 19 条查询只断言名次 (`top-1` 或 `top-N`), fixture 自称守「matcher + aliases + 措辞模式」(`:1-8`).

### 2. 实验方法 (只读)

- 临时脚本放 `/tmp`, 直接 `import` 仓库的 `matcher.ts` / `tokenize.ts` / `aliases.ts`; fixture 从 `tool-consult/tests/retrieval.test.ts` 求值 `DOCS` / `CASES`, 不复制, 不改仓库.
- 自检: 用同一套实现重算 19 条查询, 与 `matcher.ts` 的分数完全一致 (差 < 1e-9), 证明消融结论不是实现差异造成的.
- 真实措辞语料: 从 21 个源文件只读提取 44 条工具级描述 (script_run 的描述由函数动态拼装, consult_tools 未取到); 替换 fixture 中同名的 42 条, 其余 8 条仍是 fixture 占位 (6 条宿主工具 + script_run + consult_tools). 参数键名未提取 (权重 1), 语料合计 50 条.
- 口径: 绝对分不可与真机对数, 只用于同一次模拟内的相对比较; 下文「真实语料」都指这份 50 条混合语料.

### 3. 长度归一化

- fixture: 50 条, 平均加权长度 74.6, 最长 137 (`channel_delegate`, 1.8 倍), 最短 39 (`bash`); freq=1 的单次命中饱和项, 最长文档是均值文档的 74%, 最短是 124%.
- 真实语料: 平均 185, 最长 361 (`ast_query`, 2.0 倍), 最短 39; 最长文档 71%, `md_logic` (描述 330 字符, 加权 271, 1.47 倍) 84%.
- `B = 0.75` 下长度倍数与单次命中权重的对照:

| 长度 / 均值 | 单次命中权重 |
| --- | --- |
| 1.0 | 100% |
| 1.5 | 83% |
| 2.0 | 71% |
| 3.0 | 55% |
| 4.0 | 45% |

- 消融 (fixture): `B` 取 0 / 0.25 / 0.5 / 0.75 / 1, `K1` 取 0.3 / 0.9 / 1.2 / 1.6 / 2.2, 19 条断言全部通过, 无一失败.
- 消融 (真实语料): `B = 0` 与 `B = 1` 时 12 条查询的 top-1 无变化; 19 条断言失败数都是 3, 失败查询相同 (`B = 0` 时「规则管理」的误命中者从 `rule_test` 变成 `agent_group`).
- 判断: 描述改写后最长 / 均值被压到 2.0 倍, 长度惩罚上限约 29%; 没有观察到被长度归一化翻盘的案例. 历史上 `md_logic` 855 字符被压到第三 (`docs/archived/2026-10-24-tool-description-review.md` 的检索模拟) 已随描述缩短消失. fixture 对 `B` / `K1` 完全不敏感, 现有守护测试守不住这两个参数, 这也是「无证据不动」的另一条理由.

### 4. 短语加成

- 触发面: 19 条断言里 top-1 吃到描述加成的有 5 条, 加成占总分 15% 至 45% (命令历史 21% / 规则管理 22% / 契约 37% / 偏好 45% / 上下文用量 15%); 名称 +20 / +10 一次未触发 (查询是中文, 名称是英文), 只在用户直接输入工具名时起作用.
- 真实语料上 3 处排序偏差, 其中 2 处由 +4 决定:
  - 「跨会话委托」: `task_status` 14.80 = BM25 10.80 + 4, 压过 `channel_delegate` 14.01; 撤掉 +4 后 `channel_delegate` 反超 3.2 分. 触发文本是 `task_status` 描述里的「跨会话委托任务查 channel_task」(`task-engine/src/tools.ts:359`); `30fe04f` 只删了 `task_stop` 的同款措辞, 这处仍在.
  - 「改文件」: `hash_edit` 10.14 = BM25 6.14 + 4, 压过 `edit` 8.71; 撤掉 +4 后 `edit` 首位. 触发文本是「按 LINE:HASH 锚点改文件」(`hash-edit/src/main.ts:328`). fixture 里 `hash_edit` 是另一套措辞, 不含「改文件」, 所以断言 `edit` top-1 与源码措辞不一致; 真机当时接受的结果是「`hash_edit` / `edit` 前列」.
  - 「规则管理」: 与加成无关, `rule_add` 现描述 (`rule-engine/src/tools.ts:160` 起) 不含「规则管理」四字, 别名只有 加规则 / 注入规则, 而 fixture 写的是「规则管理入口之一」(`retrieval.test.ts:167`).
- 12 条真机查询在真实语料里 11 条复现为期望首位, 唯一偏差是「跨会话委托」; 19 条断言另有「改文件」「规则管理」两处不一致 (前者真机当时接受 `hash_edit` / `edit` 前列, 后者只在 fixture 里成立).
- 加成倍数消融 (真实语料): 描述加成改 0 或 2 时, 前两处回到测试期望, 12 条查询其余 10 条 top-1 不变, 19 条断言失败从 3 降到 1 (只剩规则管理); 改成 8 时两处偏差都还在, 「跨会话委托」的余量反而变大.
- 风险: 描述加成是「整串命中」的强信号, 正例 (命令历史 / 上下文用量) 也靠它拉开余量; 降权后这些正例仍首位, 但余量下降; 且 fixture 在加成倍数 0 到 2 之间全绿, 守护测试测不出影响.

### 5. 预览上限

- 真实 44 条描述: 首句长度中位 52, p90 69, 最长 80 (`task_status`), 超过 80 的 0 条; 预览合计 2336 字符, 占描述总字符 8905 的 26%.
- 上限改成 100 / 120 / 160, 触发数都是 0, 回执总字符不变 (2336). 80 上限当前不构成截断.
- 真正丢信息的是「只取首句」: 含指路 / 约束类措辞 (用某个工具 / 别用 / 改用 / 不要 / 指向) 的内容落在首句之后的有 27 / 44 条; 前两句合计 5801 字符 (中位 124, 最长 306), 约为现在的 2.5 倍.
- fixture 的描述中位 30 字符, 最长 70, 够不到 80 上限, 两端都不会触发截断.

### 6. 「停止任务」歧义

- 真实语料: 「停止任务」→ `task_stop` 14.32 (查询三个 token 全部命中别名「停止任务」, `tool-consult/src/aliases.ts:30`), `channel_task` 只有 2.60 (只中「任务」).
- 取消语义本身可达: 「取消任务」→ `channel_task` 15.73 首位; 「取消委托」→ `channel_task` 17.10 首位; 「停掉任务」→ 候选都在 2.4 至 2.6 分区间, 无有效信号 (二元组要求连续子串, 「停掉」与「停止」不共享二元组).
- 别名迁移假设 (把「停止任务」挪给 `channel_task`): 该查询 `channel_task` 13.68 首位, 但「停止任务 → task_stop」的验收召回断言失败, `task_stop` 失去主要检索入口; 不推荐.
- 判断: 词义与命名问题, 不是排序参数问题; 现描述已写「取消委托用 channel_task」(`task-engine/src/tools.ts:355`), 维持现状.

### 7. 顺带观察

- `tool.ts:207` 的注释说 `consult_tools` 不在检索索引里, 但 `main.ts:181-190` 只做投影, 没有过滤它; 实际会多一条候选 (模拟里「查找引用」第三名是 `consult_tools` 4.60). 影响很小, 本任务不改, 记此备查.
- fixture 的「目标措辞」与源码措辞存在漂移 (规则管理 / 改文件两处), 说明 `retrieval.test.ts` 守的是措辞模式, 不是源码现状; 需要时可另开条目补真实措辞守护测试.

### 8. 判断

- 维持现状 (有证据): `K1` / `B` 不改 (消融不改变任何 top-1, 长度倍数 2.0 倍时惩罚上限 29%); 预览 80 不改 (0 条触发, 调大无收益); 「停止任务」别名不改 (迁移会丢验收召回).
- 需要处置 (证据充分): 「跨会话委托」的排序. 优先改 `task_status` 的描述措辞, 与 `30fe04f` 同款做法; 算法层收紧 (描述加成 4 → 2) 作为备选, 风险见上. 改完须重启会话复验 (`30fe04f` 之后本应做, 归档文档记的是「需重启再确认」).
- 不建议: 为排序改工具名或参数 schema; 无样本改 `K1` / `B`; 把预览上限调大 (无观测收益).

## 决策

2026-10-25 已裁定, 取舍按既定判断原则（无证据不动、描述层优先、不降召回、守护测试须反映源码现状、词义歧义归意图分流类、无观测收益不调、改完重启会话复验）:

| 决策项 | 裁定 |
| --- | --- |
| 3 预览上限 | 对齐 lint 首句规则: `oneLine` 上限 80 → 128（句号或 128 先到）, 与 S1 同口径 |
| 7 意图分流整类 | 双层配套: 描述层（各动作族在 `边界`/`相关` 写意图分界, 含 task_status、task_stop / channel_task 措辞）+ 运行时层（查询精度不足时提示「请提供更多细节」, 引导补足意图维度） |
| 5 真实措辞守护语料 | 在 matcher 任务内做（不另开条目）, 用真实 44 条 + 8 占位建守护语料, 并吸收「改文件」fixture 对齐（原决策 2） |
| 4 停止任务 | 并入决策 7（与跨会话委托同属意图歧义整类）; 别名不迁移（保住 task_stop 召回）, 靠意图分界 + 提示分流 |
| 6 consult_tools 排除 | 并入决策 5 的守护语料工作顺带处理 |

归并说明: 原决策 1（跨会话委托）、4（停止任务）→ 7; 原决策 2（改文件 fixture 漂移）→ 5。当前独立决策项仅 3、5、7 三项, 见「待决策项」。
职责分工（2026-10-25）: 决策 7 的**描述层**（各动作族 `边界`/`相关` 意图分界与 task_status / task_stop 措辞）由 **lint 任务**改; 本任务（matcher）**只做算法层**（`matcher.ts` / `tool.ts`）。决策 7 运行时层「查询精度不足」的**判断标准稍后讨论**, 不随本批实现。

## 规划

计划改动文件清单（开工时定稿）:

- `tool-consult/src/matcher.ts`: `oneLine` 上限 80 → 128（决策 3）
- `tool-consult/src/tool.ts`: 查询精度不足时的「请提供更多细节」提示（决策 7 运行时层, 判断标准待定后实现）
- `tool-consult/tests/retrieval.test.ts` + 守护语料（决策 5, 含原决策 2）: 在 matcher 任务内做, fixture 对齐源码, 断言改「`edit` 或 `hash_edit` 进 top-2」; 顺带处理 consult_tools 索引排除
- 描述层意图分界（决策 7）: 由 **lint 任务**改各工具描述, 本任务不落笔

明确不做:

- 无真实误用样本不改权重（K1 / B / 描述加成）。
- 不为改善排序去改工具名或参数 schema。
- 不降现有 top-1 检索断言; 别名不迁移（保住 task_stop 验收召回）。

## 实现记录

2026-10-25 实现（本批只做决策 3 与 5；决策 7 运行时层按分工不实现，见「偏差」第 6 条）。

1. 决策 3 预览上限（`tool-consult/src/matcher.ts:95-110`）：`oneLine` 缺省上限 80 → 128（常量 `PREVIEW_MAX`），并把句尾判定对齐 lint S1——中文 `。！？` 直接断，ASCII `.` `!` `?` 需后接空白 / 句尾 / 非 ASCII 字符（避开 `patch.text`、`**/*.md` 这类词内点）。旧实现见句点即断，会把 `rule_update` 的预览切成 `…；patch.`。
2. 决策 5 守护语料（新增 `tool-consult/tests/fixtures/real-descriptions.ts`）：`REAL_DESCRIPTIONS` 44 条（各包源码里工具级 `description` 的逐字提取，不含参数名——参数键名权重 1，不影响本语料要守的加成 / 长度参数）、`PLACEHOLDER_DESCRIPTIONS` 8 条（6 宿主核心 + `script_run` + `consult_tools`）、`CORPUS_DOCS` 52 条、`INDEXED_DOCS`（排除 `consult_tools`，与生产索引同口径）。
   提取方式：按 `name: "<工具名>", description:` 取字符串拼接 / 模板 / 数组 `join`；`task-engine` 的 `decompose("<动作>", ...)`、`herdr-use` 的 `makeTool(deps, "<动作>", ...)`、`TOOL_NAME` 形态各自按工厂调用点取；标识符（`DESCRIPTION` / `TOOL_DESCRIPTION` 等）递归求值。一次性脚本放 `tmp/`，用完删除。
3. 决策 5 测试对齐（`tool-consult/tests/retrieval.test.ts`）：语料换成 `INDEXED_DOCS`；断言结构改为 `want: readonly string[]` + `topN`（多候选取其一），query 与 `why` 保留并改写证据。「改文件」→ `edit` / `hash_edit` 进 top-2（源码里 `hash_edit` 描述含「按 LINE:HASH 锚点改文件」，吃 +4 加成排首位）。「规则管理」用例换成「加规则」→ `rule_add` top-1（源码规则族描述不含「规则管理」四字，检索入口是别名「加规则」）。新增「取消任务」→ `channel_task` top-1（停止 / 取消两半各守一条）。新增语料结构断言（52 条、描述非空、名称唯一）与索引排除断言。
4. 决策 5 顺带项 consult_tools 索引排除：`tool-consult/src/main.ts:186-198` 的 `buildMatcher` 过滤 `CONSULT_TOOL_NAME`；`tool-consult/src/tool.ts:207-209` 的注释改为指向该实现；`tool-consult/tests/main.test.ts` 新增一条用例（工具面里带 `consult_tools` 时，按用途查询不再把它当候选）。
5. `tool-consult/tests/matcher.test.ts`：新增 2 条——缺省上限 128（超限以省略号收尾、128 以内不截断）与「ASCII 词内点不断句」（`patch.text` / `**/*.md` / 英文句尾点）。

## 偏差

1. 决策 3 的落地范围略大于「80 → 128」字面：同时把 S1 的 ASCII 句号规则落地了。依据是任务书写的是「与 lint S1 首句规则同口径」；只改数字仍会在 `rule_update` 处切在 `patch.` 上，口径无从对齐。实测只影响 1 条预览（见「测试与证据」第 2 条），回退只需把 `SENTENCE_END` 换回 `/[。！？.!?]/` 并 `slice(0, cut + 1)`。
2. 「规则管理」用例是替换，不是放宽：真实语料下该查询 `rule_test` 4.12 第一、`channel_task` 4.05 第三、`rule_add` 3.77 第六，规则族之间本就无区分度（四字短语在源码里不存在）；换成源码真实入口「加规则」（`rule_add` 9.56 top-1）比保留一条只能断言到前六的用例更有护栏价值。
3. 「跨会话委托」top-1 断言以 `skip` 挂起（`retrieval.test.ts` 末尾）：真实语料下 `task_status` 14.97 仍压 `channel_delegate` 14.30，成因是 `task_status` 描述里的「跨会话委托任务查 channel_task」吃 +4 描述加成。该措辞归 lint 任务（决策 7 描述层），本任务不改描述；同时保留一条 top-2 的强制断言守住现网顺序。skip 的解除条件写在用例注释里。
4. 守护语料是快照，不是源码派生：描述层改动（含 lint 任务将做的意图分界）之后需人工同步本文件，否则会重演「与源码漂移」。本批未引入自动提取 / 一致性检查（超出 matcher 任务范围），需要时另开条目。
5. 未跑根 `npm run check`：本 worktree 各子包没有 `node_modules`，根 check 会在第一个子包报 `tsc: not found`。本次只在 `tool-consult` 内 `npm install --prefer-offline` 后跑包级 `check` / `build` / `test`。改动不出 `tool-consult`，其他包无类型面受影响。
6. 决策 7 运行时层（查询精度不足时提示「请提供更多细节」）本批未实现，`tool-consult/src/tool.ts` 的提示逻辑未动（只改了第 207 行注释指向 `buildMatcher`），判定阈值仍待讨论。

## 测试与证据

验证命令（`tool-consult/` 下）：

```sh
npm install --prefer-offline --no-audit --no-fund   # 本 worktree 无 node_modules
npm run check    # tsc --noEmit, exit 0
npm run build    # tsc, exit 0
npm test         # node --test: tests 81 / pass 80 / fail 0 / skipped 1
```

1. 检索断言：20 条 query 中 19 条按新断言通过，1 条（「跨会话委托」top-1）按偏差 3 挂 skip。实测名次（真实语料，含分数）：

   | query | 首位 | 关键对照 |
   | --- | --- | --- |
   | 改文件 | `hash_edit` 10.21 | `edit` 8.86 第二（原断言要求 `edit` top-1） |
   | 跨会话委托 | `task_status` 14.97 | `channel_delegate` 14.30 第二 |
   | 加规则 | `rule_add` 9.56 | 第二 `rule_test` 4.12 |
   | 停止任务 | `task_stop` 14.52 | — |
   | 取消任务 | `channel_task` 15.90 | `task_stop` 6.73 第二 |
   | 任务状态 | `task_status` 10.81 | `channel_task` 5.28 第二 |

2. 预览前后对照（52 条语料，一次性脚本比对旧实现）：截断 0 → 0 条；预览总字符 2533 → 2562（+29）；预览有变化的仅 1 条——`rule_update` 由 `更新一条规则（浅合并 patch：只改 text / match / cooldownTurns 等；patch.` 变为 `…；patch.text 与 patch.action.text 等价）。`

3. `consult_tools` 排除前后（同一 52 条语料模拟）：未过滤时「咨询工具」→ `consult_tools` 16.80 首位（「揭示工具」19.00 / 「工具咨询」9.92 同样首位）；过滤后检索结果不再含它，`main.test.ts` 的新用例覆盖这一行为。

4. 语料结构：44 + 8 = 52 条，名称唯一，描述非空（`retrieval.test.ts` 首条用例断言）。

## 收尾

2026-10-25 关闭。

- 交付（单条提交 `fix(tool-consult): 预览上限对齐 128 并改用真实措辞守护语料`）：决策 3 预览上限与 ASCII 句号对齐（`tool-consult/src/matcher.ts`）、决策 5 真实措辞守护语料与断言对齐（`tool-consult/tests/fixtures/real-descriptions.ts`、`tool-consult/tests/retrieval.test.ts`）、`consult_tools` 索引排除（`tool-consult/src/main.ts`、`tool-consult/tests/main.test.ts`）与 `oneLine` 单测（`tool-consult/tests/matcher.test.ts`）。
- 验证：`tool-consult` 包级 `check` / `build` 通过；`npm test` 81 例（80 pass / 1 skip，见「测试与证据」）。
- 归档：本文移入 `docs/archived/`；项目级 `docs/BACKLOG.md` 条目「#2 tool-consult matcher 评估」已移出。
- 未带入后续：决策 7 运行时层阈值待定（见「待决策项」），随条目移交给 lint 任务（见下）。

### 移交 lint 任务

以下三项本任务**不实现**，随条目移出移交 lint 任务（其追踪文档 `docs/implementation/2026-10-25-tool-description-lint.md`）：

1. `task_status` 描述里的「跨会话委托任务查 channel_task」措辞修正。改完后 `tool-consult/tests/retrieval.test.ts` 末尾的 skip 用例应解除，并把「跨会话委托」用例的 `topN` 从 2 收到 1。
2. `tool-consult/tests/fixtures/real-descriptions.ts` 随 lint 的描述改动**重新同步**（该文件是快照、不是源码派生；提取方式见文件头注释）。若希望长期免手工，可另开条目做「守护语料与源码一致性」检查。
3. 决策 7 运行时层「查询精度不足 → 提示请提供更多细节」的**判定阈值**（top-1 / top-2 分差、命中 token 数等）仍待定；描述层的意图分界归 lint，运行时层等阈值定下后再改 `tool-consult/src/tool.ts`。

## 待决策项

决策 3 与 5 已实现（见「实现记录」）。剩余一项：

### 决策 7 运行时层（阈值待定）

- 描述层（各动作族 `边界` / `相关` 的意图分界、`task_status` / `task_stop` 措辞）归 **lint 任务**；本任务不落笔，`retrieval.test.ts` 的「跨会话委托」top-1 用 skip 挂着等它。
- 运行时层（查询精度不足时提示「请提供更多细节」）的**判断标准仍待讨论**（如 top-1 / top-2 分差、命中 token 数），定下后再改 `tool.ts`，本批未实现。
