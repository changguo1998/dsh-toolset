# 子任务数改口径：不设上限，超阈值必须声明枚举来源（接取条目：task-engine/docs/BACKLOG.md「子任务数改口径：不设上限，超阈值必须声明枚举来源」）

状态：关闭　　开启：2026-11-04　　关闭：2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改（已关闭，后续变更另开条目）。

## 目标

- 去掉机械门禁对一次 decompose 的硬上限（`maxChildren = 7`），改为「阈值 + 枚举来源声明」：
  子任务数超过阈值时，必须证明这批子任务是**枚举产生**（逐条对应一份清单），而不是把一个任务过度切碎。
- 校验可机械判定：条目数与子任务数一致、双向一一对应；不满足即带反馈打回，提示合并或再抽象一层。
- 8 条以内（含 8 条）的拆解行为不变，不新增必填字段负担。

## 调研

- 硬上限现状：`task-engine/src/gate.ts:15-28` 的 `GateConfig.maxChildren = 7`，数量规则在 `gate.ts:274-288`（0 条或超上限 → `rule: "too-many"`）。`maxRetries` / `maxConcurrent` 同处；插件 config 只暴露 `maxConcurrent`（`plugin.ts:69-70`、`plugin.ts:339-341`），故 `maxChildren` 无法由用户配置，是纯硬限。
- 调用链：`tools.ts:236-263`（`task_decompose` 解析入参）→ `engine.decompose`（`engine.ts:220-341`）→ `checkDecomposition(parent, children, cfg)`；语义蕴含门禁在 `engine.ts:306-320` 独立跑，机械门禁在前。
- 入参形态：`parseChildren`（`tools.ts:95-151`）把工具入参转 `ChildSpec`；`ChildSpec` 定义在 `types.ts:67-80`（含 `coverage` / `deps` / `executor`），事件 `plan/node-expanded` 直接落 `children`（`types.ts:120`）。
- 现状测试：`tests/gate.test.ts:69-76` 断言 8 条 → `too-many`；`tests/tools.test.ts` 覆盖 decompose 入参解析。
- 文档存量口径：`README.md:69`（机械门禁列举「数量」）、`README.md:95`（默认值 `maxChildren=7`）、`docs/DESIGN.md:66`（`maxChildren = 7`）需回写。
- 「枚举产生」的可判定形态：子任务与源清单逐条对应，故证据应**显式声明**（来源说明 + 逐条条目），而不是靠父帧 spec 里是否有编号列表这类文本启发（不可靠、易误判）。

## 决策

1. 数量上限口径：
   a) 保留 `maxChildren = 7` 硬上限，另设枚举豁免；
   b) 去掉硬上限，改为阈值 `enumerationThreshold = 8`：超过阈值必须声明枚举来源；
   c) 完全放开，不做枚举校验。
   → 选定 **b**：既满足「不设上限」，又把「过度分解」的拦截点从数量挪到可验证的枚举证据上。

2. 枚举证据形态：
   a) 机械检查父帧 spec / acceptance 里是否有编号列表且条目数不少于子任务数（纯文本启发）；
   b) decompose 输入显式带 `enumeration`（`source` + 逐条 `items`），每个子任务带 `enum_item` 对应其中一条；
   c) 只靠既有语义蕴含门禁兜底。
   → 选定 **b**：a 易误伤（spec 里的编号列表常是步骤而非清单）、c 缺机械拦截；b 的证据可逐条比对。

3. 枚举声明是否进事件日志：
   a) 不落盘，只在门禁期校验；
   b) 落盘（新增事件字段，需处理快照兼容）。
   → 选定 **a**：`ChildSpec` 新增可选的 `enum_item` 会随 `plan/node-expanded` 自然落盘，来源说明无审计需求，不改事件 schema。

4. 阈值是否暴露为插件 config：
   a) 不暴露，固定默认 8（与 `maxRetries` 同类，引擎级可覆盖）；
   b) 暴露 `enumerationThreshold`。
   → 选定 **a**：与现行「config 只暴露 `maxConcurrent`」一致，避免扩大配置面。

## 规划

任务拆分：

1. 门禁：`GateConfig.maxChildren` 改名 `enumerationThreshold`（默认 8），新增 `enumeration` 规则与 `checkDecomposition` 的第 4 个入参。
2. 类型：`ChildSpec` 增可选 `enumItem`；新增枚举声明类型。
3. 引擎：`engine.decompose` 透传枚举声明到门禁；`engine-types.ts` 的接口签名同步。
4. 工具面：`task_decompose` 参数新增 `enumeration`（`source` + `items`）与子任务 `enum_item`，解析非法时带反馈拒绝；描述同步。
5. 测试：`gate.test.ts` 改数量用例并新增枚举 5 例（缺声明 / 数目不符 / 重复 / 漏对应 / 合法）；`tools.test.ts` 增参数解析 2 例。
6. 关闭后回写 `README.md` 与 `docs/DESIGN.md` 的数量口径。

计划改动文件清单：

- `task-engine/docs/BACKLOG.md`（条目状态）
- `task-engine/docs/implementation/2026-11-04-child-count-enumeration.md`（本文件）
- `task-engine/src/gate.ts`（阈值 + 枚举规则 + 导出类型）
- `task-engine/src/types.ts`（`ChildSpec.enumItem`、枚举声明类型）
- `task-engine/src/engine.ts`（`decompose` 透传）
- `task-engine/src/engine-types.ts`（接口签名）
- `task-engine/src/tools.ts`（参数 schema / 解析 / 描述）
- `task-engine/tests/gate.test.ts`（数量口径改造 + 枚举用例）
- `task-engine/tests/tools.test.ts`（参数解析用例）
- `task-engine/README.md`、`task-engine/docs/DESIGN.md`（关闭后回写）

明确不做：

- 不改 `plan/node-expanded` 等事件 schema，不改快照格式。
- 不把 `enumerationThreshold` 暴露到插件 config。
- 不改 `maxRetries` / `maxConcurrent` 语义，不动 `STATUS.md`（由用户择时更新）。

## 实现记录

- 2026-11-04 `types.ts`：`ChildSpec.enumItem?` + 新增 `Enumeration`（`source` / `items`）。
- 2026-11-04 `gate.ts`：`GateConfig.maxChildren` → `enumerationThreshold`（默认 8）；`GateRule` 增 `enumeration`；`checkDecomposition` 增第 4 参 `enumeration`，超阈值时走新增的 `checkEnumeration`（来源非空 / 条目数相等 / 条目非空且不重复 / 每个子任务 `enumItem` 在清单内且不重复 / 无漏项）。
- 2026-11-04 `engine.ts`：`decompose(parentId, children, entail?, enumeration?)` 透传给机械门禁。
- 2026-11-04 `tools.ts`：`task_decompose` 参数新增 `enumeration`，`children` 支持 `enum_item`；`parseEnumeration` 与 `parseChildren` 解析，结构非法给参数反馈；工具描述补「超 8 条须声明枚举来源」。
- 2026-11-04 `tests/gate.test.ts`：数量用例改为「0 条拒绝 / 8 条以内不要求声明」，新增「gate 枚举来源」6 例（缺声明 / 数目不符 / 条目重复 / 缺 enum_item / enum_item 不在清单 / 漏项 / 合法通过）。
- 2026-11-04 `tests/tools.test.ts`：新增「task_decompose 枚举来源」3 例（无声明打回 / 结构非法反馈 / 合法挂树并落 `enumItem`）。

## 偏差

- 计划中的「子任务缺 enum_item」与「enum_item 不在清单」两例合并为一条用例（同一 `it` 内两次断言），用例数 5 变成 6（合并后另补了「清单条目没有对应子任务」单例）；覆盖点未减。

## 测试与证据

- `cd task-engine && node --experimental-transform-types --test 'tests/gate.test.ts'`：26 例全过（含新增 6 例）。
- `cd task-engine && node --experimental-transform-types --test 'tests/tools.test.ts'`：19 例全过（含新增 3 例）。
- `cd task-engine && pnpm run test`：180 例全过（48 suites，fail 0）。
- `cd task-engine && pnpm run check`：退出 0。
- 根 `pnpm run check`：退出 0；根 `pnpm run build`：退出 0。

## 收尾

- 回写：`task-engine/README.md`（机制段「分解双重门禁」补枚举来源；配置段默认值改 `enumerationThreshold=8` 并说明「阈值不是上限」）、`task-engine/docs/DESIGN.md`（§2 机械门禁补枚举口径与理由）。
- BACKLOG：条目已标完成并从「待办」清理，关闭注记写入「记录」。
- 本文件已移入 `task-engine/docs/archived/`。
- 未做人工确认：真机效果验证留给用户在另一台机器执行（`task_decompose` 传 9 条不带 `enumeration` 应被打回并提示枚举声明；带齐 `source` / `items` / `enum_item` 应挂树）。
- 临时文件：无（探针目录只用于既有 install.sh 任务，本轮未产生）。
- `STATUS.md` 未改（由用户择时更新）。
