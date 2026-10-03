# @dsh-toolset/md-logic

DSH（DeepSeek Harness）进程内插件：**Markdown 逻辑结构**（单文件，读 + 按节改写）。输出带行范围的**节树**、**块级结构**（列表 / 表格 / 代码块 / 引用 / frontmatter / html / hr）与**链接清单**（行内链接 / 图片 / 引用式定义），并注册模型侧工具 `md_logic`。

与 `fs_digest` 的分工（并存不合并）：`fs_digest` = 轻量通用入口（只读、零依赖、快览，与三模式统一）；本包 = **专用深能力**（真实 CommonMark 解析、嵌套层数与表格维度、链接与定义清单、可查询的结构 API）。

## 模型侧工具

`inject: ["tools"]`，注册一个工具：

| 工具 | action | 返回 |
| --- | --- | --- |
| `md_logic` | `structure` | 节树：`L{起}-{止} h{级} 标题`（`depth` 控制展示层数，缺省 3）+ 总览行（行数 / 节数 / 块数 / 链接数） |
| | `blocks` | 块清单：`§L{节} L{起}-{止} kind·计数`（list 带条目数与嵌套层数 `d{n}`、table 带 `行×列`、code 带围栏语言、quote 带行数与嵌套、frontmatter 带键数）；可按 `kind` / `section` / `from`+`to` / `line` 过滤 |
| | `links` | 链接清单：`§L{节} L{行} kind "文本" → href`（kind = `link` / `image` / `definition`）；可按 `linkKind` / `pattern` 过滤 |
| | `replace` | 改写结果：`已按节替换：<path>（N 处，整批原子写）`；失败 `code` + 原因 + 「先 structure 取最新范围」与当前范围（`section_drift`） |

选择成本（写进工具描述）：**只要标题 + 块快览 → `fs_digest`**；**要节行范围配 `read` 按节读、要链接清单 / 块细节 → 本工具**；**改 Markdown → `hash_edit`**（行级锚点 + 整批原子拒绝）。

## 改写面（`replace`）

- **安全语义**：每条 edit 的 `heading`（标题文本，与 `structure` 输出一致）+ `startLine` / `endLine`（`L{start}-{end}`）必须与**当前**文件解析结果一致；不一致 → `section_drift`（带当前范围，重新 `structure` 后再改）；标题不存在 → `section_missing`；区间重叠（父节含子节 / 同一节两条）→ `overlap`；参数非法 → `edits_invalid`。
- **原子性**：所有 edit 先在内存里自下而上应用（坐标基于原文），**全部通过才写盘**；写盘走同目录临时文件 + `rename`，失败清理临时文件、**目标文件字节不变**；疑似二进制（含 NUL）拒写。
- **风格保留**：BOM 与换行风格（`\r\n` / `\n`）原样保留；`content` 按文件风格落盘。删除节保留原分隔空行（不做空行折叠）。
- **三方分工**：`md_logic replace` = **按节**（标题 + 行范围漂移检测，整节替换）；`hash_edit` = **行级** LINE:HASH 锚点；官方 `edit` = **文件级**字符串替换 + 版本守卫。
- **不做**：插入 / 移动节、Markdown 语法校验（只保证结构漂移安全）。

渲染口径：紧凑文本而非 JSON dump；行号 **1 基**，范围起止相同折叠为 `L{n}`；每类上限 **80 行**，超出以「…（其余 N 条略）」收尾。

## 库 / 服务面

| 导出 | 说明 |
| --- | --- |
| `parseMarkdownDocument(text, options?)` | 解析为 `{ lines, frontmatter?, sections, blocks, links }`（纯函数，无 IO；结果 JSON-serializable） |
| `findSections(doc, { levels?, pattern?, line?, limit? })` | 节筛选（返回扁平节：层级、深度、标题路径、行范围） |
| `sectionAt(doc, line)` | 包含该行的**最深**节 |
| `queryBlocks(doc, { kind?, section?, from?, to?, line?, limit? })` | 块筛选 |
| `listLinks(doc, { kind?, pattern?, limit? })` | 链接 / 图片 / 定义筛选 |
| `flattenSections(sections)` | 节树 → 前序扁平清单（带 `path`，如 `标题一 › 小节 1.1`） |
| `renderStructure` / `renderBlocks` / `renderLinks` | 工具面同款文本渲染（`RENDER_LIMIT = 80`） |
| `detectFrontmatter(lines, maxLines?)` | frontmatter 识别（独立可测） |
| `name` / `inject` / `Config` / `apply(ctx, config?)` | DSH bundle 契约 |

## 解析选型

用 [`marked`](https://marked.js.org/)（唯一运行时依赖，**零传递依赖**）：

- **为什么不是 `remark`/`unified`**：remark 的节点原生带 `position`（含 offset），但实测 `npm i remark` 会引入 **52 个包**（只装 `remark-parse` + `unified` + `mdast-util-from-markdown` 也要 40 个）；本仓 19 个包中只有 `session-channel`（redis）与 `code-map`（link 本仓包）带运行时依赖，引入这么大的依赖树不划算。
- **为什么不纯自研**：正则解析覆盖不了嵌套列表、表格转义、setext 标题、HTML 块、缩进代码块等 CommonMark 边角，做不出本条要求的「精确解析」。
- **行范围怎么来**：marked 的块级 token 按文档顺序给出 `raw`，且**全部 token 的 `raw` 拼接等于输入文本**——这里的输入是**归一化后**的文本（见下条；测试对该不变量有断言）；用「字符偏移游标 + 行首偏移表二分」即得精确范围，不依赖 token 自带位置，也不做逐 token 线性扫前缀。
- **输入归一化**：解析前剥首行 BOM、把 CRLF/CR 统一为 LF（**行数与原文一致**）。marked 内部按 LF 处理 `raw`，若直接喂 CRLF 原文，偏移与行号会错位（实测）；BOM 不剥则首个标题会整段退化成段落。
- **不用 marked 全局单例**：用 `new Marked({ gfm: true })` 实例。同进程其它消费者调 `marked.use(...)` 会改全局 defaults（实测 `marked.use({ gfm: false })` 会让命名导出的 `lexer` 把表格降级为段落），本包不依赖全局状态。
- **frontmatter**：marked 不认（`---` 会变成 hr + setext 标题），故先自行识别（仅文件**首行**、有界配对、内部只含 YAML 键 / 注释 / 空行），再把该区间**置空并保留行数**后交给 marked，保证后续行号不漂移。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxBytes` | `1048576`（1MB） | 读取尺寸上限；超限报错而不截断（截断会给出错误行号） |

## 使用示例

```jsonc
{ "action": "structure", "path": "README.md" }
{ "action": "structure", "path": "docs/DESIGN.md", "depth": 2 }
{ "action": "blocks", "path": "README.md", "kind": ["table", "code"] }
{ "action": "blocks", "path": "README.md", "section": 42, "line": 60 }
{ "action": "links", "path": "README.md", "pattern": "http" }
```

输出形如：

```
Markdown 结构：35 行 / 3 节 / 7 块 / 3 链接
L6-34 h1 标题一
  L10-28 h2 小节 1.1
  L30-34 h2 小节 1.2
```

```
§L10 L12-14 list·3项·d2
§L10 L16-18 code·ts
§L10 L20-23 table·2行×2列
§L10 L25-26 quote·2行·d1
```

## 与 `fs_digest` 的口径差异

两者**范围口径相同**（节 = 标题行 → 下一个层级 ≤ 本节标题的前一行、尾空行不计、父子包含），差异只来自解析精度（本包真实 CommonMark 解析，`fs_digest` 是文档化的轻量启发式）。同一 fixture 实测（2026-10-02）：

| 情形 | `md_logic`（本包） | `fs_digest` | 谁更准 |
| --- | --- | --- | --- |
| setext 标题（`标题\n===` / `---`） | 计入节树（H1/H2） | 只认 ATX，完全不认；并把上一个 ATX 节的 `endLine` 拉到文件末 | 本包 |
| HTML 块（`<div>…</div>`） | 单列 `html` 块，块内伪标题不进节树 | 无该 kind，块内 `# x` 会被当成标题 | 本包 |
| 缩进代码块（4 空格 / Tab） | 单列 `code` 块（无语言） | 无块（但也不会误判为标题——其正则要求行首无缩进） | 本包 |
| 懒续行（列表 / 引用下的非标记续行） | 计入同一块的 `line..endLine` 与计数 | 会切成两段（`list L1-1` + `list L3-3`） | 本包 |
| `hr` / `html` 块 kind | 有 | 无 | 本包（更细） |

**何时用谁**：只要标题 + 块快览 → `fs_digest`（轻量、与三模式统一、零依赖）；要行范围做「按节读」、要链接 / 引用式定义清单、要嵌套层数与表格维度 → 本包；改 Markdown → `hash_edit`。

## 边界与限制

- **读面只读**：`structure` / `blocks` / `links` 不写文件、不改宿主状态；写面只有 `replace`（按节整节替换 / 删除，见上「改写面」）。注意：`replace` 整文件重写、**绕开官方 fs-observation-policy 版本守卫与 `ctx.fs` 沙箱**（同 ast-tools 的整文件重写情形），之后官方 `edit` / `write` 可能撞 FS_STALE_VERSION；路径限本包守卫（size 上限 + isFile + 非 UTF-8 拒写）。做）。
- **行范围口径与 `fs-digest` 对齐**：节 = 标题行 → 下一个「层级 ≤ 本节标题」的前一行（末节到文件末非空行），**尾部空行不计**；父子是**包含关系**（父 ⊇ 子）；块 `kind` 命名沿用 `frontmatter|code|table|list|quote`，本包另加 `html|hr`。
- **依赖与前置**：`npm run check` / `build` 需要本包 `node_modules`（`marked` + devDeps）；`scripts/install.sh` 只在 `md-logic/node_modules` **不存在**时才装依赖，**改过依赖后需手动 `npm --prefix md-logic install`**（profile 以 `link:` 引用本包，其依赖由包内 `node_modules` 提供，profile 的 `pnpm install` 不装 link 包的依赖）；`--skip-build` 要求各包依赖与 `dist/` 已就绪。
- **不建 `docs/DESIGN.md`**：本包单一职责、单文件粒度，架构与取舍写在 README「解析选型」+ 建包追踪文档（`docs/archived/2026-10-02-md-logic-package.md`）里，不再单开 DESIGN（参照模板 `ast-tools` 同样没有）。
- 只做 Markdown：不做 PDF / 纯文本；不渲染 HTML（只输出结构）。
- frontmatter 只认文件首行且需在有界范围内配对（缺省 40 行），避免把 `---` 水平线当 frontmatter 吞掉正文。
- 解析结果的行号基于「剥 BOM、CRLF/CR → LF」后的文本（行数与原文一致）。

## 测试

```sh
npm run check   # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm run build   # 编译到 dist/
npm run test    # node --test（48 例：解析 / 查询 / 工具面 / 改写面）
```

依赖 `marked` 的解析用例恒跑（无外部二进制）；工具面用例用临时 fixture 真实读写文件系统。

## 换行（EOL）口径（2026-10-02）

- **非混合文件**（纯 LF / 纯 CRLF）：写回时全文件保持该风格（与旧版逐字节一致）。
- **混合 EOL 文件**（同时含 CRLF 与独立 LF）：**未改动的行保留原有行尾**（前缀 / 后缀对齐），
  仅新增 / 替换的行使用**主导**风格（多数派；并列取 LF）。避免 `replace` 把整文件行尾翻转。
