# ref 边的可见性与影响面口径（接取条目：`md-map/docs/BACKLOG.md`「ref 边的可见性与影响面口径」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

三个子项（条目原文）：① 未命中的行内代码路径 token 完全不可见 → `report` 增「未解析 token：N（仅计数、不进 broken）」作漂移探针；② ref 计入 backlinks 稀释 impact 语义 → `callers` / `impact` 增可选 kind 过滤（或分离计数）；③ `summary()` 未暴露 `refEdges`（与 `report` 不对称）→ 补齐。

## 调研

- ① 现状：`scanInlineRefs`（`src/links.ts:210`）只取路径形 token；ref 分类在 `classify`（`src/indexer.ts:251-266`）——**0 命中时 `return undefined`**（`:259`，不产边、不计断链、无计数）；索引只累计 `refEdges`（`:204,216`）。要计数：第一遍 ref 循环（`:168-176`）统计 `refEdge === undefined` 的次数。
- ② 现状：ref 边计入 `doc.backlinks`（第二遍 `:216-217` 走 `edges += 1` 并计 backlinks）与 `impact` 闭包（`query.ts:76` 调 `callers` 无过滤）→ 实测 `callers(docs/BACKLOG.md)=146` 全为 ref、`impact` 覆盖 204 篇里的 154 篇。过滤落点：`callers`（`query.ts:20`）/ `impact`（`:62`）选项 + `service.ts` 签名 + `tools.ts` 参数 + `render.ts` 标注。
- ③ 现状：`summary()`（`query.ts:131-153`）返回 docs/anchors/edges/broken/truncated/builtAt/elapsedMs，无 `refEdges`（`report` 有，`types.ts:133`）。
- 契约：工具面 `md_map` 的 action 参数表（`tools.ts:66-94`）；`renderSummary` 文案被 `tests/tool.test.ts:125` 断言（改动需同步）。

## 决策（待审阅）

1. **① 计数**：`MdMapIndex` / `MdMapReport` 增 `refUnresolved`（ref token 0 命中索引的条数；仅计数、不进 broken；被 exclude / 截断挡住的引用也算「未命中索引」）。`renderReport` 增一行：`未解析的行内代码路径 token：N（仅计数、不进断链；文档改名 / 写错路径时升高）`。
1. **② 过滤**：`callers` / `impact` 增可选 `kind?: MdEdgeKind[]`（allowlist，缺省全部；`kind:["internal","wiki"]` 即可排除 ref 噪声）；`impact` 的闭包逐层使用过滤后的边；service / tool 面透传，工具参数 `kind`（enum 数组，未知值报错）；渲染头行标注过滤（如 `（kind 过滤：internal/wiki）`）。**默认语义不变**（ref 仍计入内部边 / backlinks / impact）。
1. **③ summary**：增 `refEdges`，渲染为 `… / X 条内部边（含 ref Y） / …`（既有断言与 README 同步更新）。
1. 不做：不改 ref 扫描规则与默认口径；不做「backlinks 分离计数」（用 kind 过滤替代）；不动 `index` / `refresh` 的渲染（未解析计数只在 report 露出）。

## 规划

- 计划改动文件清单（**只改这些**）：`md-map/docs/BACKLOG.md`（状态）、本追踪文档、`md-map/src/{indexer,types,query,service,tools,render}.ts`、`md-map/tests/{refs,query,tool}.test.ts`、`md-map/README.md`。
- 验证：`md-map` 包 `check` / `build` / `test`；撤修复必红（撤计数 → `refUnresolved` 断言红；撤过滤 → kind 断言红）；真仓量级实测（对本仓跑一次 index，记录 `refUnresolved`）；根 `npm run check`。
- 明确不做：不动其它包；不顺手改相邻代码。

## 实现记录（2026-10-04）

- 子代理只读审阅（决策后、实现前）：通过；修订——① 口径实测：本仓 ref 未命中里约 87% 是「非 `.md` 的代码 token / 示例」（行级 4821，其中 `.md` 结尾 507）→ 计数保持行级 `refUnresolved`，另加 `.md` 子计数 `refUnresolvedMd`（report 同显两数）；② 工具层 `kind` 必须**手写校验**（`parameters` 是 `additionalProperties:true`，裸串会被 `str()` 静默忽略成「不过滤」，属最坏失败模式）；③ 渲染标注从 **value** 回显取 kind（不读 render 第一参，守「render 只由 value 决定」的既有哨兵用例）；④ summary 不插字进既有行、**另起一行**（既有精确断言不破，鉴别力放 refs 用例）；⑤ 工具 enum 只收 `internal/wiki/file/ref`（`external`/`broken` 无 `to`，永不出现在入边）。
- 代码：`types.ts`（`refUnresolved` / `refUnresolvedMd` + ref 口径注释修正）、`indexer.ts`（0 命中计数）、`query.ts`（kind 过滤 + report / summary 字段）、`service.ts`（签名）、`tools.ts`（参数 + 校验 + 回显 + 描述）、`render.ts`（过滤标注 + report / summary 行）。
- 未做（记录为观察）：`backlinks` 分离计数（用 kind 过滤替代）；ref token 的解析层缺口（`#anchor` 不拆 / 目录形态无 file 兜底 / 跨模块裸名 `.md`）另立条目。
- 附带修正：README 的 index 输出示例声称「（其中 1402 条为 ref）」——`renderIndex` 从不渲染该括号（错误文案，删除）；`types.ts` / README 的「多解跳过」与实现（源目录形态优先，已固化在 `tests/refs.test.ts`）矛盾——一并改正；README 示例行末的 `））` 笔误删除。

## 测试与证据

- `md-map` 包 `check` / `build` / `test`：45 pass / 0 fail（新增 4 条：未解析计数与渲染、kind 查询过滤、exclude 口径、工具面 kind 端到端；另扩展 report / summary 断言与参数校验用例）。
- 反向验证（撤修复必红）：① 撤 0 命中计数 → 2 条红；② 撤 kind 过滤 → 2 条红；恢复后复绿。
- 真仓量级实测（最终代码，root = 本仓）：`{docs:244, refEdges:1663, refUnresolved:4821, refUnresolvedMd:507, broken:2}`；`callers(docs/BACKLOG.md)` 默认 249 / `kind:["internal"]` 0；`impact(docs/BACKLOG.md)` 默认 195 / internal 0 —— 即「文档链接」语义下 BACKLOG.md 无入边，稀释现象由 kind 过滤显式化。

## 收尾

- 回写：`md-map/README.md`（action 表 kind / 未解析计数、边分类 ref 口径、库面签名、示例、错误快照行、测试计数 45）。
- 新发现问题另立条目：`md-map/docs/BACKLOG.md`「ref token 解析层缺口（`#anchor` / 目录形态 / 跨模块裸名）」。
- 观察项（未立项）：README「跨类型引用不做」引用的 `docs/BACKLOG.md` #1 是软引用（编号随整理重编，易漂）。
- 本文件移入 `md-map/docs/archived/`；`md-map/docs/BACKLOG.md` 清理所接条目（仅留未完成项）。
- 临时产物：无（探测为一次性 `node -e`，未落盘）。
