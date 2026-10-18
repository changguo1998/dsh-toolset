# @dsh-toolset/md-logic

DSH（DeepSeek Harness）进程内插件：**Markdown 逻辑结构**（单文件，读 + 按节改写）。输出带行范围的**节树**、**块级结构**（列表 / 表格 / 代码块 / 引用 / frontmatter / html / hr）与**链接清单**（行内链接 / 图片 / 引用式定义），并注册模型侧工具 `md_logic`。

与 `fs_digest` 的分工（并存不合并）：`fs_digest` = 轻量通用入口（只读、零依赖、快览，与三模式统一）；本包 = **专用深能力**（真实 CommonMark 解析、嵌套层数与表格维度、链接与定义清单、可查询的结构 API）。**跨文件**结构（锚点 / 谁引用了谁 / 断链）属 `md-map`；**行级**锚点改写属 `hash_edit`；**文件级**字符串替换 + 版本守卫属官方 `edit`。

## 模型侧工具

`inject: ["tools"]`，注册一个工具：

| 工具 | action | 返回 |
| --- | --- | --- |
| `md_logic` | `structure` | 节树：`L{起}-{止} h{级} 标题 ·#{内容hash}`（`depth` 控制展示层数，缺省 3；hash = 节原文行的 sha256 前 8 位，供 `replace` 的 `section_hash` 做漂移锚点）+ 总览行（行数 / 节数 / 块数 / 链接数） |
| | `blocks` | 块清单：`§L{节} L{起}-{止} kind·计数`（kind = `frontmatter` / `code` / `table` / `list` / `quote` / `html` / `hr`；list 带条目数与嵌套层数 `d{n}`、table 带 `行×列`、code 带围栏语言、quote 带行数与嵌套、frontmatter 带键数，`html` / `hr` 无后缀）；可按 `kind` / `section` / `from`+`to` / `line` 过滤 |
| | `links` | 链接清单：`§L{节} L{行} kind 文本 → href`（kind = `link` / `image` / `definition`；`link` / `image` 的文本带引号、`definition` 显示为 `[tag]`，带 title 时附 ` "(title)"`）；可按 `linkKind` / `pattern` 过滤 |
| | `replace` | 改写结果：`已按节替换：<path>（N 处，整批原子写）` + 结构提示（继续改前重取范围）；失败 `code` + 原因 + 按 code 的下一步（`content_invalid` 补标题行 / `section_stale`、`file_changed` 重取 `·#hash` 与范围 / 其余重新 structure）与当前范围 / 签名（`section_drift` / `section_stale` / `file_changed`） |

选择成本（写进工具描述）：见开头「与 `fs_digest` 的分工」。

## 改写面（`replace`）

- **安全语义与 hash 锚点**：`heading` + `startLine` / `endLine` 须与当前解析一致（否则 `section_drift` / `section_missing` / `edits_invalid`；同一批区间相交 → `overlap`；优先级 `edits_invalid` → `range_out_of_bounds` → `section_missing` / `section_drift` / `section_stale` → `content_invalid` → `overlap`）；`structure` 每行附 `·#xxxxxxxx` = 节原文行（含端点，以 `\n` 连接）sha256 前 8 位 hex（BOM / `\r\n` 不参与、行内空白敏感），edit 可带 `section_hash`（须 8 位 hex，容忍引号 / 反引号；格式不符 → `edits_invalid`）补「同标题同范围但节体或层级被外部改动」的盲区，与当前内容不符 → `section_stale`（整批不落盘）；hash 覆盖标题行与全部子节（改子节会使祖先 hash 失效，重取 `structure` 即可），不带时语义同旧版。
- **结构守卫**：非空 `content` 须以标题行开头（ATX / setext；setext 首行在目标节前一行非空时会吞并上一段，此时改用 ATX；以 frontmatter / 缩进代码块开头、标题在引用或列表内都不算），首行层级须与目标节一致（标题文本可不同 = 合法重命名，放行）、首行之外只允许更深层级；空串 = 删除该节。确需改层级时改写父节 `content`（连同子节按新层级重写）或先 `content=""` 删除后在父节内重建，顶层节改层级改用 `hash_edit` / 官方 `edit`。
- **未闭合围栏 / 注释的吞节裁决**：判据是**把 content 代进去重新解析**、比较改前 / 改后的节大纲——目标节之后（且不在其子树内）的节有丢失即 `content_invalid`
  （启发式扫描 `unclosedBlockReason` 只用于生成成因文案，不作判据；判据文本与落盘文本同口径：剥 content 的单个尾随换行）。
  目标节之后没有其它节时不拦，其子树可整块重写、标题可改名；需要精确控制时改用 `hash_edit` / 官方 `edit`；机制与理由见 `docs/DESIGN.md` §4。
- **原子性、风格与分工**：全部 edit 先在内存里自下而上应用（坐标基于原文）、**全部通过才写盘**（同目录临时文件 + `rename`，失败清理临时文件、目标文件字节不变；含 NUL 拒写；读盘记 `ino` / `size` / `mtimeMs`、写临时文件后 `rename` 前复核，不符 → `file_changed`，残余窗口为微秒级、尽力而为）；BOM 与 EOL 风格原样保留、删除节保留原分隔空行；与 `hash_edit` / 官方 `edit` 的分工见开头；不做插入 / 移动节与 Markdown 语法校验，不校验 `content` 首行标题与 `heading` 的文本一致性（改名放行）。

渲染口径：紧凑文本而非 JSON dump；行号 **1 基**，范围起止相同折叠为 `L{n}`；`structure` / `blocks` / `links` **每类独立 80 行预算**，超出以「…（其余 N 条略）」收尾。对照：`fs_digest` 的 Markdown 视图是两个独立预算（标题树 ≤ 45 行 + 块清单 ≤ 15 行）。

## 库 / 服务面

| 导出 | 说明 |
| --- | --- |
| `parseMarkdownDocument(text, options?)` | 解析为 `{ lines, frontmatter?, sections, blocks, links }`（纯函数，无 IO；结果 JSON-serializable） |
| `findSections(doc, { levels?, pattern?, line?, limit? })` | 节筛选（返回扁平节：层级、深度、标题路径、行范围） |
| `sectionAt(doc, line)` | 包含该行的**最深**节 |
| `queryBlocks(doc, { kind?, section?, from?, to?, line?, limit? })` | 块筛选 |
| `listLinks(doc, { kind?, pattern?, limit? })` | 链接 / 图片 / 定义筛选 |
| `flattenSections(sections)` | 节树 → 前序扁平清单（带 `path`，如 `标题一 › 小节 1.1`） |
| `renderStructure` / `renderBlocks` / `renderLinks` / `renderReplace` | 工具面同款文本渲染（`src/render.ts`） |
| `replaceSections(text, edits)` / `replaceSectionsFile(path, edits, root?, maxBytes?)` | 按节改写：纯函数校验 + 整批原子写（`ReplaceOutcome`：成功 `applied`，失败 `code` + `details`） |
| `sectionHash(text, line, endLine)` / `sameSignature(a, b)` | 节内容 hash（8 位 hex，漂移锚点）/ 文件签名比对（TOCTOU 复核；纯函数） |
| `detectFrontmatter(lines, maxLines?)` | frontmatter 识别（独立可测） |
| `mdLogicTool(maxBytes?)` / `DEFAULT_MAX_BYTES` / `resolveExecCwd(exec)` | 工具定义（`md_logic`）/ 读上限缺省 1MB / 路径基准（会话 cwd，缺省进程 cwd） |
| `SectionNode` / `MdBlock` / `MdLink` / `MarkdownDocument` / `ParseOptions` / `FrontmatterInfo` / `MdBlockKind` / `MdLinkKind` | 结构模型（`src/types.ts`；行号 1 基、范围含两端、全 JSON-serializable） |
| `FlatSection` / `SectionQuery` / `BlockQuery` / `LinkQuery` | 查询面类型（`src/query.ts`） |
| `SectionEdit` / `EditFailureCode` / `FileSignature` | 改写面类型（`src/edit.ts`） |
| `name` / `inject` / `Config` / `apply(ctx, config?)` | DSH bundle 契约 |

## 解析选型

用 [`marked`](https://marked.js.org/)（唯一运行时依赖，**零传递依赖**）：

- **为什么不是 `remark`/`unified`**：remark 的节点原生带 `position`（含 offset），但实测 `npm i remark` 会引入 **52 个包**（只装 `remark-parse` + `unified` + `mdast-util-from-markdown` 也要 40 个）；本仓 29 个包（TUI + 28 插件）中带运行时依赖的只有 4 个——`session-channel`（redis）、`code-map` → `ast-tools`、`md-map` → `md-logic`（后两者是 `link:` 本仓包）与本包（`marked`），引入这么大的依赖树不划算。
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
L6-34 h1 标题一 ·#9f3a1c07
  L10-28 h2 小节 1.1 ·#04c7be21
  L30-34 h2 小节 1.2 ·#6d18aa39
```

```
§L10 L12-14 list·3项·d2
§L10 L16-18 code·ts
§L10 L20-23 table·2行×2列
§L10 L25-26 quote·2行·d1
```

## 与 `fs_digest` 的口径差异

两者**范围口径相同**（节 = 标题行 → 下一个层级 ≤ 本节标题的前一行、尾空行不计、父子包含），差异只来自解析精度（本包真实 CommonMark 解析，`fs_digest` 是文档化的轻量启发式）；同一 fixture 实测（2026-10-02）：**setext 标题**本包计入节树（H1/H2），`fs_digest` 只认 ATX 且把上一个 ATX 节的 `endLine` 拉到文件末；**HTML 块**本包单列 `html` 块、块内伪标题不进节树，`fs_digest` 无该 kind、块内 `# x` 会当标题。
**缩进代码块**（4 空格 / Tab）本包单列 `code` 块（无语言），`fs_digest` 无块但不误判标题；**懒续行**本包计入同一块的 `line..endLine` 与计数，`fs_digest` 会切成两段（如 `list L1-1` + `list L3-3`）；**`hr` / `html` 块 kind** 本包有、`fs_digest` 无；**`depth` 参数**本包只过滤展示（节树 / 行范围 / 块归属不变），`fs_digest` 建树时按 `level <= depth` 剪枝（`endLine` 与块 `section` 随之改变），属口径不同而非精度差异。
**何时用谁**：见开头「与 `fs_digest` 的分工」。

## 边界与限制

- **读面只读**：`structure` / `blocks` / `links` 不写文件、不改宿主状态；写面只有 `replace`（按节整节替换 / 删除，见上「改写面」）。注意：`replace` 整文件重写、**绕开官方 fs-observation-policy 版本守卫与 `ctx.fs` 沙箱**（同 ast-tools 的整文件重写情形），之后官方 `edit` / `write` 可能撞 FS_STALE_VERSION；路径限本包守卫（size 上限 + isFile + 非 UTF-8 拒写）。
- **行范围口径与 `fs-digest` 对齐**：节 = 标题行 → 下一个「层级 ≤ 本节标题」的前一行（末节到文件末非空行），**尾部空行不计**；父子是**包含关系**（父 ⊇ 子）；块 `kind` 命名沿用 `frontmatter|code|table|list|quote`，本包另加 `html|hr`。
- **依赖与前置**：`npm run check` / `build` 需要本包 `node_modules`（`marked` + devDeps）；`scripts/install.sh` 只在 `md-logic/node_modules` **不存在**时才装依赖，**改过依赖后需手动 `npm --prefix md-logic install`**（profile 以 `link:` 引用本包，其依赖由包内 `node_modules` 提供，profile 的 `pnpm install` 不装 link 包的依赖）；`--skip-build` 要求各包依赖与 `dist/` 已就绪。
- **文档分工**：能力清单 / 配置 / 口径差异在本文件；架构与机制取舍见 `docs/DESIGN.md`；未完成项见 `docs/BACKLOG.md`；建包与变更过程见 `docs/archived/` 与 git 历史。
- 只做 Markdown：不做 PDF / 纯文本；不渲染 HTML（只输出结构）。
- frontmatter 只认文件首行且需在有界范围内配对（缺省 40 行），避免把 `---` 水平线当 frontmatter 吞掉正文。
- 解析结果的行号基于「剥 BOM、CRLF/CR → LF」后的文本（行数与原文一致）。

## 测试

```sh
npm run check   # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm run build   # 编译到 dist/
npm run test    # node --test（57 例：解析 21 / 查询 5 / 工具面 9 / 改写面 22）
```

依赖 `marked` 的解析用例恒跑（无外部二进制）；工具面用例用临时 fixture 真实读写文件系统。

## 换行（EOL）口径（2026-10-02）

- **非混合文件**（纯 LF / 纯 CRLF）：写回时全文件保持该风格（与旧版逐字节一致）。
- **混合 EOL 文件**（同时含 CRLF 与独立 LF）：**未改动的行保留原有行尾**（前缀 / 后缀对齐），
  仅新增 / 替换的行使用**主导**风格（多数派；并列取 LF）。避免 `replace` 把整文件行尾翻转。
