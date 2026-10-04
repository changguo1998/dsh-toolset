# code-map 设计

## 1. 定位

DSH 进程内集成的**代码结构地图**：把「项目里有什么、谁引用了谁、改动会波及什么」变成模型与插件可直接消费的紧凑结构化数据。消费面见 `README.md`（`code_map` 工具 + `codeMap` 服务 + TS 导出）。

## 2. 架构取舍

**语法层为主，语义层按需，不建全量语义索引**：

| 层 | 载体 | 覆盖面 | 特性 |
| --- | --- | --- | --- |
| 结构层（recall） | ast-grep（复用 `ast-tools` 的 `outline`/`search`） | 全量、快、容忍语法错误 | 不启动语言服务器、不要求项目可编译 |
| 语义层（precision） | 宿主 `ctx.lsp`（dsh-lsp 查询缝） | 按需、准 | 仅对实际查询的符号付语义成本；服务未挂载时自动回落结构层 |

理由：全量语义索引（SCIP/Kythe/LSIF 级）构建成本与维护复杂度远超本插件需求；而「同名标识符候选 + 图上结构聚合」已足以支撑影响面初筛与结构总览。**语义层首项（`callers` 的 findReferences 精确裁决）已实现**（2026-09-29，BACKLOG #22）：宿主 `ctx.lsp` 可用时走精确路径、结果 `precision:"lsp"`，不可用/失败/超时回落同名候选（`precision:"structural"`）；符号级 `callees` / `resolve` 提升仍留作增量（选型调研记录见 `../../archive/CODEMAP-RESEARCH.md`）。

**LSP 缺省不可达（重要）**：官方 LSP 三件套（`lsp` / `lsp-stdio` / `tool-lsp`）**不随 dsh 分发**（`docs/host/HOST-PACKAGES.md` 的「官方源码有、随包分发没有」清单），标准 profile 缺省没有 `ctx.lsp`，故 `callers` 在缺省部署下恒定输出 `precision:"structural"`；`precision:"lsp"` 只在自行安装三件套（或经 `config.lsp` 注入提供器）时可达。文档与工具描述里的「LSP 可用时精确」是能力上限而非缺省行为。

## 3. 数据模型（进程内内存图，`src/types.ts` + `src/graph/graph.ts`）

```
CodeGraph
  fileNodes : Map<path, CodeMapFile{ path, language, symbols[] }>
  imp       : Map<from, Set<to>>   直接 import（仅仓库内、已解析的边）
  impBy     : Map<to,   Set<from>> 反向索引（支撑影响面查询）
```

- `CodeMapSymbol.id = <file>::<startLine>:<name>`：跨文件/同名/同起始行可区分；`kind` 取 ast-grep `astKind`，`startLine`/`endLine` 为 0-based，`exported` 取 `isExported`。
- **不存引用/调用边**：图只有文件节点与 `IMPORTS` 边。候选引用按查询惰性物化（`src/indexer/refs.ts`），故图规模与仓库文件数线性相关，不随同名标识符出现次数膨胀。
- 模块不是节点：模块 = 报告阶段对文件路径的聚合视图（相对 `root` 的首段目录，`root` 下直接文件归 `.`）。

## 4. 结构层管线（`src/indexer/scan.ts`）

1. **收集**：递归目录，按 `SOURCE_EXT` 扩展名白名单（ts/mts/cts/tsx/js/mjs/cjs/jsx/py/rs/go/java/rb/cs/kt/php/swift/c/h/cc/cpp/hpp）取文件，跳过固定噪音目录集合（`node_modules`/`.git`/`dist`/`tmp`/`archive`/`.ruff_cache`/`.pi-glla`/`coverage`/`.dsh`/`.vscode`）；不解析 `.gitignore`——代价是被忽略规则覆盖、却不在该集合内的目录仍会被扫描。
1. **符号表**：逐文件 `ast.outline({ path, items: "all" })`，展开顶层符号与成员（成员保留简单名，层级由 `kind` 表达），跳过 `isImport` 项；单文件抛错（语法错误/语言不支持）静默跳过，保证整仓扫描不中断。
1. **import 边**：从 outline 的 `isImport` 项取说明符，`resolveImport` 仅解析相对/绝对路径（补扩展名、目录 `index` 兜底），并要求结果落在 `root` 内；裸模块与 `node:` 内置记 `to=null`（计入 `unresolved`，不入图）。
1. **成本**：全量扫描在本仓库量级为秒级；每次 `refresh` 都是全量重扫，无 mtime 增量与文件监听。

## 5. 查询算法（`src/graph/query.ts` + `src/indexer/refs.ts`）

- `callers(symbol)`：**精确路径优先**——宿主 LSP 可用时按符号定义位置（`symbolPositionAt` 从定义行取 0-based `{line, character}`）发 `findReferences`（官方 `ctx.lsp` 缝，含声明，故仍过 `excludeDefinitionRange`），结果按文件+行排序、`precision:"lsp"`；LSP 缺失 / 定位失败 / 查询抛错或超时（5s）→ **结构层回落**：`ast.search({ pattern: symbol.name, strictness: "smart" })` 全仓同名标识符（排除定义区间），`precision:"structural"`。
- `callees(symbol)`：返回该符号所在文件的直接 import 目标（文件级），不做符号级解析。
- `impact(file)`：从目标文件出发沿 `impBy` 做 BFS 反向传递闭包（不含自身），再按 `moduleOf` 聚合出去重排序的模块列表。
- `cycles()`：文件 import 图上的 Tarjan SCC——**迭代实现**（显式帧栈）以避免大仓递归爆栈；只返回 `size>=2` 的强连通分量，故自环不算环。
- 符号定位 `resolveSymbol(name, file?)`：在文件表上线性查找首个同名符号，`file` 可限定文件；找不到时返回空结果而非报错。

## 6. 报告聚合（`src/report/builder.ts`）

在图上做一轮聚合，产出 `CodeMapReport`：文件/符号/import 计数、`unresolvedImportCount`、`languageCounts`、`kindCounts`（ast-grep `astKind` 归一为 class/interface/enum/function/variable/type/import/other 粗类）、模块统计与模块依赖边（文件 import 上卷到模块，去重、去自环）、文件级依赖环、`unimportedExportFiles`（有导出符号但无任何文件 import 它）。

形态参考 dependency-cruiser 的聚合报告：只给模块级环比与清单，不渲染大图——模型消费的是可 grep/可计数的结构化数据。

## 7. DSH 接入面（`src/index.ts`）

按 bundle 契约 `export { name, inject, provide, apply }`：`name = "code-map"`，`inject = ["tools"]`（cordis 硬依赖，缺失即整体等待），`provide = ["codeMap"]`（暴露 `{ getSummary, getBundle }`）。`apply()` 经 `ctx.get("lsp")` **可选**读取宿主 LSP 服务（受保护；缺省无该服务，见 §2），`config.lsp` 可注入替身（测试/嵌入）。`apply` 内建 bundle 并由模块级持有（`getCodeMapBundle()` / `getCodeMapSummary()`）；`tools` / `provide` 在结构面上取不到时**静默跳过**该项注册（单测直接传普通对象场景），只有 `register` 抛错才告警。`cordis.patch.yml` 声明 bundle 插入。

**降级链**：`createCodeMapBundle` 构造时尝试 `createAstToolsBundle()`，失败则返回 `degradedBundle`——所有操作返回空/`ready:false` 结果，绝不抛出，宿主侧表现为「插件在但地图为空」。

## 8. 约束与已知边界

- 候选边同名误连：`callers` 在宿主 LSP 可用时已消歧（`precision:"lsp"`）；LSP 不可用时仍为同名候选（`precision:"structural"`，需按名核对）。语法错误文件结构层仍可出符号，语义层查询由其 provider 决定（通常跳过）。
- 内存图随进程生命周期：无快照、无跨进程一致性承诺；`report`/`summary` 在首次 `index` 前返回 `undefined`（工具面带 `error`/`ready:false`），`cycles` 也不触发索引、未索引即空数组。
- `refresh` 为全量重建：大仓重复调用成本线性。
- 明确不做：SCIP/Kythe/LSIF 全量语义索引格式；文件系统监听守护；跨文件重命名；远程仓库 clone 前索引；`callees` 符号级提升与 `resolve`/`hover`（LSP 缝其余操作）；provider 实现（自带语言服务器）；TUI 只读桥（`/map`、`/callers`）。
