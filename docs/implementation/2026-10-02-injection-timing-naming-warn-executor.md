# 注入时机直写 + slash 命名规范 + 插件告警通道 + task-engine 执行扩展（接取条目：`docs/BACKLOG.md`「注入时机调整：会话开始 / 压缩完成后直写，不等步末」；「slash 命令命名规范：不用缩写」；「插件运行期 stderr 告警显示统一（评估）」；「task-engine 执行扩展」）

状态：实现　　开启：2026-10-02　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按用户指令顺序推进四件事（`#8 → #5 → #7 → #1` 的阅读顺序对应上列条目顺序）：

1. **注入时机调整（P1）**：`rule-engine` 规则支持多节点（`source` 接受数组，用户裁定不拆两条规则）；新增「直写节点」能力（声明在某些节点跳过 `dedupeInRecord` 投影判断）；`symbol-normalizer-guide` 消费者改为「`session-start` + `compaction` 直写、`step-end` 判断后写入」；运行时规则 `skill-autoload` 改挂「会话开始 + 压缩完成」。
1. **slash 命名规范**：盘点本地 / 宿主 / 插件命令的缩写与晦涩名，给出改名清单与兼容策略。
1. **插件告警通道（评估）**：评估各插件运行期 stderr 告警是否统一改结构化通知通道（rule-engine `onNotice` / symbol-normalizer `onReview` 模式）与降噪。
1. **task-engine 执行扩展**：叶子 `executor` 声明与后端适配（model / subagent / workflow / command）、模型与预算声明、隔离落地（git worktree）。

## 调研

### #8 现状（2026-10-02 读码）

- `RuleSource` 是**单值**联合类型（`src/types.ts`）；`NormalizedRule.source` 单值；`compileMatcher(spec, source)` 在**编译期**用 `source` 判定「空条件是否无条件命中」（`BOUNDARY_SOURCES` 含 `session-start` / `compaction`），因此多节点必须把这条判定挪到**判定期**（按触发节点）。
- 投影去重（`dedupeInRecord`）在 `engine.#collectRules` / `#collectConsumers` 内：投影里已有 N 条 → 不产出段（仍记本次命中）。「直写」= 在声明的节点上跳过这次投影计数判断。
- 消费者面已支持多节点（`ConsumerRegistration.sources: readonly RuleSource[]`），且 `compaction` 不在对齐表（每次到达都触发）、`session-start` 是 session 尺度 start（注册即唤醒，无窗口幂等）——多节点无需改对齐逻辑。
- 运行时（仓库外）`~/.dsh/rule-engine/rules.json` 现有 1 条 `skill-autoload`（`source: "step-end"` + `delivery: "steer"` + `dedupeInRecord: 1`）；`symbol-normalizer` 的指南消费者注册为 `sources: ["step-end"]` + `dedupeInRecord: 1`（`src/main.ts`）。
- 会话日志取证（BACKLOG 记录）：`compaction/end` 后第一步没有注入、第二步才补——因为 `compaction` 不是指南与 skill 规则的节点，只能等下一次 `step-end`。

### #5 现状

待盘点：`TUI/src/app/commands.ts` 的 `LOCAL_COMMANDS`、宿主命令、各插件注册的命令（`command-template` 模板命令族等），对照 `TUI/docs/COMMANDS.md`。

### #7 现状

BACKLOG 已列清单：command-template / session-title-cutoff / task-engine / goal-contract / session-channel / metric-loop / hash-edit / symbol-normalizer / code-map（stderr 兜底）/ TUI 自身均裸写 `process.stderr.write`；rule-engine 已改结构化总线（`onNotice` + headless 兜底），symbol-normalizer 有 `onReview`（消费者审查 notice）。

### #1 现状

待读 task-engine 源码与 README「边界与外包」段；依赖宿主 `subagents` / `workflow` / `llm` / `token-meter` 面与本机 `dsh-git-worktree`。

## 决策

| # | 决策点 | 选定 | 理由 |
|---|--------|------|------|
| D1 | 直写声明字段形态（用户 2026-10-02 裁定） | **A：独立字段 `directWrite: ["session-start", "compaction"]`**（规则与消费者同口径，与 `sources` 并列） | 改动最小；YAML 与工具参数都好写；B（source 项内联对象）令数组项变混类型，C（规则级布尔）表达不了「某些节点直写、`step-end` 仍判断」 |
| D2 | 多节点入参形态（用户 2026-10-02 裁定，BACKLOG 已记） | `source` 接受字符串或字符串数组（**不拆两条规则**）；归一化后字段名 `sources: readonly RuleSource[]` | 单值入参向后兼容；归一化侧用数组，避免「归一化类型里留联合类型」的读侧分支 |
| D3 | 空条件（`match` 省略）语义 | 由编译期判定改为**判定期按触发节点**判定：节点属 `BOUNDARY_SOURCES` 才「无条件命中」 | 一条规则挂多节点时，各节点语义必须独立 |
| D4 | 仓库外运行时 `rules.json`（用户 2026-10-02 裁定） | **现在就改**：`skill-autoload` 改 `sources: ["session-start", "compaction"]` + `directWrite` 两节点；改前把 diff 贴给用户确认 | ③ 是真机复盘的前提；该文件在仓库外，属用户环境配置 |
| D5 | `session-start` 含恢复（`session/created`） | 按需求**不判断、直写** → 恢复会话会再注入一次 | BACKLOG 注记明确要求「不判断」 |

## 规划

### 计划改动文件清单

**#8（rule-engine + symbol-normalizer，跨包）**

| 文件 | 改动 |
|------|------|
| `rule-engine/src/types.ts` | `Rule.source` 接受 `RuleSource \| readonly RuleSource[]`；`Rule.directWrite`；`NormalizedRule.sources` / `directWrite`；`RuleSummary.sources` / `directWrite`；`ConsumerRegistration.directWrite` |
| `rule-engine/src/match.ts` | `compileMatcher(spec, sources)`：空条件判定改为按**触发节点**在 `match(text, source)` 内裁决 |
| `rule-engine/src/rules.ts` | `normalizeRule` 归一 `source`（字符串 / 数组 / 兼容 `sources`）+ `directWrite`；非法节点项记 warning |
| `rule-engine/src/engine.ts` | 多节点命中（`sources.includes(trigger)`）、直写跳过投影去重（规则 + 消费者）、`#needsText` / `evaluate` / `summaries` 同步 |
| `rule-engine/src/tools.ts` | `rule_add` / `rule_update` 的 `source` 支持数组 + 新增 `directWrite` 参数与描述 |
| `rule-engine/README.md`、`rule-engine/docs/DESIGN.md` | 节点表、去重表、消费者面、时序约束口径同步 |
| `rule-engine/tests/{match,rules,engine,main}.test.ts` | 多节点、直写、空条件按节点裁决的用例；既有断言同步 |
| `symbol-normalizer/src/main.ts` | 指南消费者改 `sources: ["session-start", "compaction", "step-end"]` + `directWrite: ["session-start", "compaction"]`（`ConsumerRegistrar` 结构面补 `directWrite`） |
| `symbol-normalizer/README.md`、`symbol-normalizer/docs/DESIGN.md`、`symbol-normalizer/tests/main.test.ts` | 注册口径与断言同步 |
| `TUI/docs/DESIGN.md` | 「解锁后自动加载行为 skill」段：`step-end` → 「会话开始 + 压缩完成」口径同步（供重建） |
| `docs/BACKLOG.md`（条目状态）、本追踪文档 | 流程记录 |
| （仓库外，用户已同意）`~/.dsh/rule-engine/rules.json` | `skill-autoload` 改 `sources` + `directWrite`（改前贴 diff） |

**#5（待盘点后细化）**：`TUI/src/app/commands.ts`、各插件命令注册、`TUI/docs/COMMANDS.md`（+ `COMMANDS-SPEC.md`）、相关测试。

**#7（评估，结论出来后细化）**：追踪文档的评估结论；如实施则涉及各插件告警出口 + TUI 桥。

**#1（待读码后细化）**：`task-engine/src/*`、`task-engine/README.md`、`task-engine/docs/{DESIGN,BACKLOG}.md`、`task-engine/tests/*`。

### 明确不做

- 不拆规则（用户已裁定）。
- 不动 `turn-end` 的违规审查（符号规范）。
- 不改 `STATUS.md`（由用户择时更新）。

## 实现记录

2026-10-02（#8，按条目顺序第一件）：

1. `docs/BACKLOG.md` 四条目标「进行中（2026-10-02）」；本追踪文档建立（含决策与计划改动文件清单）。
1. 用户裁定 D1（A 形态）与 D4（现在就改运行时 `rules.json`）。
1. **仓库内代码（17 个文件，全部在计划清单内）**：
   - `rule-engine/src/types.ts`：`Rule.source` 接受单节点或节点数组 + `Rule.sources`（持久化回流写法）+ `Rule.directWrite`；`NormalizedRule.sources` / `directWrite`；`RuleSummary.sources` / `directWrite`；`ConsumerRegistration.directWrite`。
   - `rule-engine/src/match.ts`：`compileMatcher(spec)`（去掉 source 入参）；`CompiledMatcher.match(text, source)`——空条件语义改为**判定期按触发节点**裁决。
   - `rule-engine/src/rules.ts`：新增 `normalizeRuleSources`（单值 / 数组 / `sources` 三类入参；非法项与空数组报错，错误信息仍含「source 非法」；重复节点去重并 warning）与 `normalizeDirectWrite`（越界 / 非法项丢弃并 warning）。
   - `rule-engine/src/engine.ts`：多节点命中（`sources.includes(trigger)`）、判定传触发节点、`directWrite` 节点跳过投影去重判断（规则 + 消费者两处）、`#needsText` / `evaluate` / `summaries` 同步、`update()` 处理 `source` / `sources` 覆盖并新增 `directWrite` 键、消费者侧 `normalizeDirectWriteNodes` 校验。
   - `rule-engine/src/tools.ts`：`rule_add` / `rule_update` 的 `source` 参数改 `string | array`，新增 `directWrite` 参数，`ruleFromArgs` 带上 `directWrite`。
   - `symbol-normalizer/src/main.ts`：指南消费者改 `sources: ["session-start", "compaction", "step-end"]` + `directWrite: ["session-start", "compaction"]`（`ConsumerRegistrar` 结构面补 `directWrite`）。
   - 文档：`rule-engine/README.md`（节点表数组说明、去重表新增 `directWrite` 行、工具族参数、消费者面、配置示例新增 `session-guide` 多节点示例、单测计数 76 → 83）、`rule-engine/docs/DESIGN.md`（§4 多节点、§6 `directWrite`、§10 注册字段）、`symbol-normalizer/{README.md,docs/DESIGN.md,src/guide.ts}`、`TUI/docs/DESIGN.md`（skill 承载段追加 2026-10-02 口径）。
   - 测试：`rule-engine/tests/{match,rules,engine}.test.ts`（空条件按节点裁决、多节点 + 直写、消费者直写、越界告警）、`symbol-normalizer/tests/main.test.ts`（sources + directWrite 断言）。
1. **仓库外运行时（用户 2026-10-02 同意，改前已贴 diff）**：`~/.dsh/rule-engine/rules.json` 的 `skill-autoload` 改为 `source: ["session-start", "compaction"]` + `directWrite: ["session-start", "compaction"]`（保留 `dedupeInRecord: 1` 作无直写节点时的兜底，`description` 重写，**正文未改**）。原件备份 `tmp/rules.json.orig`，拟稿 `tmp/rules.json.proposed`。首次 `cp` 被只读沙箱拒绝，经用户授权以 `danger-full-access` 重试成功（2026-10-02 02:34）。
1. `format` 跑过全部改动文件（其中 `rule-engine/tests/engine.test.ts`、`rule-engine/tests/match.test.ts` 被 prettier 整形）。
1. **#8 关闭（2026-10-02）**：用户重启 `dsh --profile fff` 后确认「已自动注入」，真机证据见「测试与证据」；条目标「完成」并从 `docs/BACKLOG.md` 清理，本追踪文档继续承载 #5 / #7 / #1（按用户裁定「只关 #8，然后继续做下一个」）。

## 测试与证据

2026-10-02 已跑（命令 + 结果）：

| 命令 | 结果 |
| --- | --- |
| `cd rule-engine && npm run check` | 通过（无错误输出） |
| `cd rule-engine && npm run build` | 通过（先修掉一处测试侧类型错：`directWrite: ["step-end", "nope"]` 需 `as unknown as RuleSource[]`） |
| `cd rule-engine && npm test` | `tests 83 / pass 83 / fail 0` |
| `cd symbol-normalizer && npm run check` / `npm run build` | 通过 |
| `cd symbol-normalizer && npm test` | `tests 38 / pass 38 / fail 0` |
| 根 `npm run check`（17 包串行） | `exit 0`，`error TS` 计数 0 |

顺序说明（供复核）：首轮单测在 `format` **之前**跑；`format` 后按用户指令**重跑全部测试**（下表），结论不变。

| 命令（2026-10-02 补跑，`format` 之后） | 结果 |
| --- | --- |
| `cd rule-engine && npm test` | `tests 83 / pass 83 / fail 0` |
| `cd symbol-normalizer && npm test` | `tests 38 / pass 38 / fail 0` |
| `node tmp/injection-timing-smoke.mjs`（dist 级：真实 `rule-engine/dist` + `symbol-normalizer/dist` 接线） | `SMOKE_PASS`，exit 0，告警 0。四步：① `session-start` 合并直写一条（`sourceId = skill-autoload+consumer:symbol-normalizer-guide`）② `step-end` 不注入 ③ `compaction` 直写（投影已有仍发）④ 投影清空后步末补回一条 |
| 根 `npm run test`（`scripts/test-parallel.sh`） | `exit 0`；16 包全 `OK`，合计 `pass 1910 / fail 0` |

**真机复盘（2026-10-02，用户重启 `dsh --profile fff` 后「已自动注入」）**：

- 证据路径：`~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/tui-8a585495-e038-4fbd-a1cf-fe764d3a6021/session.v4.jsonl.zstd`（`zstd -dc` 解到 `tmp/session-latest.jsonl`，623 事件；临时探针 `tmp/session-evidence.mjs` 跑完已删）。
- 两条 rule-engine 注入（`#27` / `#575`）均为**合并消息**：`source.summaries = ["解锁后加载 i-have-adhd / karpathy-guidelines", "符号规范（会话开局指南）"]`。
- 触发节点判定为 `session-start`：`skill-autoload` 此刻只挂 `session-start` / `compaction`，而本会话日志无 `compaction/end`——若触发点是 `step-end`（指南的兜底节点），合并消息里不会出现该 skill 规则。
- `#575` 出现在 `session/end-seed` 之后的又一段会话建立（恢复 / 再建）→ 与「`session-start` 含恢复、直写不判断，故会再注入一次」口径一致。
- **未覆盖**：压缩面（`compaction/end` 后第一步即带注入）本会话未发生，该路径由 dist 冒烟（第 ③ 步）覆盖。

未做（交接给后续）：

1. `rule-engine/demo` 未跑（可选）。
1. 条目 #5 / #7 / #1 未开始（本任务继续接取）。

## 交接（2026-10-02 中断点）

**当前状态**：条目 #8「注入时机调整」**已完成并关闭**（机械验证 + 真机复盘通过，条目已从 `docs/BACKLOG.md` 清理）；本追踪文档继续承载未开工的三条（#5 slash 命名规范 / #7 插件告警通道评估 / #1 task-engine 执行扩展，BACKLOG 仍标「进行中（2026-10-02）」）。

**工作区**：代码 + 测试 + 文档已提交（`feat(rule-engine,symbol-normalizer): 注入时机支持多节点与直写`）；#8 关闭的文档变更按用户 2026-10-02 指示单独提交（BACKLOG 条目清理 + 本文件真机证据与收尾记录）。`tmp/` 内已清理临时物（`session-latest.jsonl` / `session-evidence.mjs` / `rules.json.proposed` / 日志 / 冒烟脚本），仅保留 `rules.json.orig`（运行时规则原件备份，勿删）。

**下一步**（用户 2026-10-02 指示「只关 #8，然后继续做下一个」）：接 #5「slash 命令命名规范：不用缩写」——先盘点本地 / 宿主 / 插件命令的缩写与晦涩名，产出改名清单 + 兼容策略（旧名是否留别名、何时移除），经用户裁定后实施。

**注意**：本任务接取的是四条（BACKLOG 均已标「进行中（2026-10-02）」），关闭时四条一起处理；`STATUS.md` 不由流程改；提交按 `docs/WORKFLOW-STANDARD.md` §5 的四个询问点征得同意。

## 收尾

**条目状态变更（2026-10-02）**：

- 「注入时机调整：会话开始 / 压缩完成后直写，不等步末」：标「完成」并已从 `docs/BACKLOG.md` 清理（记录见本文件「实现记录」「测试与证据」；实现落点 commit `feat(rule-engine,symbol-normalizer): 注入时机支持多节点与直写`，运行时规则改动在仓库外 `~/.dsh/rule-engine/rules.json`）。
- 其余三条（slash 命令命名规范 / 插件运行期 stderr 告警显示统一（评估）/ task-engine 执行扩展）：**本任务继续接取**，BACKLOG 保持「进行中（2026-10-02）」，待完成后一并关闭；本文件**不归档**（留 `docs/implementation/`）。

**中途范围说明**（流程要求）：2026-10-02 用户裁定「只关 #8，然后继续做下一个」——本次先在开放任务内关闭 #8，剩余三条按原接取范围继续，未新增/移除条目。

**回写**：DESIGN / README 已随实现同步（`rule-engine/README.md`、`rule-engine/docs/DESIGN.md`、`symbol-normalizer/{README.md,docs/DESIGN.md}`、`TUI/docs/DESIGN.md`），关闭 #8 无需额外回写；`STATUS.md` 不由流程改。

**临时物清理**：`tmp/session-latest.jsonl`、`tmp/session-evidence.mjs`、`tmp/rules.json.proposed`、`tmp/check.log`、`tmp/test-all.log`、`tmp/injection-timing-smoke.mjs` 已删；保留 `tmp/rules.json.orig`（运行时规则原件备份，用于回退对照）。
