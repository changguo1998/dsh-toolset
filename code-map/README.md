# @dsh-toolset/code-map

DSH（DeepSeek Harness）进程内集成插件：**代码结构地图**。覆盖 `docs/DEVELOPMENT-BACKLOG.md` #21（项目/模块报告、影响面）与 #22（代码索引与调用图 callers 候选）。

- **结构索引**：基于 `ast-tools`（ast-grep）全量扫描，产出符号表 + 文件 import 图；
- **调用图（候选）**：`callers` 走同名标识符候选引用（ast-grep 搜索，惰性物化）；符号级精确 `callees`/`resolve`（LSP 语义层）为增量，首版不含；
- **项目/模块报告**：文件/符号统计、模块依赖、依赖环（SCC）、影响面（反向 import 闭包聚合到目录）、未引用的导出文件。

设计见 `DESIGN.md`；调研见 `docs/CODEMAP-RESEARCH.md`。

## 命令

```sh
npm run check   # 类型检查（tsc --noEmit，strict）
npm run build   # 编译到 dist/
npm run test    # 运行 tests/*.test.ts（node --test；需本机 ast-grep，缺失时相关用例 skip）
```

## 结构

- `src/types.ts` — 核心类型（Symbol/File/Import/Callers/Impact/Report）
- `src/indexer/scan.ts` — 全量扫描（文件收集 → ast-grep outline → 符号表 + import 边）
- `src/indexer/refs.ts` — 候选引用（同名标识符 ast-grep 搜索，惰性）
- `src/graph/graph.ts` — 内存图（文件节点 + IMPORTS 双向索引 + Tarjan SCC）
- `src/graph/query.ts` — callers/callees(文件级)/impact/cycles 查询
- `src/report/builder.ts` — 项目/模块报告生成
- `src/index.ts` — DSH bundle 接入面：`code_map` 工具 + `provide('codeMap')` + TS 导出面

## DSH 接入

- `inject: ["tools"]`：注册 `code_map` 工具（action: index/status/report/callers/impact/cycles）；
- `provide: ["codeMap"]`：只读查询面，宿主命令/插件经 `ctx.get('codeMap')` 访问；
- bundle `code-map`，包 `@dsh-toolset/code-map`（`cordis.patch.yml` 声明插入）。

profile 挂载示例（`~/.dsh/profiles/<p>`）：

```jsonc
"dependencies": { "@dsh-toolset/code-map": "link:<本包路径>", "@dsh-toolset/ast-tools": "link:<ast-tools 路径>" },
"dsh": { "profile": { "bundles": [/* ... */, "@dsh-toolset/code-map"] } }
```

## 已知边界

- 引用为**候选**语义（同名 + 无类型解析），动态语言（Python 元类/JS 宏等）会失真；精确确认走 LSP 语义层（增量）。
- `callees` 首版为**文件级**（符号所在文件的 import 目标）；符号级 callees/resolve 后置。
- 索引随会话生命周期（内存图）；不做文件系统监听（启动/`index` 显式刷新）。
