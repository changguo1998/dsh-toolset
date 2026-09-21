# @dsh-toolset/code-map

DSH（DeepSeek Harness）进程内插件：代码结构地图——基于 ast-grep 的全量结构索引、候选引用查询与项目/模块报告。

## 能力

注册 `code_map` 工具（单工具 + `action` 分派），并暴露只读服务 `codeMap`（`provide('codeMap')`，供宿主命令/插件读取）。

| action | 参数 | 作用 |
| --- | --- | --- |
| `index` | `root?` | 建立结构索引（符号表 + import 图）；已建则不重复扫描，直接返回概要 |
| `refresh` | `root?` | 全量重建索引 |
| `callers` | `symbol`, `file?` | 符号的同名候选引用（排除定义行本身） |
| `callees` | `symbol`, `file?` | 符号所在文件的直接 import 目标（文件级） |
| `impact` | `file`（必填） | 目标文件的影响面：反向 import 传递闭包，聚合到模块 |
| `cycles` | — | 文件级依赖环（Tarjan 强连通分量，`size>=2`） |
| `report` | — | 项目/模块报告 |
| `summary` | — | 索引就绪状态（`ready`/`root`/`files`/`symbols`） |

- 索引**惰性**：首次查询时构建，不做启动期全量扫描；进程内内存图，随会话生命周期。
- `report` 输出：文件/符号/import 计数、未解析 import 数、语言与符号种类计数、模块统计（`fileCount`/`symbolCount`/`imports`/`importedBy`）、文件级依赖环、有导出但无人 import 的文件清单。
- 包同时导出 TS 类型与工厂：`createCodeMapBundle`、`getCodeMapBundle`、`getCodeMapSummary`，供其他插件 import。

## 配置

`createCodeMapBundle(config)` 的两个可选字段（bundle 挂载路径下由 `apply` 使用缺省值）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `root` | `process.cwd()` | 仓库根；工具参数 `root` 可覆盖 |
| `ast` | 缺省自建 `createAstToolsBundle()` | 注入 ast-tools bundle（测试/复用）；ast-grep 不可用时整体降级 |

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

- **候选语义**：`callers` 是同名标识符匹配（ast-grep `search`，`strictness: "smart"`），无类型解析——同名不同实体、动态语言（Python 元类/JS 宏）会失真；符号级精确 `callees`/`resolve`（LSP 语义层）尚未提供。
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

14 例（收集/扫描/import 解析、图与查询、报告、bundle 装配与 config 透传）。依赖本机 ast-grep 二进制：缺失时相关用例注册为 skip，套件仍全绿。

设计决策见 `DESIGN.md`（选型调研记录见 `archive/CODEMAP-RESEARCH.md`）。
