# `metric-loop` 的 `schedule` 续排提示结构性不可执行（接取条目：`docs/BACKLOG.md`「`metric-loop` 的 `schedule` 续排提示结构性不可执行」）

状态：关闭　　开启：2026-10-06　　关闭：2026-10-06
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让 `metric_loop` 返回的续排提示要么**可被直接调用**（字段对齐官方 `schedule_create` 入参 schema），要么**如实降级为纯文案**（去掉「可直接调用」的暗示并写明降级口径）。二选一，不留「看着可调、实则必错」的中间态。

## 计划改动文件清单（先写清单，未列出的文件一律不改）

- `metric-loop/src/engine.ts` —— 续排提示的字段 / 措辞（按决策二选一）
- `metric-loop/src/types.ts` —— 若提示结构变更，同步类型
- `metric-loop/tests/` —— 受影响用例；补一条**断言提示字段**的用例（条目验收要求）
- `metric-loop/README.md` —— 提示语义与降级口径
- 本追踪文档、（关闭时）`docs/BACKLOG.md` 条目清理

## 调研

来源：**全局安装树**（`dsh 0.2.0-rc.2`，与前一条目的教训一致——npx 缓存是 0.1.5-rc.2 旧树）+ 本仓源码，无真机运行。

### 官方 `schedule_create` 的完整校验（`dsh-schedule/lib/index.js`）

`validateCreateArgs()`（`:1937-1960`）：

| 规则 | 依据 |
| --- | --- |
| 允许键**白名单**：`prompt` / `title` / `after_seconds` / `at` / `every_seconds` / `daily` / `weekly` / `cron`（出现其它键 → `invalid_selector`） | `:1938` |
| **恰好一个**选择器（六个里选一个，多/零个 → `invalid_selector`） | `:1938-1941` |
| `prompt` trim 后非空（否则 `invalid_prompt`） | `:1942-1945` |
| `title` **必填**、trim 后非空、**≤120 字符**（否则 `invalid_prompt`） | `:1946-1954` |
| `after_seconds` 为正**安全整数**（否则 `invalid_rule`） | `:1955-1958` |
| `every_seconds` 为安全整数且 **≥60**（否则 `frequency_too_high`） | `:1926-1935` |

工具注册面（`:2120-2145`）：`prompt` 与 `title` 均为 `required: true`。

### 本包现状（`metric-loop/src/engine.ts:229-240`）

```ts
return {
  tool: "schedule_create",
  args: {
    after_seconds: afterSeconds,   // Math.max(1, ceil(nextWakeMs/1000)) → 正安全整数 ✓
    prompt: `[metric-loop] 自动唤醒：调用 metric_loop tick（wake=auto，id=${state.id}）继续指标循环`,  // 非空 ✓
  },
};
```

逐条比对：允许键 ✓、恰好一个选择器 ✓、`prompt` 非空 ✓、`after_seconds` 正安全整数 ✓ —— **唯一缺口是 `title` 缺失**，落 `invalid_prompt`（`:1946-1949`）。

### 受影响面

- 类型：`TickResult["schedule"]["args"]`（`src/types.ts:157-160`）当前只声明 `{ after_seconds, prompt }`
- 测试：`tests/engine.test.ts:245-261` 只断言 `tool` 与 `after_seconds`，**没有**字段契约断言（条目验收要求补）
- 文档：`README.md:24`（结果说明）与 `:77`（边界与限制：可执行性取决于 profile 是否挂载 `dsh-schedule`）

## 决策

**选项 1：补 `title`，让提示真的可调用**（不选「降级为纯文案」）。

理由：

- 除 `title` 外提示已与官方校验**逐条相符**（见上），缺口只有一处，补上即从「必错」变「可调」；
- 选项 2（去掉「可直接调用」措辞、纯文案降级）成本相同但**主动放弃能力**：`dsh-schedule` 一旦挂载，自动续排就能工作；
- `title` 取 `` `[metric-loop] ${state.id}` `` —— 带循环 id，便于在宿主任务卡/列表里认出是哪条循环；远低于 120 字符上限，且 trim 后非空（`id` 归一化保证非空，见 `types.ts` 的 id 规则）。
- 不改降级路径语义：未挂载 `dsh-schedule` 时提示仍是纯文案，README 口径保留并补一句「已对齐官方入参 schema（含必填 `title`）」。

## 规划

**计划改动文件清单（未列出的文件一律不改）**

- `metric-loop/src/engine.ts` —— `scheduleHint()` 的 `args` 增 `title`
- `metric-loop/src/types.ts` —— `TickResult["schedule"]["args"]` 增 `title: string`
- `metric-loop/tests/engine.test.ts` —— 现有用例补 `title` 断言；**新增一条字段契约用例**（对齐官方：`title` / `prompt` trim 非空、`title` ≤120、恰好一个选择器、`after_seconds` 为正安全整数、无白名单外的键）
- `metric-loop/README.md` —— `:24` 结果说明补 `title`；`:77` 写明「提示字段已对齐官方 `schedule_create` 入参 schema，可直接调用；未挂载时仍是纯文案」
- 本追踪文档、（关闭时）`docs/BACKLOG.md` 条目清理

**明确不做**

- 不改 schedule/frequency 策略（仍是 `after_seconds` 一次性链式续排，不用 `every_seconds`）
- 不去挂 `@deepseek-ai/dsh-schedule`（profile 外，需授权；且属另一议题）
- 不改 `guardScope` / cadence / 边界停止等无关逻辑
- 不改 `wake=auto` 语义与 deferred 行为

## 实现记录

- 2026-10-06：接取条目并标记「进行中」；建追踪文档 + 计划改动文件清单；调研官方 `schedule_create` 校验（全局树 0.2.0-rc.2）→ 决策「补 `title`」。
- 2026-10-06：实现（4 个文件）——
  - `metric-loop/src/engine.ts`：`scheduleHint()` 的 `args` 增 `title: \`[metric-loop] ${state.id}\`\`；文档注释写明对齐的是官方哪条校验与本条回归背景；
  - `metric-loop/src/types.ts`：`TickResult["schedule"]["args"]` 增 `title: string`；
  - `metric-loop/tests/engine.test.ts`：现有用例补 `title` 断言；**新增**「字段契约对齐官方 `schedule_create` 入参校验」用例（键白名单 / 恰好一个选择器 / `after_seconds` 正安全整数 / `prompt` 与 `title` trim 非空 / `title` ≤120 / id 出现在 title 与 prompt）；
  - `metric-loop/README.md`：`:24` 结果说明补 `title`；`:77` 写明字段已对齐官方校验、`title` 取 `[metric-loop] <id>`、未挂载时仍是纯文案；单测数 44 → 45。

## 测试与证据

- `cd metric-loop && npm run check` → 通过（tsc strict）
- `cd metric-loop && npm run build` → 通过
- `cd metric-loop && npm test` → **45 / 45 通过**（新增的契约用例即条目验收要求的「断言提示字段」）
- 反向验证（判定性证据，**已实跑**）：临时删掉 `title` 行后重跑 → **2 例转红**（`scheduleHint` 原用例与新增的契约用例），恢复后回到 45/45。即该用例确实守住「缺失必填字段」这一回归，而不是自我一致性断言。
- **未验证**：`npm run smoke`（宿主联调）**在本沙箱内无法运行** —— `smoke/smoke.mjs:40` 硬编码 `~/.dsh/profiles/<profile>`，需在项目目录外创建 profile 并 `pnpm install`，workspace-write 沙箱下 EROFS/不存在；两次尝试（默认与 `DSH_HOME` 指向工作区）均在 profile 引导步失败，**与本改动无关**。要真机确认需在沙箱外跑一次 `cd metric-loop && npm run smoke`（断言跨进程状态与 plateau 停止，不覆盖 schedule 提示本身）。

## 收尾

- 条目「`metric-loop` 的 `schedule` 续排提示结构性不可执行」已从 `docs/BACKLOG.md` §2 **清理移除**，其余条目重编号；本文件移入 `docs/archived/`。
- 关闭后回写：`metric-loop/README.md`（结果字段说明 `:24`、边界与限制 `:77`、单测数 44 → 45）。其余文档无需改（本包无 `docs/`，轻量包豁免）。
- 途中发现的新问题：无。
- 遗留（明确不做，已在「规划」记录）：不挂 `@deepseek-ai/dsh-schedule`（profile 外，需授权）——提示的可执行性仍取决于 profile 是否挂它；未挂时提示只是文案，行为与改前一致。
- `STATUS.md` 按流程由用户择时更新，本次不改。
- 提交：前三个询问点用户均选择留到关闭后；本次为**关闭后一次性提交**。
