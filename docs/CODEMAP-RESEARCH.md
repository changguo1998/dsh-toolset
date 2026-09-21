# code-map 前期调研：同类代码地图/代码智能项目

> 用途：为 `code-map/DESIGN.md`（backlog #21-#22 → 结构索引/调用图/项目报告）提供设计依据。
> 时间：2026-09-21。外部链接为公开资料，仅作参考。
> 结论速览：5 流派 + 3 决策维度；本项目采用「结构层（ast-grep）+ 语义层（tool-lsp）按需」的轻量混合，不做全量语义索引。

## 1. 五个流派

### A. 给 LLM 的「仓库地图」（与 #21 最贴近）

- **[Aider repo map](https://aider.chat/2023/10/22/repomap.html)**：tree-sitter 解析 → 提取符号定义与引用 → 文件引用图上跑 PageRank → 按 token 预算（默认 1k）二分拟合，只把最重要符号签名塞进上下文。最初用 universal-ctags，后换 tree-sitter（多语言、免外部安装、带完整签名）。在 SWE-bench Lite 达成 26.3% 定位率（全栈成绩，非隔离消融）。
- **[Repository Map Pattern](https://github.com/agentpatterns-ai/website/blob/main/context-engineering/repository-map-pattern.md)**（agentpatterns 模式库）：把该方案沉淀为 parse → rank → fit 三层；并列出反模式：频繁变更的仓库索引易过期、动态语言元编程（Rails `method_missing`、Python 元类、宏-heavy Rust）符号失真、\<20 文件仓库无收益、超大 token 预算仓库无压缩必要。
- 现成 MCP 封装：[RepoMapper](https://github.com/pdavis68/RepoMapper)、[mcp-server-tree-sitter](https://github.com/wrale/mcp-server-tree-sitter)。

### B. 纯 LSP、不建索引（与 dsh 现有 tool-lsp 同路线）

- **[Serena](https://github.com/oraios/serena)**：LSP-based MCP server，符号级导航（definitions/references/enclosing），不建持久索引、按需查询、始终新鲜。GitHub 官方 [gh-aw](https://github.com/github/gh-aw/blob/main/.github/aw/serena-tool.md) 已纳入 agent 工作流。
- 代价：每次查询需启动/复用语言服务器，无跨文件图，海量查询时往返成本高。

### C. 工业级全量索引（给人搜索/IDE）

- **[Sourcegraph LSIF→SCIP](https://sourcegraph.com/docs/admin/how-to/lsif-scip-migration.md)**：跨语言代码索引格式，离线构建，SCIP 压缩率/构建速度优于 LSIF。
- **[OpenGrok](http://demo.opengrok.org/)**：universal-ctags + Lucene，Web 全文/符号搜索。
- **[Kythe](https://kythe.io/docs/kythe-compilation-database.html)**（Google）：facts/edges 图式索引，可答 callers/cross-references，需编译数据库接入。

### D. 调用图/依赖图专用（与 #22 最贴近）

- **[blarify](https://pypi.org/project/blarify/)**、**[graphscout](https://pypi.org/project/graphscout/)**：基于 LSP 构建调用图。
- **[code2flow](https://github.com/scottrogowski/code2flow)**：纯源码静态分析出调用图（无需运行）。
- **[dependency-cruiser](https://www.npmjs.com/package/dependency-cruiser-json-viewer)**：模块依赖图 + 报告（循环、孤儿、失配规则违规），JS 生态的「报告形态」参考。
- **[code2llm](https://pypi.org/project/code2llm/)**：CFG/DFG/调用图 + 面向 LLM 的 TOON 格式，较新的「图给 LLM 用」样本。

### E. 语义级精确分析

- **[CodeQL](https://codeql.github.com/)**：QL 查询语言在编译语义（数据流/调用图）上做分析，面向安全审计，精度最高、构建最重。SciTools Understand 等商业工具同属此类。

## 2. 三个关键决策维度

| 维度 | 选项 | 代表 |
|------|------|------|
| 数据源 | tree-sitter/ast-grep（快、纯语法、多语言、动态语言近似）vs LSP（语义准、按需、要起 server）vs 编译产物（最准、最重） | A/D vs B vs C/E |
| 索引策略 | 全量持久索引 vs 会话内重算/懒构建 vs 完全不索引（on-demand 工具链） | C vs A/B vs Claude Code |
| 排序与拟合 | PageRank/引用频率 + token 预算二分 vs 关键词（BM25/trigram）vs 模块聚合 | A vs C(OpenGrok) vs D |

## 3. 对本项目（code-map）的取舍

- 数据源：**ast-grep（语法层，复用 ast-tools）为主 + 宿主 tool-lsp 按需补语义**——避免流派 C/E 的构建/部署成本，也避免流派 B 的纯按需无图。
- 索引策略：**会话内懒构建 + mtime 增量**，不做文件守护、不做 SCIP 级格式。
- 排序：首版引用计数起步，PageRank/token 拟合（Aider 范式）为后续增量。
- 反模式规避：动态语言调用图声明为语法级近似；小仓库（\<20 文件）收益有限（文档说明即可，不特判）。
- 明确不做：SCIP/Kythe/LSIF、跨文件重命名、远程 clone 前索引、TUI 大图渲染（报告以聚合统计为主）。
