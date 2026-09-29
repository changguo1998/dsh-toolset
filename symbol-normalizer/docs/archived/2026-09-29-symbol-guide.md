# 会话开局注入「推荐符号列表 + 使用标准」（接取条目：symbol-normalizer「会话开始注入「推荐符号列表 + 使用标准」」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新会话开局主动注入一次**推荐符号白名单**与**符号使用标准**（两者都要），让模型从第一句起按规范输出，减少「先违规、回合末才被提醒」的往返；文本须**由 config 生成**而非硬编码，并具备开关。

## 调研（触发点）

- 宿主指令面 `@deepseek-ai/dsh-agent-instructions`（`packages/context/agent-instructions`）：**文件驱动**——固定读取 `dshHome` 下全局 `AGENTS.md` 与逐目录候选文件，插件**无注册口**（导出 `name` / `inject = ['sessionProjections']`，配置只有路径与容量），因此「严格早于首个请求」不可达；若要落在指令面，只能写用户自己的指令文件（跨出本插件边界，不做）。
- 备选：rule-engine 消费者通道（与既有回合审查同一通道，受 `maxInjectionsPerTurn` 保护）。**采用此路径**。

## 决策

1. **通道**：注册第二个消费者 `symbol-normalizer-guide`（`id` 唯一），`decide` 内自门控「每会话一次」；文案摘要 `符号规范（会话开局指南）`。
1. **文本生成**（`buildSymbolGuide`）：白名单取自 `rules.recommendedSet`（含 config 追加项）、变体映射取自 `rules.aliases`（含 config 覆盖项，最多列 20 条），其余为固定标准条目——**不硬编码符号表**，config 改变即文本改变。
1. **别名的写法**：映射写成行内代码（`` `❌→✗` ``），使指南自身不触发符号审查（复用 F1 的掩码）。
1. **门控**（`SymbolGuideGate`）：进程内记账每会话一次，容量 256 做 FIFO 淘汰（长跑进程不无限增长）。
1. **开关**：新增 config `injectGuide`（缺省 `true`）；`false` 时不注册指南消费者（既有行为不变）。
1. **已知时序边界**：注入发生在**首个可行回合边界**（消费者通道），而非「首个请求之前」；宿主指令面无插件注册口是根因，已在本文件记录。

## 规划

计划改动文件清单（**只改这些**）：

- `symbol-normalizer/docs/BACKLOG.md`（条目状态）
- `symbol-normalizer/docs/implementation/2026-09-29-symbol-guide.md`（本文件）
- `symbol-normalizer/src/symbols.ts`（config 字段 `injectGuide` 与解析）
- `symbol-normalizer/src/guide.ts`（新增：`buildSymbolGuide` / `SymbolGuideGate` / `GUIDE_SUMMARY`）
- `symbol-normalizer/src/main.ts`（注册指南消费者 + 生命周期注销）
- `symbol-normalizer/tests/guide.test.ts`（新增）、`symbol-normalizer/tests/main.test.ts`（接线断言更新 + 2 例）
- 关闭时回写：`symbol-normalizer/README.md`（配置项 `injectGuide` 与注入通道说明）

明确不做：改写用户指令文件、按会话持久化门控（跨进程）、按符号族分组的多条注入。

## 实现记录

- `src/symbols.ts`：`SymbolRulesConfig.injectGuide?: boolean`（缺省 true）+ `ResolvedSymbolRules.injectGuide`。
- `src/guide.ts`：`buildSymbolGuide(rules)`（五条标准 + 白名单 + 至多 20 条变体映射，映射用行内代码包裹）；`SymbolGuideGate`（每会话一次 + 容量 FIFO 淘汰）；`GUIDE_SUMMARY`。
- `src/main.ts`：`rules.injectGuide` 为真时注册 `symbol-normalizer-guide` 消费者，`decide` 走门控后返回指南文本；`effect` 清理时与审查消费者一并注销。

## 测试与证据

- 新增 `tests/guide.test.ts`（4 例）：① 文本含全部内置推荐符号、含 config 追加的推荐字符、含五条标准条目；② 别名映射取自 config（覆盖内置后文本随之变化）且用行内代码包裹——掩码后指南自身无 `❌`/`✔` 残留；③ 映射列出条数上限 20；④ 门控每会话一次、按会话隔离、容量 FIFO 淘汰。
- `tests/main.test.ts`：接线断言更新为两个消费者（`symbol-normalizer`、`symbol-normalizer-guide`）且清理时两者都注销；新增 2 例——指南消费者首回合返回文本、同会话第二次返回 `null`、另一会话仍注入；`injectGuide: false` 时只注册审查消费者。
- 结果：`npm --prefix symbol-normalizer run test` → 39 例全通过（原 29 + F1 新增 4 + F2 新增 6）；`run check` 0 error。
- 真机复验（2026-09-29，通过）：会话日志 `agent/inbox/spliced` 中出现 `source.kind = "rule-engine"` 的注入，正文为 `[符号规范] 会话开局指南（按此输出，避免回合末返工）：1) 推荐符号白名单…2) 有推荐对应关系的变体必须改用推荐符…`，与 `buildSymbolGuide` 输出一致；每会话一次由 `SymbolGuideGate` 记账（同进程内后续回合不再注入）。

## 收尾

- 条目 F2 标记完成并从 `symbol-normalizer/docs/BACKLOG.md` 移除；本文件移入 `symbol-normalizer/docs/archived/`。
- 回写 `symbol-normalizer/README.md`：配置新增 `injectGuide`（缺省 true）、注入通道与时机（rule-engine 消费者、首个可行回合边界）、每会话一次与容量淘汰。
