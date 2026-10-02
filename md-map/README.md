# @dsh-toolset/md-map

DSH（DeepSeek Harness）进程内插件：**Markdown 项目级结构与引用分析**（对象是文档，对标 `code-map`）。索引项目内 `**/*.md` 的标题锚点、文档间链接、wiki 链接、对代码 / 文件的引用与被引计数，提供 `callers` / `impact` / `orphans` / `report` 查询；只读。

单文件结构解析**复用 `@dsh-toolset/md-logic`**（本包依赖它，不重复实现 Markdown 解析）；三者分工：**代码结构 → `code_map`；单文件 Markdown 结构 → `md_logic`；项目级文档关系 / 影响面 / 断链 → `md_map`**。

## 模型侧工具

`inject: ["tools"]`，注册一个工具；`provide: ["mdMap"]` 暴露服务面。

| action | 说明 |
| --- | --- |
| `index` / `refresh` | 建立 / 刷新索引（全量扫描；默认 root = 会话 cwd，可用 `root` 指定；跳过 `node_modules` / `.git` / `dist` / `.pi-glla` / `tmp`；`maxFiles` 缺省 2000，超出截断并标记） |
| `callers` | 谁引用了该文档或该锚点：`path`（相对 root 的路径，也支持唯一后缀 / 文件名）+ 可选 `anchor` |
| `impact` | 改这份文档会波及哪些文档（反向引用闭包，`depth` 缺省 2，按层返回，不含起点） |
| `orphans` | 零入边文档（**默认排除**入口文档：`README*` / `index*` / 根目录文档） |
| `report` | 总览：文档 / 锚点 / 内部边 / 文件引用 / 站外链接 / 断链 / 孤儿（前 15 个）/ 被引最多（前 10） |
| `summary` | 索引就绪状态（未索引时提示先 `index`） |

渲染口径：紧凑文本、行号 **1 基**、每类上限 80 行带省略标记；`report` 的孤儿只预览前 15 个（真实仓库动辄上百个，整行输出会撑爆上下文）。

## 边分类（口径）

| kind | 含义 |
| --- | --- |
| `internal` | 指向索引内的另一个 `.md`（可带锚点；锚点不存在时计入断链） |
| `wiki` | `[[Target]]` / `[[Target\|文本]]` / `[[Target#anchor]]`（先按 root 相对、再按源文件目录相对解析） |
| `file` | 目标存在但不是 `.md`（对代码 / 文件的引用、目录引用） |
| `external` | `http(s)` / `mailto:` / `tel:` / 协议相对 `//` |
| `broken` | 目标不存在（`missing-file`）/ 锚点不存在（`missing-anchor`）/ 指向仓库外（`outside-root`） |

不计为关系边：**图片**（`image`，资产引用）与**引用式定义声明**（`definition`，`[tag]: url` 是目标声明而不是引用）。

## 库 / 服务面

| 导出 | 说明 |
| --- | --- |
| `buildIndex(options?)` | 构建索引（`{root, maxFiles?, exclude?}`）→ `MdMapIndex`（纯只读；结果 JSON-serializable） |
| `createMdMapService(config?)` | 服务实例：`index` / `refresh` / `callers` / `impact` / `orphans` / `report` / `summary` |
| `callers` / `impact` / `orphans` / `report` / `summary` / `topBacklinks` / `resolveDocRef` | 纯查询函数（输入是索引） |
| `buildAnchors` / `slugify` / `scanWikiLinks` / `stripInlineCode` / `fenceLines` / `isExternal` / `splitHref` / `resolveDocPath` / `wikiCandidates` | 锚点与链接解析工具（独立可测） |
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
{ "action": "impact", "path": "docs/ARCHITECTURE-REUSE.md", "depth": 3 }
{ "action": "orphans" }
{ "action": "report" }
```

输出形如：

```
已索引：197 个文档 / 1778 个锚点 / 2 条内部边 / 1 条断链（141 ms）   ← 对本仓自身的快照（2026-10-02）
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
- **跨类型引用不做**：代码 / 配置反向引用到文档（「哪些源码引用了这份文档」）本轮未实现，见 `docs/BACKLOG.md` #1。
- **自引用口径**：自引用出现在 `callers` 里，但**不计入 backlinks**（避免「自己引用自己 → 不是孤儿」的假阴性）。
- **示例性链接会被计为引用**：行内代码里的语法（`` `[[Target]]` ``）已剥离，但写在正文里的示例（如「形如 `[CHANNEL](来源) 正文`」）仍算一条真实引用——真实仓库实测有 1 例。
- **代码区识别**：用「围栏状态机（含列表 / 引用内嵌 2 空格缩进围栏）+ 行内代码剥离 + `md-logic` 的 code / frontmatter / html 块」四者并集；**仍有漏判**：列表 / 引用内**4 空格缩进**的围栏、跨行 code span（见 `docs/BACKLOG.md` #2）。
- **不覆盖「行内代码里的路径」**：本仓文档习惯用 `` `docs/BACKLOG.md` `` 这类写法而非 Markdown 链接——这种引用形态**不计入边**（实测本仓 1368 处），故内部边 / 孤儿 / 被引最多的数字会明显偏小；要覆盖它见 `docs/BACKLOG.md` #1。
- **锚点**：GitHub 风格 slug（小写、去标点、空格转 `-`、重名加 `-1`）；不支持 `{#custom}` 与 HTML 锚点。
- **依赖与安装**：`@dsh-toolset/md-logic` 以 `link:../md-logic` 引入（与 `code-map` 依赖 `ast-tools` 同款）。**`npm install` 不支持 `link:` 协议**，故本包用 **pnpm**：`pnpm install`（`scripts/install.sh` 对声明 `link:` 的包自动改走 pnpm；无 pnpm 时脚本会明确报错而不是静默失败）。lockfile 为 `pnpm-lock.yaml`（与 `code-map` 同款）。手工兜底：`mkdir -p node_modules/@dsh-toolset && ln -sfn ../../../md-logic node_modules/@dsh-toolset/md-logic` + 自备 `typescript` / `@types/node`。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # 编译到 dist/
npm run test    # node --test（36 例：锚点 / wiki / 目标解析 / 索引分类与断链 / 查询 / 工具面）
```
