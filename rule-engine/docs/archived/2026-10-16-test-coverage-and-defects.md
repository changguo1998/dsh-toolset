# rule-engine 测试覆盖补齐与三处行为修正（接取条目：rule-engine/docs/BACKLOG.md「回合正文缓冲的 20000 字符截断会让消费者漏检」「`assistant/message` 的 replace 语义与 TUI 不一致（可能对被覆盖内容误报）」「`turn/end` 的 `reason` 非字符串时被当成 `completed`（异常收尾会被误唤醒）」「工具族 `execute` 没有回归网（`tools.ts` 函数覆盖 33.33%）」「一次触发按 `delivery` 分组注入与段数预算共享无用例」「`registerConsumer` / `update` 的输入校验分支零覆盖」「测试覆盖零散补钉（配置缺省 / 内存上限 / IO 降级 / 告警断言 / 文档漂移）」）

状态：关闭　　开启：2026-10-16　　关闭：2026-10-16
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

一次接取 rule-engine 全部 7 条未完成条目：3 条行为修正（#1 超长正文上限与告知、#2 `replace` 丢弃、#3 `turn/end` reason 归一）+ 4 条测试覆盖补齐（工具族 `execute`、多 `delivery` 分组与段数预算、输入校验分支、零散补钉）。

## 调研

来源：2026-10-16 测试覆盖评估（覆盖率实测 + 读码）与项目级「助手正文三面一致核对」的追踪文档（任务 A / C 实测）。

1. 覆盖率基线（`node --experimental-transform-types --experimental-test-coverage --test 'tests/*.test.ts'`，改动前）：107 例全绿；总行 93.11% / 分支 91.21% / 函数 89.71%；`tools.ts` 行 67.81% / 分支 80.00% / 函数 33.33%（5 个工具的 `execute` 与 `ruleFromArgs` 零用例，`grep -rn "\.execute(" tests/` 零命中）。
2. 行为缺口：`TEXT_BUFFER_LIMIT = 20000` 截断后静默（判定面与显示面不一致）；`surfaceOp === "replace"` 的消息照常缓冲（TUI 已跳过）；`turn/end` 的 `reason` 非字符串一律回落 `completed`（对象形态 `{ kind: "aborted" }` 也照常唤醒）。
3. 参考实现位置：`src/engine.ts`（`TEXT_BUFFER_LIMIT:67` / `#buffer`；`assistant/message` 分支 `:504-508`；`turn/end` 分支与 `INJECTABLE_TURN_REASONS`）、`src/tools.ts`（5 个工具 + `ruleFromArgs` + `jsonText`）、`src/inject.ts:73`、`src/persist.ts:25-29,67-68,126-127`、`src/main.ts:108,114,169-175`。

## 决策

1. #1 超长正文口径
   - a. 只加透明告知（上限不变）
   - b. **提高上限 + 告知**（20000 → 200000）
   - c. 回合累计上限 + 告知
   - **选定 b**（用户 2026-10-16 裁定）。理由：真机样本最长 2875 字符，提高上限后基本不再触发；同时保留截断告警，避免静默丢内容。
2. #2 `replace` 语义
   - a. **丢弃该消息**（与 TUI 显示面一致）
   - b. 重置该 step 缓冲
   - c. 保持现状 + 文档说明
   - **选定 a**（用户 2026-10-16 裁定），并因此不进入 `turn-end` 载荷。
3. #3 `reason` 非字符串
   - a. **归一（读 `reason.kind`）+ 非法值不唤醒 + 告警**
   - b. 归一 + 不唤醒，不加告警
   - c. 只修对象形态
   - **选定 a**（用户 2026-10-16 裁定）。
4. #4-#7 测试补齐的组织方式
   - a. 逐条各写一份用例文件
   - b. **按包内既有文件归位补用例 + 新建 `tests/tools.test.ts`**
   - **选定 b**：与既有 10 个测试文件的分工一致。

## 规划

任务拆分（单批实施，7 条合并交付）：

1. 行为修正：#3（reason 归一）→ #2（replace 丢弃）→ #1（上限与告知）。
2. 测试补齐：#4（新建 `tests/tools.test.ts`）→ #5（多 `delivery` 分组与段数预算）→ #6（校验分支）→ #7（零散补钉 + README 用例数）。
3. 反向验证：3 处行为修正各撤掉一次，确认对应用例转红后恢复。
4. 收尾：关闭 7 条、追踪文档归档、README 口径回写。

计划改动文件清单：

| 文件 | 改动 |
| --- | --- |
| `rule-engine/src/engine.ts` | 上限 200000 + 截断告知；`replace` 丢弃；`turn/end` reason 归一与告警 |
| `rule-engine/tests/tools.test.ts` | 新建（#4） |
| `rule-engine/tests/turnEndMatrix.test.ts` | #3 断言由「已知缺陷固定」改为正向 |
| `rule-engine/tests/bufferBoundary.test.ts` | #1 / #2 用例 |
| `rule-engine/tests/engine.test.ts` | #5 / #6 / #7 用例 |
| `rule-engine/tests/throttleAndReadonly.test.ts` | #5 / #7 用例与弱断言收紧 |
| `rule-engine/tests/inject.test.ts` | #7（`summaries` / flush 抛错 / 无 followup / 缺省 stderr 告警） |
| `rule-engine/tests/persist.test.ts` | #7（`defaultStateDir` / 写失败降级 / `removed` 非数组） |
| `rule-engine/tests/main.test.ts` | #7（catch 分支 / 装载期告警上限） |
| `rule-engine/tests/rules.test.ts` | #7（未覆盖分支） |
| `rule-engine/README.md` | 用例数修正；节点表补 replace / 上限 / reason 口径 |
| `rule-engine/docs/BACKLOG.md` | 7 条状态（进行中 → 关闭时清理） |
| `rule-engine/docs/implementation/2026-10-16-test-coverage-and-defects.md` | 本追踪文档 → 关闭后移入 `archived/` |

明确不做：`#1` 的回合累计 / 滑动窗口口径；`#2` 的「重置 step 缓冲」；`#3` 在 TUI 侧的任何改动；TUI 侧同类测试补充（另包）。

## 实现记录

- 2026-10-16：7 条标〔进行中〕并建档；三项裁定（上限 200000 + 告知 / `replace` 丢弃 / reason 归一 + 非法值不唤醒 + 告警）落到代码。
- 2026-10-16：`src/engine.ts`（+57/-4）—— `TEXT_BUFFER_LIMIT` 20000 → 200000 且 `#buffer` 在超限时告警；`assistant/message` 分支对 `surfaceOp: "replace"` 直接返回（仍更新 `turn`）；新增 `#turnEndReason`（字符串按字面、对象读 `kind`、缺省 `undefined` → `completed`、其余非法值 → 告警 + 返回 `null` 不唤醒）与两个纯函数 helper `surfaceOpOf`（事件顶层优先，兼容 `data.surfaceOp`）、`previewValue`（JSON 优先，循环引用 / BigInt 落 `String` 兜底）。
- 2026-10-16：测试补齐 —— 新建 `tests/tools.test.ts`（7 例：5 个 `execute` + `ruleFromArgs` 装配 + `patch.text`·`patch.summary`·`patch.action` + `{ok,error}` 契约 + 5 个 catch 分支 + `jsonText` 循环引用 / BigInt / `String` 也抛）；`turnEndMatrix` 反转为正向断言（对象 4 形、非法 8 形、字符串 5 形）；`bufferBoundary` 阈值改 199999/200000/200001 并补截断告警与 replace 用例；`throttleAndReadonly` 补 delivery 分组 + 段数预算 + 上限告警文案；`engine` 补校验分支（10 例）、内存态上限、`status()` 字段级等值、兜底分支；`main` / `inject` / `persist` / `rules` 按 #7 逐点补齐。用例数 107 → 140。

## 偏差

1. **未在 `types.ts` 加载荷标记**：决策 1 允许「仅告警」，加 `truncated` 标记需把字段从 `#buffer` 贯穿 `#dispatch → #collectConsumers → ConsumerContext`，契约改动大于收益，故只发告警（消费者侧仍可观测）。
2. **分支覆盖未清零**：总分支 91.21% → 96.91%（行 100%）。node 内置报告不列分支明细、仓内无 c8，剩余基本是防御性兜底的另一侧，未逐分支追踪。
3. **`bufferBoundary.test.ts` 的阈值用例改写**：旧断言基于 20000 上限，随决策 1 必须改为 199999/200000/200001；同时新增告警与 replace 断言（只增不减，但改动了既有用例的数值）。
4. **`ruleFromArgs` 未导出**：经 `rule_add.execute` 间接覆盖，未为测试扩大生产导出面。
5. **跨包影响（未在本任务修，登记在案）**：`md-table-check/tests/surfaceDifferential.test.ts` 的镜像口径以修正前行为为基准 —— 本任务后该文件 3 例转红（`对拍: 定向用例` 的 replace 覆盖、`对拍: 随机序列` 的收尾 reason、`已知差异（登记在案）` 的 replace / 超长截断），实测 `md-table-check` 61 例 → 58 通过 / 3 失败；按「不改其它包」的边界留给 md-table-check 任务同步（其 #3 与 #6 条目范围）。

## 测试与证据

- `npm --prefix rule-engine run check`（`tsc -p tsconfig.json --noEmit`）：0 错误。
- `npm --prefix rule-engine test`：`ℹ tests 140 / ℹ pass 140 / ℹ fail 0`（改动前 107/107）。
- 覆盖率（`node --experimental-transform-types --experimental-test-coverage --test 'tests/*.test.ts'`，前 → 后）：总行 93.11 → **100.00**、分支 91.21 → **96.91**、函数 89.71 → **97.84**；`src/tools.ts` 行 67.81 → **100.00** / 分支 80.00 → **88.00** / 函数 33.33 → **100.00**；`src/main.ts` 行 95.47 → 100.00、`src/inject.ts` 行 96.02 → 100.00。
- 反向验证（每次恢复后 `sha256sum src/engine.ts` = `8a644820…a06c63c`）：
  1. reason 归一撤掉 → `turnEndMatrix` `✖ P3 触发矩阵：reason 归一…`、`AssertionError: { kind: 'aborted' }: 不注入`、`pass 4 / fail 1`；恢复 → 5/0。
  2. replace 丢弃撤掉 → `bufferBoundary` `✖ …surfaceOp = "replace" 不进缓冲…`、`AssertionError: replace 的内容不进回合载荷（与 TUI 显示面一致）`、`pass 7 / fail 1`；恢复 → 8/0。
  3. 上限回 20000 且删告警 → 2 例转红（`载荷长度为上限`、`200001 截到 200000`）；仅删告警（上限 200000）→ 1 例转红（`截断恰一条告警`）；恢复 → 8/0。
- 改动范围：`git status --porcelain` 仅 `rule-engine/` 内路径（11 个 `M` + 新建 `tests/tools.test.ts` 与追踪文档）。

## 收尾

- 回写：`rule-engine/README.md`（用例数 87 → 140；节点表补 `replace` 丢弃、上限 200000、截断告警、`turn/end` reason 归一的口径）。
- 关闭：BACKLOG 条目 1-7 全部完成并移除（同日写入关闭记录）。
- 归档：本文件移入 `rule-engine/docs/archived/2026-10-16-test-coverage-and-defects.md`。
- 遗留：分支覆盖 96.91%（见偏差 2）；跨包对拍同步（见偏差 5，属 md-table-check 任务）。
