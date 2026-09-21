# code-map 设计与实现

> 实现范围：`docs/DEVELOPMENT-BACKLOG.md` #21（项目/模块报告、影响面）与 #22（代码索引与调用图 callers/graph）。
> 设计对照：`docs/AGENT-ARCHITECTURE-ANALOGY.md` §1 功能域⑤「代码与文件」；基线差距见 `docs/PI-DSH-FEATURE-COMPARISON.md` §3.2/§3.4（dsh 0.1.5-rc.2 无代码索引，lsp 约等于按需符号查询）。
> 调研依据：线上 5 流派做法与三决策维度，见 `docs/CODEMAP-RESEARCH.md`（随本设计同期起草）。
> 命名决策（2026-09-21）：由计划名 `code-intel` 更名 `code-map`——intel 语义泛（情报/智力，撞厂商名），map 贴合「项目结构地图（概览 + 符号/调用连线）」的心智模型；插件规划按能力域聚合（backlog 插件规划节「命名按功能自定」）。
> 消费方决策（2026-09-21）：**首版以模型（`ctx_code_map` 工具）与其他插件（TS API）为主**；TUI 只读桥（`/map` `/callers`）后置，不进首版范围。
> 语言：本文档中文；代码英文标识符。

## 1. 定位

DSH 进程内集成的**代码结构地图**插件（结构索引 + 查询 → 报告），覆盖 backlog #21 与 #22：

- **结构索引**（#22 底座）：全项目符号定义表 + 文件间 import 关系 + 引用/调用边，构成可查询的内存图；
- **调用图**（#22）：`callers` / `callees` / `cycles`（强连通分量）查询；
- **项目/模块报告**（#21）：结构总览、模块依赖、影响面（反向引用聚合到目录）。

**轻量混合架构**：两层合流，不引入 SCIP/Kythe 级全量语义索引——

| 层 | 载体 | 覆盖面 | 特性 |
|----|------|--------|------|
| 结构层（recall） | ast-grep（复用 `ast-tools` outline/search） | 全量、快、容忍语法错误 | 不启动语言服务器、不要求项目可编译 |
| 语义层（precision） | tool-lsp（宿主）findReferences/goToDefinition | 按需、准 | 仅对用户实际查询的符号花语义成本 |

复用底座：`ast-tools`（ast-grep outline 已含顶层符号/成员/范围/签名/astKind/import-export 标记）、宿主 `tool-lsp`、`tool-fs`/`tool-fs-search`（ripgrep 兜底）。

## 2. 设计依据（调研摘要）

线上同类项目归 5 流派（详见 `docs/CODEMAP-RESEARCH.md`）：

| 流派 | 代表 | 做法 | 对本插件的取舍 |
|------|------|------|----------------|
| A. 给 LLM 的仓库地图 | [Aider repo map](https://aider.chat/2023/10/22/repomap.html)、[RepoMapper](https://github.com/pdavis68/RepoMapper) | tree-sitter 符号 + 引用图 PageRank + token 预算二分拟合 | #21 报告与模型的符号上下文可借鉴「排序 + 拟合」 |
| B. 纯 LSP 不建索引 | [Serena](https://github.com/oraios/serena)（GitHub gh-aw 已用） | LSP server 按需符号导航，始终新鲜、零索引 | 语义层按需确认范式（成本最低） |
| C. 工业级全量索引 | [Sourcegraph SCIP](https://sourcegraph.com/docs/admin/how-to/lsif-scip-migration.md)、[OpenGrok](http://demo.opengrok.org/)、[Kythe](https://kythe.io/docs/kythe-compilation-database.html) | 离线构建跨语言索引（LSIF/SCIP/Lucene/facts-edges） | 对本插件过重，**明确不做** |
| D. 调用图/依赖图专用 | [blarify](https://pypi.org/project/blarify/)、[graphscout](https://pypi.org/project/graphscout/)、[code2flow](https://github.com/scottrogowski/code2flow)、[dependency-cruiser](https://www.npmjs.com/package/dependency-cruiser-json-viewer) | LSP 或静态分析出调用图/依赖图 + 报告 | #22 结构与报告聚合形态参考 |
| E. 语义级精确分析 | GitHub [CodeQL](https://codeql.github.com/) | 编译语义（数据流/调用图）上跑 QL | 精度最高、构建最重，**首版不做** |

三决策维度（数据源 / 索引策略 / 排序拟合）取舍结论：
数据源 = **ast-grep（语法层）为主 + LSP 按需补语义**；索引策略 = **会话内懒构建 + mtime 增量，不做持久守护**；排序 = **引用计数 + 可选 PageRank 拟合 token 预算**（Aider 范式，先简单引用计数起步）。

## 3. 数据模型（内存图）

```
Node:  File(path, lang) │ Symbol(id, name, kind, file, range, signature, astKind, lang, exported)
       │ Module(目录聚合，按需虚节点)
Edge:  DEF(file→symbol  contain) · IMPORTS(file→file)
       · REFS(usage→symbol，候选|precise) · CALLS(symbol→symbol，候选|precise)
```

- 结构层产出的引用/调用边初始为**候选态**（`precise:false`）：同名 + 作用域提示的语法级近似；
- 语义层（tool-lsp）确认后**提升为 `precise:true`** 并缓存——只对用户查过的符号付语义成本；
- 生命周期：进程内内存图；可选 JSON 快照（仿 task-engine 周期快照）免重启重扫。

## 4. 结构层管线（`src/indexer/`，recall）

1. `scan`：glob 源文件（语言白名单按 `ast-tools/src/langs.ts` 归一，尊重 `.gitignore`）→ 逐文件 `ast-tools outlineFile`（含 imports）→ 写 DEF 边 + Symbol 节点 + IMPORTS 边；
1. `refs`：对需要查询的符号按「同名标识符」做候选引用/调用边（首版先只对查询目标物化，不做全量按名扫——省一次全仓遍历）；
1. 成本：本仓库量级全量扫描秒级；增量按文件 **mtime 懒失效**（查询时发现过期才重扫单文件），不做文件监听守护。

## 5. 语义层（`src/lsp/`，precision）

`resolver`：结构层定位符号 → 批量调宿主 `tool-lsp` `findReferences`/`goToDefinition` → 精确引用集写回 REFS/CALLS（precise）并缓存。

两条查询路径按需求选策略：

| 路径 | 成本 | 用途 |
|------|------|------|
| 快速（默认） | 仅结构索引 | 报告、影响面初筛、候选列表 |
| 精确 | 结构候选 → LSP 确认 | `callers` 最终答案、消歧、改动影响核验 |

## 6. 查询面（消费方 = 模型 + 其他插件）

`ctx_code_map`（服务注册到宿主 service 域，仿 `ctx_knowledge`）：

- `index(opts)` / `refresh(opts)`：全量/增量刷新结构索引；
- `callers(symbol, {depth?, precise?})`：调用者列表/子图（#22）；
- `callees(symbol, {depth?})`：被调用者；
- `impact(fileOrSymbol)`：影响面 = 反向引用闭包，聚合到模块（#21 核心）；
- `cycles()`：依赖环（强连通分量）；
- `report({scope?})`：项目/模块报告（见 §7）；
- `resolve(symbol)`：语义层精确确认，附 precise 结果。

输出形态要求：**token 感知的紧凑结构化数据**（模型直接消费）；TS 导出等价 API 供其他插件（如 code-review 模板 #32、task-engine 语义面）import。

## 7. 报告（`src/report/`，#21）

`report()` 聚合输出：文件/符号计数、导入拓扑、模块依赖、影响面清单、孤立符号、依赖环、未被引用的导出等。形态参考 dependency-cruiser 的聚合报告（模块级环比、影响面按目录聚合），不渲染大图。

## 8. 模块划分与文件

```
code-map/
  cordis.patch.yml            # insert: {id: code-map, name: '@dsh-toolset/code-map'}
  package.json                # dsh.bundle.patch（仿 ast-tools）
  tsconfig.json
  src/
    index.ts                  # bundle 装配 + ctx_code_map 注册（仿 knowledge-base）+ TS 导出面
    types.ts                  # Symbol/Edge/Graph/Report 类型
    indexer/{scan,imports,refs}.ts
    graph/{graph,query}.ts
    lsp/resolver.ts
    report/builder.ts
  tests/                      # indexer/graph/resolver/report
  README.md  DESIGN.md  IMPLEMENTATION.md
```

## 9. DSH 接入面（`src/index.ts`）

按 bundle 契约 `export { name, apply }`（仿 knowledge-base）：`createCodeMapBundle` 工厂（索引初始化 → 挂图 → 暴露服务，dispose）；`apply` 为宿主挂载入口；模块级持有 + `getCodeMapBundle()` 同步访问 / `whenCodeMapReady()` 等就绪避免竞态；`cordis.patch.yml` 声明 bundle 插入。

## 10. 明确不做（防膨胀）

- SCIP/Kythe/LSIF 全量语义索引格式（流派 C）；
- 文件系统监听守护（增量走 mtime 懒失效）；
- 跨文件重命名（需语义级 rename 支持，超出 #21-#22）；
- 远程仓库 clone 前索引（属 web-ext #25）；
- 动态语言/宏元编程的精确调用图（语法层近似，文档声明）；
- TUI 只读桥（`/map` `/callers`）——消费方决策后置，不进首版。

## 11. 约束与已知边界

- 候选边同名误连 → 精确路径经 LSP 消歧（候选/精确双态是设计的一部分）；
- 语法错误文件结构层仍可出符号，语义层跳过（容错有上限）；
- 内存图随会话生命周期；快照可选、进程退出即丢（未做持久队列前不承诺跨进程一致性）；
- 首版排序用引用计数起步，PageRank/token 拟合（Aider 范式）作为后续增量（#21 报告质量增强）。
