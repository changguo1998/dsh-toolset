# @dsh-toolset/md-map

DSH（DeepSeek Harness）进程内插件：**Markdown 项目级结构与引用分析**（对象是文档，对标 `code-map`）。索引项目内 `**/*.md` 的标题锚点、文档间链接、wiki 链接、对代码 / 文件的引用与被引计数，提供 `callers` / `impact` / `orphans` / `report` / `summary` 查询；只读。

单文件结构解析**复用 `@dsh-toolset/md-logic`**（本包依赖它，不重复实现 Markdown 解析）；三者分工：**代码结构 → `code_map`；单文件 Markdown 结构 → `md_logic`；项目级文档关系 / 影响面 / 断链 → `md_map`**。

## 模型侧工具

`inject: ["tools"]`，注册一个工具；`provide: ["mdMap"]` 暴露服务面。

| action | 说明 |
| --- | --- |
| `index` / `refresh` | 建立 / 刷新索引（全量扫描；默认 root = 会话 cwd，可用 `root` 指定；跳过 `node_modules` / `.git` / `dist` / `.pi-glla` / `tmp`；`maxFiles` 缺省 2000，超出截断并标记） |
| `callers` | 谁引用了该文档或该锚点：`path`（相对 root 的路径，也支持唯一后缀 / 文件名）+ 可选 `anchor`（GitHub 风格 slug）+ 可选 `kind`（边种类数组，取值 `internal` / `wiki` / `file` / `ref` 四值——`external` / `broken` 无 `to`、`file` 的 `to` 是索引外路径，三者都不会成为入边；如 `["internal","wiki"]` 排除 ref 噪声。ref 边可带锚点——`` `x.md#a` `` 会拆出锚点，锚点不存在计入断链） |
| `impact` | 改这份文档会波及哪些文档（反向引用闭包，`depth` 缺省 2，可选 `kind` **逐层**过滤，按层返回，不含起点） |
| `orphans` | 零入边文档（**默认排除**入口文档：`README*` / `index*` / 根目录文档） |
| `report` | 总览：文档 / 锚点 / 内部边 / 文件引用 / 站外链接 +「另有 N 条行内代码路径引用」+「未解析的行内代码路径 token：N 行（其中以 `.md` 结尾 M）」/ 断链 / 孤儿（前 15 个）/ 被引最多（前 10） |
| `summary` | 索引就绪状态（含行内代码路径引用计数 `refEdges`；未索引时提示先 `index`） |

渲染口径：紧凑文本、行号 **1 基**、每类上限 80 行带省略标记；`report` 的孤儿只预览前 15 个（真实仓库动辄上百个，整行输出会撑爆上下文）。

## 边分类（口径）

| kind | 含义 |
| --- | --- |
| `internal` | 指向索引内的另一个 `.md`（可带锚点；锚点不存在时计入断链） |
| `wiki` | `[[Target]]` / `[[Target\|文本]]` / `[[Target#anchor]]`（先按 root 相对、再按源文件目录相对解析） |
| `file` | 目标存在但不是 `.md`（对代码 / 文件的引用、目录引用） |
| `external` | 站外目标（任意 `scheme:` 前缀，如 `http(s)` / `mailto:` / `tel:`；含协议相对 `//`） |
| `ref` | **行内代码里的路径引用**（如 `` `docs/BACKLOG.md` ``）：按候选序解析（候选序：root 相对 → 源目录相对；多解优先源目录形态，与 wiki 同解），只认能解析到索引内文档的 token（root 相对 / 源目录相对 / 目录形态），无解再试目录形态的磁盘兜底；**未命中不产边、不计断链**（示例路径不该变噪声），仅计入 `refUnresolved`（report 露出的漂移探针——文档改名 / 写错路径时升高）。默认计入内部边 / backlinks / impact；需要「文档链接」语义时用 `kind` 过滤（如 `["internal","wiki"]`）。**三处补口（2026-10-04）**：① `` `x.md#sec` `` 先拆锚点（`#sec` 是锚点不是路径），边落 `x.md` 并带上锚点（锚点参与校验，缺失计 `missing-anchor`）；② 目录形态 token（`` `docs/archived` ``，尾斜杠由扫描器剥掉）在索引内无 md 命中时按**磁盘存在**落 `file` 边，不再一律计入未解析（md 文件形态**不做**磁盘兜底，避免绕过 `exclude`）；③ 跨模块**裸名**（`` `SPEC.md` ``）在候选序（root / 源目录）全不中时，按「索引里**唯一**同名文档」兜底——多个同名不猜，仍计未解析 |
| `broken` | 目标不存在（`missing-file`）/ 锚点不存在（`missing-anchor`）/ 指向仓库外（`outside-root`） |

不计为关系边：**图片**（`image`，资产引用）与**引用式定义声明**（`definition`，`[tag]: url` 是目标声明而不是引用）。

## 库 / 服务面

| 导出 | 说明 |
| --- | --- |
| `buildIndex(options?)` | 构建索引（`{root, maxFiles?, exclude?}`）→ `MdMapIndex`（纯只读；结果 JSON-serializable） |
| `createMdMapService(config?)` | 服务实例：`index` / `refresh` / `callers` / `impact` / `orphans` / `report` / `summary`（另有 `hasDoc` / `dispose`） |
| `callers` / `impact` / `orphans` / `report` / `summary` / `topBacklinks` / `getDoc` / `resolveDocRef` | 纯查询函数（输入是索引；`callers` / `impact` 分别支持 `{anchor?, kind?}` / `{depth?, kind?}` 选项） |
| `buildAnchors` / `slugify` / `scanWikiLinks` / `isExternal` / `splitHref` / `resolveDocPath` / `wikiCandidates` / `dirOf` / `candidateDocPaths` | 包入口（`src/index.ts`）再导出的锚点与链接解析工具（独立可测） |
| `scanInlineRefs` / `stripInlineCode` / `stripInlineCodeAcross` / `inlineCodeSpans` / `isRootRelative` / `fenceLines`（`src/links.ts`）与 `toPosix`（`src/indexer.ts`） | 内部模块导出，**未从包入口再导出**；本包实现与测试直接引用 |
| `name` / `inject` / `provide` / `Config` / `apply(ctx, config?)` | DSH bundle 契约 |

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `root` | 会话 cwd | 索引根（工具面 `index` 的 `root` 参数优先） |
| `maxFiles` | `2000` | 文件数上限（超出截断并在 summary / report 标记） |
| `exclude` | `[]` | 追加排除的目录名 |

## 使用示例

```jsonc
{ "action": "index" }
{ "action": "index", "root": "/path/to/repo" }
{ "action": "callers", "path": "docs/BACKLOG.md" }
{ "action": "callers", "path": "docs/BACKLOG.md", "anchor": "1-未完成项" }
{ "action": "callers", "path": "docs/BACKLOG.md", "kind": ["internal", "wiki"] }
{ "action": "impact", "path": "docs/ARCHITECTURE-REUSE.md", "depth": 3 }
{ "action": "impact", "path": "docs/ARCHITECTURE-REUSE.md", "kind": ["internal"] }
{ "action": "orphans" }
{ "action": "report" }
```

输出形如：

```
已索引：204 个文档 / 1841 个锚点 / 1404 条内部边 / 1 条断链（约 250 ms）   ← 对本仓自身的快照（2026-10-02 接入 ref 后重测；同日接入前为 197 文档 / 1778 锚点 / 2 条内部边 / 1 条断链）
root：/path/to/repo
```

```
引用 docs/a.md 共 3 处：
docs/a.md:6 → internal#小节 “自引用”
README.md:3 → internal “A”
README.md:4 → internal#小节 “A 的锚点”
```

## 边界与限制

- **只读**：不写任何文件；每次 `index` 全量扫描（不做增量 / 文件监视）。
- **跨类型引用不做**：代码 / 配置反向引用到文档（「哪些源码引用了这份文档」）未实现（见 `docs/DESIGN.md` §8「明确不做」；原 BACKLOG 条目已关闭，本模块 `docs/BACKLOG.md` 现无未完成项）。
- **自引用口径**：自引用出现在 `callers` 里，但**不计入 backlinks**（避免「自己引用自己 → 不是孤儿」的假阴性）。
- **示例性链接会被计为引用**：行内代码里的语法（`` `[[Target]]` ``）已剥离，但写在正文里的示例（如「形如 `[CHANNEL](来源) 正文`」）仍算一条真实引用——真实仓库实测有 1 例。
- **代码区识别**：用「围栏状态机（带**容器缩进栈**：列表 / 引用内围栏按相对容器 ≤3 空格判定，空行不结束容器）+ **跨行 code span** 剥离（等长反引号闭合，闭合后同行内容继续参与扫描）+ `md-logic` 的 code / frontmatter / html 块」四者并集；围栏行先掩码再剥行内代码，避免围栏反引号污染 span 状态。
- **覆盖「行内代码里的路径」**（2026-10-02 接入）：本仓文档习惯用 `` `docs/BACKLOG.md` `` 这类写法而非 Markdown 链接；现解析为 `kind:"ref"` 边（源目录优先；未命中不产边、不计断链，仅计入 report 的未解析计数），故内部边 / 孤儿 / 被引最多的数字有实质信息量（本仓：内部边 2 → 1404，孤儿 180 → 96）。ref 会稀释「文档链接」语义，用 `callers` / `impact` 的 `kind` 过滤分离。
- **锚点**：GitHub 风格 slug（小写、去标点、空格转 `-`、重名加 `-1`）；不支持 `{#custom}` 与 HTML 锚点。
- **依赖与安装**：`@dsh-toolset/md-logic` 以 `link:../md-logic` 引入（与 `code-map` 依赖 `ast-tools` 同款）。**`npm install` 不支持 `link:` 协议**，故本包用 **pnpm**：`pnpm install`（`scripts/install.sh` 对声明 `link:` 的包自动改走 pnpm；无 pnpm 时脚本会明确报错而不是静默失败）。lockfile 为 `pnpm-lock.yaml`（与 `code-map` 同款）。手工兜底：`mkdir -p node_modules/@dsh-toolset && ln -sfn ../../../md-logic node_modules/@dsh-toolset/md-logic` + 自备 `typescript` / `@types/node`。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # 编译到 dist/
npm run test    # node --test（49 例：锚点 / wiki / 目标解析 / 索引分类与断链 / 行内代码路径引用 / 代码区 / 查询 / 工具面）
```

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/index.ts` | 插件入口（bundle 契约 `name` / `inject` / `provide` / `apply`）+ 库面再导出 |
| `src/indexer.ts` | 文件发现与索引构建（`findMarkdownFiles` / `buildIndex` / `DEFAULT_EXCLUDES` / `DEFAULT_MAX_FILES`） |
| `src/links.ts` | 锚点 slug / wiki 链接补扫 / 行内代码路径 token / 目标解析（纯函数，文件系统访问由 indexer 注入） |
| `src/query.ts` | 关系查询（`callers` / `impact` / `orphans` / `report` / `summary` / `topBacklinks` / `getDoc` / `resolveDocRef`） |
| `src/render.ts` | 工具面文本渲染（`RENDER_LIMIT = 80`） |
| `src/service.ts` | 服务面：持有最近一次索引（`createMdMapService`） |
| `src/tools.ts` | 模型侧工具 `md_map`（action 分派 + 参数校验 + 渲染接线） |
| `src/types.ts` | 数据模型（文档 / 锚点 / 边 / 断链 / 索引 / 选项） |
| `tests/*.test.ts` | 单测（49 例） |

模块文档：架构与机制见 `docs/DESIGN.md`；未完成项见 `docs/BACKLOG.md`；变更过程与已关闭条目见 `docs/archived/`。
