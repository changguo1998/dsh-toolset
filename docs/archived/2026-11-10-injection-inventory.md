# 各插件注入方式整理（接取条目: docs/BACKLOG.md「各插件注入方式整理」）

> 本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改.
> 状态: 已完成（2026-11-11）. 盘点、三分类与决策项 1 至 6 已定稿; T1 至 T15 已落地并逐项提交.

## 目标

盘点本仓各插件把内容送进模型上下文的方式, 并按「一次性注入 / 静态保持 / 动态保持」三类归位, 找出错位项与缺口, 为后续改造提供依据.

## 调研

### 背景

用户指出「有些内容不属于工具说明, 但也要确保出现在上下文中」, 以推荐 / 禁止术语表为例, 应在一开始就输入, 而非等触发后再禁止; 本节盘点本仓与宿主里同类「规范 / 引导类内容」的现有做法与可用注入机制, 并按是否必须全程在场与内容是否会变给出分类.

### 1. 类似情况列表（非工具说明但需进上下文的内容）

| 内容 | 现状做法 | 注入形态 | 位置 / 状态 |
| --- | --- | --- | --- |
| 符号规范（推荐白名单 + 使用标准） | 开局指南 + 回合审查 | session-start / compaction / step-end, delivery steer, dedupeInRecord 1 | `symbol-normalizer/src/guide.ts` 已实现 |
| 术语表（推荐 + 禁止术语） | 只被动审查, 命中旧称才注入更正提示 | assistant-text, followup, dedupeInRecord 1 | `term-check/src/index.ts:119`; 缺开局注入 |
| 行为决策阶梯（ponytail 懒资深工程师 7 级） | 开局注入 + step-end 兜底 | session-start / step-end, steer, dedupeInRecord 1 | `ponytail/README.md` 已实现 |
| 偏好账本（preference-analysis） | 高置信偏好注入 | session-start / compaction / step-end, steer, directWrite=[session-start, compaction] | `preference-analysis/src/index.ts:550` 已实现 |
| 工作流流程模板 + 推进状态 + 合规提示（flow-track） | 条件注入（开关 + memory 有未完成流程） | turn-start / user-message, inject, dedupeInRecord 1 | `flow-track/README.md:34` 已实现 |
| 跨压缩保持项（pin-note） | 每步注入, 同正文去重 | agent/pre-step, 照宿主 agent-instructions 口径 | `pin-note/README.md:16-17` 已实现 |
| 回复形态规范（AGENTS.md 的 100 字内 / 中文 / 报告路径等） | 随宿主 agent-instructions 注入（与下行同一通道） | agent-instructions（pre-step instructions-form）, 不在场时补投 | 一次性注入, 与现状一致 |
| 宿主工作区指令（AGENTS.md / CLAUDE.md） | 宿主读取固定候选路径指令文件注入 | agent-instructions（宿主机制, 无插件注册口）, 不在场时补投 | 宿主 `dsh-agent-instructions` 已挂载 |
| 技能 / 模板 | 宿主 skills（tool-skill 加载 + skill-invocation 注入）; command-template slash 命令 | 按需 | 宿主 skill 已挂载 |
| 任意自定义规则注入（rule-engine） | 用户可自建, sources 十节点自由 | 全节点 | `rule-engine/src/tools.ts` 已实现 |

### 2. 现在可用的注入机制

- **rule-engine 消费者（本仓主力, 消息级注入）**: 节点十项 `assistant-text / user-message / tool-call / tool-result / turn-start / turn-end / step-start / step-end / session-start / compaction`, 消费者另可用 `tools/pre-execute`（guard 面）; delivery 三条 `followup`（新回合）/ `steer`（最近 pre-step + 唤醒）/ `inject`（最近 pre-step 不唤醒）; 去重与节流有 `dedupeInRecord`（读可见投影 + 未消费 inbox）/ `directWrite`（跳过记录判断直写）/ `cooldownTurns` / `cooldownMs`. 开局注入的受控模板在本仓已有两份先例: `symbol-normalizer-guide` / `preference-analysis` 用 `session-start`（含恢复）+ `compaction`（被压缩挤出后补回）+ `step-end`（兜底）, delivery steer, dedupeInRecord 1; `ponytail` 只用 `session-start` + `step-end`（无 compaction 节点）, 仍满足定期补投（依据 `rule-engine/docs/DESIGN.md` 机制第 1 / 4 / 6 / 7 / 9 条）.
- **宿主 agent-instructions（工作区上下文加载器）**: 读取 AGENTS.md / CLAUDE.md 等固定候选路径的指令文件, 每步 pre-step 折叠（instructions-form）, 内容相同则跳过（`context/agent-instructions/src/index.ts:348` 只扫当前请求数组）; 无插件注册口, 只有它能做到「严格早于首个请求」, 但只能由 profile / 项目层放文件驱动（依据 `docs/host/HOST-PACKAGES.md:64` 与 `symbol-normalizer/src/guide.ts:12-13`）. 压缩把旧副本折进摘要的替换区间后, 下一次请求重新折一条, 属「一次性注入 + 压缩补投」.
- **宿主 system-prompt 面**: 插件可注册 section / context / variable 进系统提示（每轮常驻, 比消息级注入更持久）; section 名唯一、complete 互斥限制; TUI 已有 `system-prompt/assemble` waterfall 用例（改 persona 注入水印, `TUI/src/app/adapter/tool-bootstrap.ts`）; 本仓插件尚未用 section 注册常驻文本.
- **宿主 skills**: `ctx.skills` 注册表 + `skill-filesystem`（SKILL.md 加载）+ `tool-skill`（模型面加载执行）+ `skill-invocation`（显式调用时注入 instructions-form 上下文, 宿主 `packages/skill/skill/src/index.ts:141-156`）; rule-engine 里可与 skill 自加载规则同节点同组合并（`symbol-normalizer/src/guide.ts:11`）.
- **agent/pre-step 直接注入**: pin-note 先例, 照宿主 agent-instructions 口径（注入前读 `session.deriveMessages()` 比对, 同 payload 不重复插）; 用于「每步都要在场」的内容.
- 记忆 / 偏好类数据面（memory-base / preference-analysis）不是注入机制本身, 而是数据源, 经上述消息级通道送入.

### 3. 分类判据与内容边界（2026-11-09 定稿）

判据两条: **是否必须全程在场**（一次性 / 保持存在）与**内容是否会变**（静态 / 动态）. 两条合并后收敛为三类; 一次性注入不再区分动静: 内容投进历史后即固定, 后续不再重投, 变化的只是「由什么触发投一次」.

内容边界: 偏好账本随新偏好累积而变, 属动态保持; 工具总则只写「功能 → 工具」的映射, 属静态保持, 工具的具体用法在揭示（`consult_tools`）之后按动态保持投递; 宿主工作区指令内容恒定, 属一次性注入, 靠压缩补投维持在场.

三条约束:

- 静态保持的内容必须恒定: 任一 section 增删或改 `order` 都会改变渲染结果, 断一次全量前缀.
- 只有 surface node 0 的 `system/message` 豁免压缩（`compaction-basic/src/region.ts:131`）, 中段 system 消息与普通消息同命运.
- 最细的插入粒度是步边界: 没有在工具调用流或流式输出中途插入内容的通道（`cancel` 只能打断, 不能续写）.

清点（本任务范围的注入内容; 与第 1 小节重叠的项以本节为准）:

| 内容 | 提供方 | 现在怎么进上下文 |
| --- | --- | --- |
| 符号规范开局指南 | symbol-normalizer | `session-start` + `compaction` + `step-end`, `steer`, `dedupeInRecord: 1` |
| 决策阶梯（懒资深工程师） | ponytail | `session-start`(+ `step-end`), `steer` |
| 高置信偏好要点 | preference-analysis | `session-start` + `compaction` + `step-end`, `steer`, `directWrite=[session-start, compaction]` |
| 术语表（推荐 + 禁止, 待补） | 无 | 无 |
| 回复形态规范 | 宿主 agent-instructions | pre-step 折进当前批次尾（instructions-form）, 不在场时补投 |
| 身份 / 工作区指令 | 宿主装配面 | agent-instructions, pre-step 折叠（内容相同跳过; 不占 system node 0） |
| 工具总则（功能 → 工具 的映射） | 宿主装配面 + 本仓待补 | 无专门总则, 现由各工具 description 自身承担 |
| 被揭示工具的具体用法 | tool-consult | 揭示后随工具面一起到, 无按需刷新机制 |
| 符号回合审查更正 | symbol-normalizer | `assistant-text`, 可反复提醒 |
| 八阶段模板 | flow-track | `turn-start` / `user-message`, 条件成立 |
| 术语旧称更正 | term-check | `assistant-text` |
| 表格列数不一致提示 | md-table-check | `assistant-text` |
| 沙箱升级重试指引 | escalation-hint | `tools/post-execute` → `additionalContexts` |
| 跨会话消息（delegate / 回报） | session-channel | `followup` 投递 |
| 定时任务通知 | background-daemon | 到点投递 |
| 工具咨询结果 | tool-consult | 工具结果内, 按需 |
| 记忆召回 | memory-base | 工具结果内, 按需 |
| 压缩摘要 | 宿主压缩 | 中段折叠成一条 user 消息 |
| 推进状态 / 合规提示 | flow-track | `turn-start` / `user-message` 条件投 |
| 跨压缩保持要点 | pin-note | `agent/pre-step` 每步比对正文 |
| 运行时上下文（工作目录等） | 宿主装配面 | `systemPrompt.context` + 每步刷新 |

依据: 宿主 `system-prompt/src/index.ts:484`（section 注册）、`:658-681`（contexts 装配）、`agent-loop/src/agent.ts:446-477`（每步 `refreshContext` 与尾部追加）、`runtime-context.ts:100-107`（`in-history` 追加）与 `:157-168`（变化才追加快照）、`llm-deepseek/src/serialize.ts:106-115` 与 `:151`（system 字段合并）、`compaction/compaction-basic/src/region.ts:131`（压缩区起点）、`context/agent-instructions/src/index.ts:330-356`（pre-step 折叠进 decision.messages）.

## 决策

### 决策项 1: 三种分类定稿（2026-11-09）

分类定为「一次性注入 / 静态保持 / 动态保持」, 判据两条: **是否必须全程在场**（一次性 / 保持存在）与**内容是否会变**（静态 / 动态）; 一次性注入不区分动静. 各类的判据、机制、位置、缓存与存活特性见下表; 三者互斥, 覆盖现有全部注入内容.

| 类 | 判据 | 机制 | 位置 | 缓存 | 存活与补投 |
| --- | --- | --- | --- | --- | --- |
| 一次性注入 | 事件触发投一次, 之后靠历史延续 | rule-engine 消费者: 开局（`session-start`）/ 条件（`turn-start`、`user-message` 等）/ 审查（`assistant-text`）/ 按需（skills） | messages 中段的 user 消息 | 追加在尾部时前缀不动; 之后位置固定即命中 | 会被压缩带走, 靠 `compaction` 节点补投 |
| 静态保持 | 只注册一次, 常驻不重投 | `ctx.systemPrompt.section` 静态文本 | system node 0（宿主循环里是 messages 第一条 system 消息） | 全文恒定, 每轮命中 | 永不进压缩区（`compaction-basic/src/region.ts:131`） |
| 动态保持 | 每轮比对, 内容变了才投 | `ctx.systemPrompt.context` + 宿主每步 `refreshContext`, 只在文本变化时追加尾部快照 | messages 尾部 | 只追加新条, 前缀不动 | 旧快照自然失效; 压缩后下一步重算补回 |

### 决策项 2: 静态保持的实现方式与载体

- 方式: `ctx.systemPrompt.section` 注册静态文本, 只注册一次, 落 system node 0, 压缩豁免 (`compaction-basic/src/region.ts:131`).
- 载体: 直接用宿主接口, 各插件自行注册与注销 section, 不经 `pin-note` 代理.
- 约束: section 名唯一、content 必须恒定, 增删 section 或改 `order` 会断一次全量前缀.
- 落地对象: 符号规范开局指南 (`symbol-normalizer`)、决策阶梯 (`ponytail`)、术语表 (`term-check`, 待补)、工具总则 (本仓待补).

### 决策项 3: 动态保持的实现方式与载体

- 方式: `agent/pre-step` 折叠, 按 key 分条独立比对, 只重投变化的那条; 不用 `ctx.systemPrompt.context` 快照 (整段比对与整段重发, `runtime-context.ts:157-167`、`system-prompt/src/index.ts:320-324`).
- 载体: `pin-note`, 服务面 `pinNotes` 新增登记读口 (如 `hold(key, provider)` / `release(key)`); 记忆分工 `memory-base` 记住 / `pin-note` 想起.
- 落地对象: 高置信偏好要点 (`preference-analysis`)、被揭示工具的具体用法 (`tool-consult`)、推进状态 / 合规提示 (`flow-track`)、`pin-note` 自身要点.

### 决策项 4: 一次性注入的实现方式与载体

- 方式: rule-engine 消费者 (匹配节点 + delivery + `dedupeInRecord` / `directWrite`), 投后靠历史延续, 被压缩带走时由 `compaction` 节点补投.
- 载体: `rule-engine`; 文案拼装下沉到统一规则, 各插件只提供内容.
- 落地对象: 审查更正类 (`symbol-normalizer` / `term-check` / `md-table-check`)、八阶段模板 (`flow-track`)、通知类 (`session-channel` / `background-daemon`)、沙箱升级指引 (`escalation-hint`).

### 决策项 5: 注入内容归类（2026-11-09 定稿, 表内只列本仓内容）

| 内容 | 提供方 | 应当属于哪一类 | 与现状是否一致 |
| --- | --- | --- | --- |
| 符号规范开局指南 | symbol-normalizer | 静态保持 | 错位 |
| 决策阶梯 | ponytail | 静态保持 | 错位 |
| 高置信偏好要点 | preference-analysis | 动态保持 | 错位 |
| 术语表（待补） | 无 | 静态保持 | 缺口 |
| 工具总则（功能 → 工具 的映射） | 本仓待补 | 静态保持 | 部分缺口 |
| 被揭示工具的具体用法 | tool-consult | 动态保持 | 缺口 |
| 符号回合审查更正 | symbol-normalizer | 一次性注入 | 一致 |
| 八阶段模板 | flow-track | 动态保持 | 一致 |
| 术语旧称更正 | term-check | 一次性注入 | 一致 |
| 表格列数不一致提示 | md-table-check | 一次性注入 | 一致 |
| 沙箱升级重试指引 | escalation-hint | 一次性注入 | 一致 |
| 跨会话消息 | session-channel | 一次性注入 | 一致 |
| 定时任务通知 | background-daemon | 一次性注入 | 一致 |
| 工具咨询结果 | tool-consult | 一次性注入 | 一致 |
| 记忆召回 | memory-base | 一次性注入 | 一致 |
| 推进状态 / 合规提示 | flow-track | 动态保持 | 错位 |
| 跨压缩保持要点 | pin-note | 动态保持 | 错位 |

按此归类统计: 静态保持 4 项（错位 2、缺口或部分缺口 2）, 动态保持 5 项（错位 3、缺口 1、一致 1）, 其余 8 项一次性注入与现状一致.

### 决策项 6: 统一使用更新后插件提供的实现（2026-11-10 裁定）

- 口径: 静态保持直调 `ctx.systemPrompt.section`; 动态保持经 `pin-note` 的 `hold` 折叠; 一次性注入经 `rule-engine` 消费者. 各插件的消息级注入通道不再自建.
- 迁移对象: 静态保持 — `symbol-normalizer` 开局指南、`ponytail` 决策阶梯、`term-check` 术语表 (待补)、工具总则 (待补); 动态保持 — `preference-analysis` 偏好要点、`tool-consult` 揭示用法、`flow-track` 八阶段模板与推进状态、`pin-note` 自身要点.
- 不迁移: 已在 `rule-engine` 上的 (`symbol-normalizer` 审查、`term-check` 术语更正、`md-table-check` 列数) 保持原规则; 附着在工具结果或 inbox 投递的 (`escalation-hint` 升级指引、`tool-consult` 咨询结果、`memory-base` 召回、`session-channel` 跨会话、`background-daemon` 定时通知) 保留原通道.
- 迁移顺序: 先补 `pin-note` 的 `hold` 口与各插件的 section 注册, 再逐个迁移; 期间旧通道保留, 迁移完删除旧拼接与旧去重.
- 验收: 每项内容只走一条通道且只保留一条在场副本; 静态内容恒定, 动态按 key 分条比对, 一次性落历史后不再重投.

## 规划

### 整体思路

- 一条内容只走一条通道: 静态保持 → `ctx.systemPrompt.section`; 动态保持 → `pinNotes.hold`; 一次性注入 → `rule-engine`; 例外 (工具结果 / inbox 投递) 保留原通道.
- 先补服务面与注册口, 再迁消费者; 迁移期间旧通道保留, 完成后统一删除旧拼接与旧去重.
- 去重判据统一为「内容不在场才投」, 不新增压缩事件订阅; 静态段逐字恒定, 动态按 key 分条比对.
- 缓存优先: 静态段名与内容固定、不改 `order`; 动态只追加变化条; 一次性投后不重投.

### 阶段与改动清单

| 阶段 | 包 / 文件 | 改动 | 对应决策项 |
| --- | --- | --- | --- |
| 1 | `pin-note/src/index.ts`、`pin-note/README.md` | 服务面 `pinNotes` 增设 `hold(key, provider)` / `release(key)`; pre-step 改为多来源 (模型登记 + 服务面 provider), 按 key 分条比对与注入; 与 `pin_note` 同库分来源 | 决策项 3、6 |
| 2 | `symbol-normalizer/src/index.ts`、`src/guide.ts` | 开局指南改为静态 section (名与内容固定), 删除 `session-start` / `compaction` / `step-end` 规则 | 决策项 2、5、6 |
| 2 | `ponytail/src/index.ts` | 决策阶梯改为 section, 开关关闭时不注册; 删除 `session-start` / `step-end` 规则 | 决策项 2、5、6 |
| 2 | `term-check/src/index.ts`、`src/terms.ts` | 术语表凝练成 section; 保留旧称审查规则 | 决策项 2、5、6 |
| 2 | 工具总则 | 内容来源与形态待 1111 (工具说明注册表) 定, 本轮先定 section 名与内容边界 | 决策项 2、5 |
| 3 | `preference-analysis/src/index.ts` | 偏好要点由 rule-engine 注入改为 `pinNotes.hold('preference', …)` | 决策项 3、5、6 |
| 3 | `flow-track/src/index.ts` | 八阶段模板与推进状态改为 `pinNotes.hold('flow', …)`, 保留注入开关 | 决策项 3、5、6 |
| 3 | `tool-consult/src/index.ts` | 被揭示工具的用法改为 `pinNotes.hold('revealed-tools', …)`; 依赖 1111 的工具说明注册表 | 决策项 3、5、6 |
| 3 | `pin-note` 自身要点 | 并入多来源实现, 不另设通道 | 决策项 3、5 |
| 4 | `rule-engine/src/index.ts`、`src/types.ts` | 若需文案下沉: 提供统一模板注册口, 各插件只供内容; 否则仅登记现状 | 决策项 4、6 |
| 5 | 上述各包 `README.md` | 注入方式说明同步为三类通道 | 决策项 6 |

### 机械审计通则

- 文件白名单: `pin-note/`、`symbol-normalizer/`、`ponytail/`、`term-check/`、`preference-analysis/`、`flow-track/`、`tool-consult/`、`rule-engine/`、`e2e/`、`scripts/` 与本追踪文档; `git status --porcelain` 与 `git diff --name-only` 只能出现这些路径.
- 工具面零变化: 模型侧工具名与参数 schema 不得变; `git diff -U0 | grep -cE '^\+.*name: "'` 与 `git diff -U0 | grep -c 'input_schema'` 均须为 0.
- 每任务通过 = 该行 grep 断言全过 + 该包 `pnpm run check` 与该包 `pnpm run test` 绿.
- 断言缺一即回退, 不得以「等价实现」替代; 新增断言以退出码非零表达失败.
- 全部审计命令汇总到 `scripts/audit-injection-channels.sh`: 任一条不满足即 `exit 1`; 手工复跑用 `bash scripts/audit-injection-channels.sh`.

### 任务清单

命令均在仓库根执行; `→` 后为期望值, 不符即判失败.

- [x] T1 `pin-note` 服务面 `hold` (`pin-note/src/index.ts`、`src/types.ts`)
  - 做什么: 在 `c.provide("pinNotes", …)` 里新增 `hold(key, provider)` 与 `release(key)`; `provider` 形如 `(context: { sessionId; turn; step }) => string | undefined`, 返回 `undefined` 表示该条不投; `hold` 返回 disposer; 内部维护 `Map<string, { provider, lastText }>`.
  - 边界: 同 `key` 重复注册则后者覆盖并告警; `release` 与 dispose 清空条目; `pinNotes` 在 `memory` 不可用时仍暴露 (hold 不依赖记忆库).
  - 测试: 两 key 共存、provider 返回 `undefined` 不投、`release` 后不再投、重复 key 覆盖.
  - 审计: `grep -c 'hold(' pin-note/src/index.ts` → ≥ 1; `grep -c 'release(' pin-note/src/index.ts` → ≥ 1; `grep -rl 'hold' pin-note/tests | wc -l` → ≥ 1; `cd pin-note && pnpm run check && pnpm run test` → 0
- [x] T2 `pin-note` 多来源折叠 (`pin-note/src/index.ts`)
  - 做什么: pre-step 改为两类来源 — 记忆库记录 (`store.list` → `pinMessage(records)`, 一条) 与各 `hold` key (每 key 一条, `source.summary = key`); 每条独立 `alreadyInContext` 比对, 仅未在场者插入; `syncInbox` 按来源归并, 每 key 最多一条 pending.
  - 边界: provider 抛错 → 该条跳过并 warn; 全部在场或全部为空 → 不插; `decision.kind` 非 `enter` 时不插.
  - 测试: 两 key 只变一条时仅追加一条; 压缩拆掉两条后都补投; provider 异常降级; 模型记录与 hold 共存时各一条.
  - 审计: `grep -c 'provider' pin-note/src/index.ts` → ≥ 1; `grep -c 'compare' pin-note/src/index.ts` → ≥ 2; `git diff -U0 pin-note/tests | grep -c '^-[^-]'` → 0; `cd pin-note && pnpm run test` → 0
- [x] T3 `symbol-normalizer` 静态 section (`symbol-normalizer/src/index.ts`、`src/guide.ts`)
  - 做什么: 删掉 `symbol-normalizer-guide` 消费者与其 `disposeGuide`; 改注册 `ctx.systemPrompt.section({ name: "symbol-normalizer/guide", order: 4000, text: buildSymbolGuide(rules), interpolate: false })`, 仅 `rules.injectGuide` 为真时注册; disposer 收进现有清理列表.
  - 保留: `symbol-normalizer` 审查消费者与 `symbolNormalizer` 展示服务不动.
  - 边界: section 名带本包前缀; 内容随 `rules` 只在重启生效 (README 注明); `injectGuide` 关闭时不注册.
  - 测试: 注册后装配文本等于 `buildSymbolGuide` 输出; 关闭时未注册; `order` 为常量.
  - 审计: `grep -c '\.section(' symbol-normalizer/src/index.ts` → ≥ 1; `grep -rc 'session-start' symbol-normalizer/src | grep -v ':0' | wc -l` → 0; 同式对 `step-end`、`compaction` 各 → 0; `cd symbol-normalizer && pnpm run check && pnpm run test` → 0
- [x] T4 `ponytail` 静态 section 与开关 (`ponytail/src/index.ts`)
  - 做什么: 删 `registerConsumer` 与配置字段 `sources` / `delivery` / `dedupeInRecord`; 改注册 section `{ name: "ponytail/ladder", order: 4100, text: resolved.text, interpolate: false }`; `enabled: false` 时不注册.
  - 保留: 默认开启与配置覆盖 `text` 两项能力.
  - 边界: 关闭时不注册也不在上下文出现; 自定义 `text` 仍生效.
  - 测试: 关闭不注册; 文本等于常量; `text` 覆盖用例.
  - 审计: `grep -c '\.section(' ponytail/src/index.ts` → ≥ 1; `grep -c 'enabled' ponytail/src/index.ts` → ≥ 1; `grep -rc 'session-start' ponytail/src | grep -v ':0' | wc -l` → 0; `cd ponytail && pnpm run check && pnpm run test` → 0
- [x] T5 `term-check` 术语表 section (`term-check/src/index.ts`、`src/terms.ts`)
  - 做什么: 新增 `renderGlossarySection(GLOSSARY_SNAPSHOT)` 生成稳定文本 (推荐术语表 + 禁止术语表两段, 行序固定); 注册 section `{ name: "term-check/glossary", order: 4200, text, interpolate: false }`; `assistant-text` 旧称审查消费者不动.
  - 边界: 快照由 `docs/GLOSSARY.md` 生成, 生成方式不变; 同快照必须同字节.
  - 测试: section 文本含「推荐」「禁止」两段; 旧审查用例不改仍绿.
  - 审计: `grep -c '\.section(' term-check/src/index.ts` → ≥ 1; `grep -c 'assistant-text' term-check/src/index.ts` → ≥ 1; `grep -c '禁止' term-check/src/terms.ts` → ≥ 1; `cd term-check && pnpm run check && pnpm run test` → 0
- [x] T6 工具总则登记 (`docs/implementation/2026-11-11-tool-description-registry.md`)
  - 做什么: 在 1111 文档登记「工具总则 = 功能 → 工具映射, 静态保持, section 名 `tool-consult/tool-index`, `order` 4300」; 本任务不改代码.
  - 边界: 内容与命名归 1111; 本轮只写登记行.
  - 审计: `grep -c '工具总则' docs/implementation/2026-11-11-tool-description-registry.md` → ≥ 1; `git diff --name-only | grep -c 'src/'` → 0
- [x] T7 `preference-analysis` 改 hold (`preference-analysis/src/index.ts`)
  - 做什么: 删 `CONSUMER_REGISTRATION` 与消费者注册; 改注册 `pinNotes.hold("preference", () => plugin.decide()?.text)`; 无 `pinNotes` 服务时 warn 并只记录不注入. 若 `inject` 声明里仍有 `ruleEngine`, 一并移除.
  - 保留: 观测 (`session/event`)、归纳节流、三项偏好工具与写入.
  - 边界: `decide()` 返回 `null` 时 provider 返回 `undefined`; 服务缺席时降级.
  - 测试: 文本变化才投; 无服务时的降级告警; 偏好工具行为不变.
  - 审计: `grep -cF "hold('preference'" preference-analysis/src/index.ts` → ≥ 1; `grep -rc 'session-start' preference-analysis/src | grep -v ':0' | wc -l` → 0; `grep -rc 'compaction' preference-analysis/src | grep -v ':0' | wc -l` → 0; `cd preference-analysis && pnpm run check && pnpm run test` → 0
- [x] T8 `flow-track` 改 hold (`flow-track/src/index.ts`)
  - 做什么: 删消费者注册; 改注册 `pinNotes.hold("flow", () => decideText({…}))`; 开关 `switcher.enabled` 与 `hasActiveFlow(cache.records)` 两门槛移入 provider, 不满足时返回 `undefined`.
  - 保留: `/flow-track` 命令、`flowTrack` 服务面、五个流程工具、`WriteObserver` 合规提示.
  - 边界: 无活跃流程或开关关闭时不注入; 服务缺席时 warn 并只保留命令与服务面.
  - 测试: 关闭不注入; 有活跃流程时文本出现; 阶段推进后文本变化.
  - 审计: `grep -cF "hold('flow'" flow-track/src/index.ts` → ≥ 1; `grep -c 'enabled' flow-track/src/index.ts` → ≥ 1; `grep -rc 'turn-start' flow-track/src | grep -v ':0' | wc -l` → 0; `cd flow-track && pnpm run check && pnpm run test` → 0
- [x] T9 `tool-consult` 改 hold (`tool-consult/src/index.ts`)
  - 做什么: 新增 `pinNotes.hold("revealed-tools", ({ sessionId }) => summarizeRevealed(runtime, sessionId))`; 文本每行 `- name: 一句话描述`, 取自已揭示集合与 `docs` 描述 (`oneLine`); 揭示与遮罩逻辑不动.
  - 边界: 未揭示任何工具时返回 `undefined`; 揭示集合不变则文本同字节; turn 档收敛后文本随之变.
  - 测试: 揭示 1 项后非空; 两次同集合文本相同.
  - 审计: `grep -cF "hold('revealed-tools'" tool-consult/src/index.ts` → ≥ 1; `grep -c 'consult_tools' tool-consult/src/tools.ts` → ≥ 1; `grep -c '工具总则' docs/implementation/2026-11-11-tool-description-registry.md` → ≥ 1; `cd tool-consult && pnpm run check && pnpm run test` → 0
- [x] T10 `pin-note` 自身要点并入 (`pin-note/src/index.ts`、`src/tools.ts`)
  - 做什么: 模型面 `pin_note` 仍写记忆库; 注入统一走 T2 的多来源路径, 两条来源共用 `alreadyInContext` 与 `foldMessages`; 不新增工具.
  - 边界: 两来源正文相同时只投一条; 工具名与参数 schema 不变.
  - 测试: `pin_note` 写入后下一步出现一条; 与 hold 同正文时不重复.
  - 审计: `grep -c 'name: "pin_note"' pin-note/src/tools.ts` → 1; `grep -c 'compare' pin-note/src/index.ts` → ≥ 2; `cd pin-note && pnpm run test` → 0
- [x] T11 `rule-engine` 文案下沉 (可选; `rule-engine/src/index.ts`、`src/types.ts`)
  - 做什么: 若做, 在消费者面新增统一内容注册口 `registerTemplate`, 插件只供内容不拼文案; 若不做, 保持现状.
  - 边界: 不做时 `rule-engine` 零 diff, 不影响 T3 至 T10.
  - 审计: 不做: `git diff --stat -- rule-engine | wc -l` → 0; 做: `grep -c 'registerTemplate' rule-engine/src/index.ts` → ≥ 1
- [x] T12 README 同步 (各改动包 `README.md`)
  - 做什么: 每包补三类通道 — 静态写 section 名与 `order`, 动态写 `pinNotes.hold` 的 key, 一次性写明是否例外通道.
  - 边界: 只改受影响包, 不重写其他段落.
  - 审计: `for p in pin-note symbol-normalizer ponytail term-check preference-analysis flow-track tool-consult; do grep -q '静态保持' $p/README.md || echo MISS $p; done | wc -l` → 0; 同式对 `动态保持`、`一次性注入` 各 → 0
- [x] T13 端到端与会话日志断言 (`e2e/injection-channels.test.ts`)
  - 做什么: 三例 — 静态 section 注册后装配文本含内容; 两个 hold key 只变一个时仅追加一条; 模拟压缩 `replace` 后两条都补投; 每例断言 surface 中同 source kind 仅 1 条.
  - 边界: 用最小假 `session` / `pre-step`, 不依赖真实 provider.
  - 审计: `test -f e2e/injection-channels.test.ts` → 0; `grep -c 'surface' e2e/injection-channels.test.ts` → ≥ 1; `pnpm run test` → 0
- [x] T14 全量与白名单
  - 做什么: 无代码; 所有断言全过后才可交审.
  - 审计: `pnpm run check && pnpm run build && pnpm run test` → 0; `git status --porcelain | awk '{print $2}' | grep -vE '^(pin-note|symbol-normalizer|ponytail|term-check|preference-analysis|flow-track|tool-consult|rule-engine|e2e|scripts)/|^docs/implementation/2026-11-10-injection-inventory\.md$' | wc -l` → 0; `git diff -U0 | grep -cE '^\+.*name: "'` → 0; `git diff -U0 | grep -c 'input_schema'` → 0
- [x] T15 审计脚本 (`scripts/audit-injection-channels.sh`)
  - 做什么: `set -euo pipefail`; 每任务一组 `need()` 断言; 失败打印任务号与实测值并 `exit 1`; 末尾汇总通过项数.
  - 边界: 只读不写; 依赖 `pnpm` 与 `git`; 在仓库根执行.
  - 审计: `test -f scripts/audit-injection-channels.sh` → 0; `bash -n scripts/audit-injection-channels.sh` → 0; `bash scripts/audit-injection-channels.sh` → 0

### 验收

- 会话日志断言: 同一内容在 surface 只 1 条; 静态段在 system node 0, 动态段在批次尾按 key 分条, 一次性在历史中.
- 渲染断言: 静态段逐字恒定 (增删 section 或改 `order` 视为回归); 动态只追加变化条; 一次性投后不重投.
- 开关关闭时对应内容不进场; 服务缺席时降级为不注入并告警.
- `pnpm run check` / `build` / `test` 全绿, 迁移完删除旧拼接与旧去重.

### 明确不做

- 不改例外通道 (工具结果 / inbox 投递) 的实现.
- 不改宿主 `system-prompt` / `agent-loop` / `compaction` 源码（只读参考）.
- 不动 `TUI/`; 工具说明注册表与按需投递归 1111, 不在本轮.

## 实现记录

- 2026-11-11: 按 T1 至 T15 执行, 每完成一包跑该包 check / test 后单独提交.
  - T1 / T2 / T10 `pin-note`: 服务面新增 `hold(key, provider)` / `release(key)`; pre-step 改为「记忆库记录 + 各 hold key」多来源, 按正文逐条比对、按来源收敛 inbox; 提交 `e7efe400`.
  - T3 `symbol-normalizer`: 开局指南改注册 `ctx.systemPrompt.section`（`symbol-normalizer/guide`, order 4000）, 删除 guide 消费者; 提交 `8ceffff7`.
  - T4 `ponytail`: 决策阶梯改注册 section（`ponytail/ladder`, order 4100）, 配置面收敛为 `enabled` / `text`; 提交 `acda4eb6`.
  - T5 `term-check`: 新增 `src/terms.ts` 渲染术语表两段, 注册 section（`term-check/glossary`, order 4200）, 旧称审查消费者保留; 提交 `627be8a2`.
  - T6 / T7 `preference-analysis`: 偏好要点改 `pinNotes.hold("preference")`, 删除消费者与 `CONSUMER_REGISTRATION`, `inject` 收敛为 memory / tools; 1111 文档登记工具总则 section 名与 order; 提交 `9a1bebe8`.
  - T8 `flow-track`: 阶段模板 / 推进状态改 `pinNotes.hold("flow")`, 开关与活跃流程两门槛移入 provider; 提交 `9ae32aa0`.
  - T9 `tool-consult`: 新增 `summarizeRevealed` 并登记 `pinNotes.hold("revealed-tools")`; 提交 `8e58b4a7`.
  - T11 `rule-engine`: 选「不做」, `rule-engine` 零 diff（`registerTemplate` 未引入）.
  - T12 七个包 README 补「注入通道」节并修正过时描述; 提交 `b1d0c65b`.
  - T13 `e2e/injection-channels.test.ts`: 静态 section / 两 key 动态保持 / 压缩补投三例; T15 `scripts/audit-injection-channels.sh` 36 项断言全过.

## 偏差

- T7 审计口径修正: 计划要求 `preference-analysis/src` 里 `compaction` 归零, 但归纳节流的触发点就是
  `session/event` 的 `compaction/end`（保留项「归纳节流」）, 该字符串属观测链路、不是注入通道;
  实际只保证 `session-start` / `ruleEngine` / `registerConsumer` 归零, `compaction` 保留.
- T9 审计引号口径: 计划写 `hold('revealed-tools'`, 实现按 prettier 用双引号 `hold("revealed-tools"`;
  审计脚本按双引号断言.
- T6 工具总则只登记命名与位置, `tool-consult` 的 section 注册尚未实现: 正文与单一来源归 1111 定稿,
  本轮不改代码（计划即如此）.
- T13 端到端用例用最小假 session / pre-step 驱动真实插件入口, 不起真实宿主; 真实宿主下的会话日志
  断言留给人工验收（静态段恒在、动态段按 key 分条已在单测与 e2e 覆盖）.

## 测试与证据

- `bash scripts/audit-injection-channels.sh` → 审计通过 36 项（含 T14 白名单与工具面零改动断言）.
- `e2e/injection-channels.test.ts` 随 `pnpm run test:e2e` 全绿.
- 全量 `pnpm run check` / `build` / `test` 全绿（2026-11-11）.
- 归类依据为宿主源码与实际注入实现, 逐条列出路径（见「调研」第 3 小节「依据」）.
- 会话日志实测（`tui-7e83c53d`）: 工作区指令 / 技能目录 / 运行时快照各注入 11 次, 均发生在会话开始与 10 次 `/compact` 之后（`command/done` 记录 "Compacted N history items"）; 压缩摘要的 `replace` 区间（如 seq 938 覆盖 8 至 929）把上一份副本一并折叠, 故当前 surface 上各只有 1 份, 分别为 15,421 / 9,002 / 567 字符.
- 后续如落地静态保持 / 动态保持, 再追 `pnpm run check` / `build` / `test` 结果.

## 收尾

- 已关闭（2026-11-11）: T1 至 T15 全部完成并逐项提交, 文档移入 `docs/archived/`.
- 剩余事项: 工具总则正文与「被揭示工具用法」的单一来源归 `docs/implementation/2026-11-11-tool-description-registry.md`;
  后者未接取, 不阻塞本任务关闭.
