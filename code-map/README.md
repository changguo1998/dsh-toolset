# @dsh-toolset/code-map

DSH（DeepSeek Harness）进程内插件：代码结构地图——基于 ast-grep 的全量结构索引、候选引用查询与项目/模块报告。

## 能力

注册 `code_map` 工具（单工具 + `action` 分派），并暴露只读服务 `codeMap`（`provide('codeMap')` 给出 `{ getSummary, getBundle }`，供宿主命令/插件读取）。

| action | 参数 | 作用 |
| --- | --- | --- |
| `index` | `root?` | 建立结构索引（符号表 + import 图）；已建则不重复扫描，直接返回概要（概要路径不重扫，其 `imports` 恒为 0） |
| `refresh` | `root?` | 全量重建索引 |
| `callers` | `symbol`, `file?` | 符号引用（排除定义行本身）：宿主 LSP 可用时 `findReferences` 精确结果（`precision:"lsp"`），否则同名候选（`precision:"structural"`） |
| `callees` | `symbol`, `file?` | 符号所在文件的直接 import 目标（文件级） |
| `impact` | `file`（必填） | 目标文件的影响面：反向 import 传递闭包，聚合到模块 |
| `cycles` | — | 文件级依赖环（Tarjan 强连通分量，`size>=2`）；不触发索引，未 `index` 时返回空数组 |
| `report` | — | 项目/模块报告（未索引时工具面返回 `error`） |
| `summary` | — | 索引就绪状态（`ready`/`root`/`files`/`symbols`；未索引时 `ready:false`） |

- 索引**惰性**：首次查询时构建，不做启动期全量扫描；进程内内存图，随会话生命周期。
- `report` 输出：文件/符号/import 计数、未解析 import 数、语言与符号种类计数、模块统计（`fileCount`/`symbolCount`/`imports`/`importedBy`）、文件级依赖环、有导出但无人 import 的文件清单。
- 包同时导出 TS 类型与工厂：`createCodeMapBundle`、`getCodeMapBundle`、`getCodeMapSummary`，供其他插件 import。

## 配置

`createCodeMapBundle(config)` 的三个可选字段（bundle 挂载路径下由 `apply` 使用缺省值）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `root` | `process.cwd()` | 仓库根；工具参数 `root` 可覆盖 |
| `ast` | 缺省自建 `createAstToolsBundle()` | 注入 ast-tools bundle（测试/复用）；ast-grep 不可用时整体降级 |
| `lsp` | 缺省由 `apply` 从宿主 `ctx.lsp` 解析 | 注入 LSP 引用提供器（测试/嵌入）；宿主 LSP 缺省不可达（见「边界与限制」），故缺省口径为结构层 |

依赖：本包以 `link:../ast-tools` 引用 `@dsh-toolset/ast-tools`（`link:` 为 pnpm 协议，`npm install` 不支持——用 pnpm 或仓库 `scripts/install.sh` 安装；见该脚本注释）。profile 挂载需同时挂 `ast-tools` 与本包。

## 使用示例

工具调用（模型侧）：

```jsonc
{ "action": "index", "root": "/repo" }
{ "action": "callers", "symbol": "scanProject", "file": "/repo/code-map/src/indexer/scan.ts" }
{ "action": "impact", "file": "/repo/code-map/src/indexer/scan.ts" }
```

TS API（其他插件侧）：

```ts
import { createCodeMapBundle } from "@dsh-toolset/code-map";

const map = createCodeMapBundle({ root: "/repo" });
await map.index();
const { refs, files } = await map.callers("scanProject", {
  file: "/repo/code-map/src/indexer/scan.ts",
});
```

profile 挂载（`~/.dsh/profiles/<p>`）：

```jsonc
"dependencies": { "@dsh-toolset/code-map": "link:<本包路径>", "@dsh-toolset/ast-tools": "link:<ast-tools 路径>" },
"dsh": { "profile": { "bundles": [/* ... */, "@dsh-toolset/code-map"] } }
```

## 边界与限制

- **引用精度**：`callers` 默认走结构层同名标识符匹配（ast-grep `search`，`strictness: "smart"`，`precision:"structural"`）——同名不同实体、动态语言（Python 元类/JS 宏）会失真；宿主挂载 LSP（`ctx.lsp`，官方 `lsp`/`lsp-stdio`/`tool-lsp` 三件套）时改走 `findReferences` 精确裁决（`precision:"lsp"`，失败/超时自动回落）。**该三件套不随 dsh 分发**（`docs/host/HOST-PACKAGES.md` 列为「官方源码有、随包分发没有」），缺省 `ctx.get("lsp")` 解析不到 → 标准 profile 下实际恒定 `precision:"structural"`；要 LSP 精度须自行安装三件套。符号级 `callees` 与 `resolve` 仍为增量。
- **文件级粒度**：`callees` 返回文件而非符号；`cycles` 建在文件 import 图上。
- **无持久化**：无索引快照、无 mtime 增量（`refresh` 即全量重扫）、无文件系统监听；进程退出即丢。
- **扫描范围**：按扩展名白名单收集源码，跳过固定噪音目录集合（不解析 `.gitignore`）；import 只解析相对/绝对路径说明符，裸模块与 `node:` 内置记为外部（`unresolved`）。细节见 `DESIGN.md` §4。
- **降级**：ast-grep 不可用时返回降级 bundle——`index` 返回 `ready:false` 与错误文本，其余查询返回空结果，不抛错。
- 单文件 outline 失败（语法错误/语言不支持）静默跳过该文件，不中断整仓扫描。

## 测试

```sh
npm run check   # 类型检查（tsc -p tsconfig.json --noEmit，strict）
npm run build   # tsc -p tsconfig.json → dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'
```

23 例（收集/扫描/import 解析、图与查询、报告、bundle 装配与 config 透传）。部分用例依赖本机 ast-grep 二进制：缺失时注册为 skip，套件仍全绿。

## 目录结构

```
src/
  index.ts           # 插件入口：bundle 契约（name / inject / provide / apply）、code_map 工具、provide 面、降级 bundle
  types.ts           # 核心类型（符号 / 文件 / import / 报告 / 服务面）
  indexer/scan.ts    # 结构层：文件收集 + ast-grep outline → 符号表与 import 边
  indexer/refs.ts    # 候选引用物化（同名标识符搜索）与定义区间排除
  graph/graph.ts     # 内存图：文件节点 + IMPORTS 双向索引 + Tarjan SCC（迭代实现）
  graph/query.ts     # 图上查询：callers / callees / impact / 模块聚合
  semantic/lsp.ts    # LSP 语义层缝（可选服务；三件套不随 dsh 分发，缺省不可达）
  semantic/locate.ts # 定义行光标定位（LSP 查询入参）
  report/builder.ts  # 项目/模块报告聚合
index.ts             # 包入口：re-export src/index
docs/DESIGN.md       # 架构取舍与边界
tests/               # node:test 单测
```

设计决策见 `DESIGN.md`（选型调研记录见 `../archive/CODEMAP-RESEARCH.md`）；宿主面事实见 `docs/host/HOST-PACKAGES.md` 与 `docs/host/DSH-CTX-API.md`。
