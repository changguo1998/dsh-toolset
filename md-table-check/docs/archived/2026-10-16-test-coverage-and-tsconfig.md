# md-table-check 测试补齐与 tsconfig 门禁修复（接取条目：md-table-check/docs/BACKLOG.md「跨包对拍用例越出本包 tsconfig 的 rootDir，check / build 失败」「真实 rule-engine 端到端注入无用例」「配置透传断言过弱（变异存活）」「测试覆盖零散补钉（降级分支 / 围栏边界 / 互证复刻 / 文档口径）」「表头与分隔行之间有空行的表格不报」「行内代码里的竖线按字面切分导致误报」）

状态：关闭　　开启：2026-10-16　　关闭：2026-10-16
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

一次接取 md-table-check 全部 6 条未完成条目：#3 先修 `tsconfig` 门禁（#4 的前置），随后 #4 / #5 / #6 补测试面，#1 / #2 按裁定收敛口径；另需同步 rule-engine 2026-10-16 行为变更引发的跨包对拍差异。

## 调研

来源：2026-10-16 测试覆盖评估（覆盖率实测 + 读码）、rule-engine 同日任务的实测输出。

1. 覆盖率基线：61 例全绿（7 个测试文件）；`src/checker.ts` 行 / 分支 / 函数均 100%，`src/main.ts` 行 100% / 分支 97.56%（唯一未覆盖分支 = `:108` 的 `ctx ?? {}` 右侧）。
2. 门禁现状（#3，P1）：`npm --prefix md-table-check run check` 退出码 2、`error TS` 7 处（TS6059 六处来自 `tests/reasoningSeparation.test.ts` / `tests/surfaceDifferential.test.ts` 直接 import `rule-engine/src/*.ts`，超出本包 `rootDir: "."`；TS2345 一处为 `tests/surfaceDifferential.test.ts:113` 的 `kind: unknown` 传入 `INJECTABLE.has()`）；根仓 `npm run check` 链尾本包失败而其余 21 包通过；报错态下 `build` 仍 emit，会往 `rule-engine/src/` 落 12 个未跟踪产物。
3. 跨包对拍受 rule-engine 2026-10-16 变更影响：其镜像口径以修正前行为为基准（`TEXT_LIMIT = 20_000`、replace 仍缓冲、非字符串 reason 回退 `completed`）→ 本任务开工时 `npm --prefix md-table-check test` 为 `tests 61 / pass 58 / fail 3`（`对拍: 定向用例` 的 replace 覆盖、`对拍: 随机序列` 的收尾 reason、`已知差异（登记在案）` 的 replace / 超长截断）。
4. 参考实现位置：`src/checker.ts`（`FENCE_RE:61`、`splitCells:38-42`、闭栅判定 `:150-160`、`nonNegativeInt:128-132`）、`src/main.ts:108,114,126-128`、`tests/surfaceDifferential.test.ts`、`tests/tuiParity.test.ts:129-141`。

## 决策

1. #3 tsconfig 方案
   - a. 给跨包对拍用例单独的 `tests/tsconfig.json`（`rootDir` 上移 / project references 指向 rule-engine，主 program 排除这两个文件）
   - b. 改为经 `rule-engine/dist` 引用（对拍对象变成编译产物，需先 build）
   - c. 把两个跨包对拍用例移出类型检查面
   - **选定 a**（用户 2026-10-16 裁定）：保住「与真实实现同输入对拍」的强度——只把跨包用例从主 program 排除，单独给 `tests/tsconfig.json`（`rootDir` 上移），并修掉 `tests/surfaceDifferential.test.ts:113` 的类型收窄。
2. #1 空行分隔口径
   - a. 不检出（转为「已裁定不做」备查）
   - b. 检出（仅吃恰好一行空行 + 新提示措辞）
   - **选定 a**（用户 2026-10-16 裁定）：口径写进 `README.md` 形态表，条目转「已裁定不做」。
3. #2 行内代码竖线口径
   - a. 保持与 TUI 同口径（本条转「已裁定不做」）
   - b. 两侧同时改代码跨度感知切分（需 TUI 侧 worktree）
   - **选定 a**（用户 2026-10-16 裁定）：README 形态表写明代价（代码跨度内的 `|` 会多报）。
4. #6 的围栏混用标记（```` ``` ```` 开 / `~~~` 闭）
   - a. 对齐 TUI 的布尔翻转（检查器也认混用闭栅）
   - b. 保持「同前缀」要求，把差异写进 README 形态表 + 用例钉住
   - **选定 a**（用户 2026-10-16 裁定）：检查器改为无条件翻转（与 `TUI/src/app/layout/build-box.ts:702-708` 一致），消除「围栏混用标记时两侧都沉默」。

## 规划

计划改动文件清单：

| 文件 | 改动 |
| --- | --- |
| `md-table-check/tsconfig.json` | 主 program 收敛（排除 3 个跨包用例） |
| `md-table-check/tests/tsconfig.json` | 新建：`rootDir` 上移到仓库根，把跨包用例纳入类型检查 |
| `md-table-check/package.json` | `check` 串跑两个 program；新增可选 `check:no-cross-emit` |
| `md-table-check/src/checker.ts` | 围栏行无条件翻转（唯一行为改动） |
| `md-table-check/tests/surfaceDifferential.test.ts` | 同步 rule-engine 新口径 + 修类型收窄 |
| `md-table-check/tests/integration.test.ts` | 新建（#4 端到端注入） |
| `md-table-check/tests/main.test.ts` | #5 配置透传 + #6 降级分支 |
| `md-table-check/tests/checker.test.ts` | 围栏混用 / 变体 / 裸 `\` / 转义竖线 / 上限 0 |
| `md-table-check/tests/tuiParity.test.ts` | 围栏守卫改 import TUI 真实正则 + 两例互证 |
| `md-table-check/tests/{displaySurface,formMatrixSnapshot}.test.ts` | 常量引用与快照 |
| `md-table-check/README.md` | 形态表口径、tsconfig 结构、用例数 |
| `md-table-check/docs/BACKLOG.md` | 条目状态（进行中 → 关闭时清理；#1 / #2 转已裁定不做） |
| `md-table-check/docs/implementation/2026-10-16-test-coverage-and-tsconfig.md` | 本追踪文档 → 关闭后移入 `archived/` |

## 实现记录

- 2026-10-16：6 条标〔进行中〕并建档；跨包对拍受 rule-engine 变更影响的 3 例失败已定位（见调研 3）。
- 2026-10-16：#3 门禁修复 —— 主 `tsconfig.json` 的 `include` 收敛为 `src` + `index.ts` + `tests/*.test.ts` 并 `exclude` 三个跨包用例；新增 `tests/tsconfig.json`（`extends` 主配置、`rootDir` 上移到仓库根、`noEmit`）把它们重新纳入检查面；`package.json` 的 `check` 改为 `tsc -p tsconfig.json --noEmit && tsc -p tests/tsconfig.json`；`tests/surfaceDifferential.test.ts:113` 的类型收窄改为 `modelTurnEndReason(value): string | null`。另加可选自检 `check:no-cross-emit`（`git status --porcelain -- ../rule-engine/src ../TUI/src` 须为空）。
- 2026-10-16：跨包对拍同步 —— `tests/surfaceDifferential.test.ts` 的镜像口径对齐 rule-engine 新行为（上限 200000、`replace` 丢弃、reason 归一 + 非法值不唤醒），「已知差异（登记在案）」改为「该差异已修复」的正向断言并补告警断言。
- 2026-10-16：#4 新建 `tests/integration.test.ts`（装载真实 rule-engine 插件 → 真实消费者面 → 本包 `apply` → 真实注入器送达宿主）：坏表回复注入 1 次、`via === "followup"`、`message.source.summary === FEEDBACK_SUMMARY`、正文含表头行号与「完整重发一次」、`source.kind === "rule-engine"` 且运行期 0 告警；好表 0 次；`dedupeInRecord: 0` 下两回合各 1 次。
- 2026-10-16：#5 `tests/main.test.ts` 补非缺省四字段透传（`sources` / `delivery` / `dedupeInRecord` / `maxTables`）与「两张坏表只列 1 张 + 另有 1 处不一致未列出」的 `check` 透传判据。
- 2026-10-16：#6 零散补钉 —— 降级两分支（无 ctx / `ruleEngine` 无 `registerConsumer`）；围栏行无条件翻转 + `checker.test.ts` 三组断言 + `tuiParity` 互证 + 形态快照（19 → 20）；裸 `\` 与 TUI 同形；6 种围栏变体（info string / 1-3 空格 / 四反引号 / `~~~`）+「4 空格不算围栏」；上限 0 钉口径；`tuiParity` 围栏守卫改 import TUI 真实 `FENCE_RE`（取自 `markdown.ts` 的导出，动态 import）；`displaySurface` 改 import `FEEDBACK_SUMMARY`；数据行 / 分隔行 `\|` 三例；README 形态表两行口径 + 用例数。
- 2026-10-16：#1 / #2 按裁定转入 `docs/BACKLOG.md` 的「已裁定不做（备查）」区。

## 偏差

1. **未采用 project references**：`rule-engine/tsconfig.json` 无 `composite: true`，加 `references` 会报 TS6306 且需改他包配置（本任务禁止）→ 只做「`rootDir` 上移 + 双 program」，跨包用例仍在类型检查面内（`check` 串跑两个 program），强度不降。
2. **#4 的载荷断言取自真实送达面**：`InjectionRequest` 在真实注入器里不可观测，故以 `message.source.summary` / `message.content[0].text` / `via === "followup"`（真实注入器走了 followup 分支）等价替换条目里的 `payload.*` 措辞，并额外断言 `id` 非空、`content` 数组、`source.kind` 与 `[RULE] ` 前缀。
3. **#5 的变异对象**：`src/main.ts` 无 `DEFAULT_CONFIG` 常量，变异用把 `resolved.check` 换成 `{}`（等价于丢掉 `check` 透传），反向验证同样转红。
4. **`FENCE_RE` 的来源**：`build-box.ts` 的内联正则未导出，改 import `markdown.ts` 导出的同一正则（真源），并走动态 import 以免 TUI 源码进本包 program / build 落产物；降级理由写在用例注释与 README。
5. **`maxTables: 0` 的语义不一致未改行为**：按条目只钉口径 + 注释 + README。建议（未做）：把 `0` 解释为「用缺省」，或 `resolved.check.maxTables === 0` 时 `decide` 直接返回 `null`，使判定与提示同语义。
6. **真机复验未做**：条目验收里的「真机复验」需跑 `dsh --profile`，超出本任务允许范围；建议主线真机验「围栏混用标记闭栅后的坏表」这一新口径。

## 测试与证据

- 包 `npm --prefix md-table-check run check`：退出码 **0**、`error TS` 计数 0（改动前：退出码 2 / 7 处错误）。
- 根仓 `npm run check`：**22 包全绿**（链尾 md-table-check exit 0）。
- 包 `npm test`：`ℹ tests 73 / pass 73 / fail 0`（改动前 61 例；rule-engine 变更后曾 58/61）。分文件：checker 30 / displaySurface 10 / formMatrix 2 / integration 3 / main 10 / reasoning 9 / surfaceDifferential 4 / tuiParity 5。
- 根仓 `npm test`（22 包并行）：全绿（`OK rule-engine pass 140` / `OK md-table-check pass 73`）。
- 覆盖率（`--test-coverage-include='src/**'`）：`checker.ts` 行 / 分支 / 函数 100.00；`main.ts` 100.00 / **100.00**（分支 97.56 → 100）/ 100.00。
- 反向验证 ①（#5 变异：`resolved.check` → `{}`）：`✖ apply：非缺省配置四字段原样透传 + check 真的进 decide`、`AssertionError: maxTables=1：只列 1 张表   2 !== 1`，还原后 pass。
- 反向验证 ②（围栏撤回：闭栅改回「要求同前缀」）：```` ✖ 围栏混用标记（``` 开 / ~~~ 闭）… ````（`0 !== 1`）与形态快照漂移 `+ '表0 行0 | —' - '表1 行1 | L5:期望2[L6/delim=1]'`，还原后两条均 pass。
- `npm run build` + `npm run check:no-cross-emit`：exit 0；`git status --porcelain -- rule-engine/src TUI/src` 0 行（不再往他包 `src/` 落产物）。
- 改动范围：`git status --porcelain` 仅 `md-table-check/` 内路径（12 个 `M` + 新建 `tests/integration.test.ts` / `tests/tsconfig.json` / 追踪文档）。

## 收尾

- 回写：`md-table-check/README.md`（形态表 5 行新增 / 改写、上限 0 口径、tsconfig 双 program 结构、测试清单与命令、用例数）；`docs/BACKLOG.md`（#3-#6 关闭移除 + 关闭记录；#1 / #2 转「已裁定不做（备查）」）。
- 跨包：#4 新增的 `tests/integration.test.ts` 已纳入 `tests/tsconfig.json` 的检查面。
- 归档：本文件移入 `md-table-check/docs/archived/2026-10-16-test-coverage-and-tsconfig.md`。
- 遗留：`maxTables: 0` 语义（见偏差 5）、真机复验（见偏差 6）。
