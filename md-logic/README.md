# @dsh-toolset/md-logic

DSH（DeepSeek Harness）进程内插件：**Markdown 逻辑结构**（单文件，读 + 按节改写）。输出带行范围的**节树**、**块级结构**（列表 / 表格 / 代码块 / 引用 / frontmatter / html / hr）与**链接清单**（行内链接 / 图片 / 引用式定义），并注册模型侧工具 `md_logic`。

与 `fs_digest` 的分工（并存不合并）：`fs_digest` = 轻量通用入口（只读、零依赖、快览，与三模式统一）；本包 = **专用深能力**（真实 CommonMark 解析、嵌套层数与表格维度、链接与定义清单、可查询的结构 API）。**跨文件**结构（锚点 / 谁引用了谁 / 断链）属 `md-map`；**行级**锚点改写属 `hash_edit`。

## 模型侧工具

`inject: ["tools"]`，注册一个工具：

| 工具 | action | 返回 |
| --- | --- | --- |
| `md_logic` | `structure` | 节树：`L{起}-{止} h{级} 标题 ·#{内容hash}`（`depth` 控制展示层数，缺省 3；hash = 节原文行的 sha256 前 8 位，供 `replace` 的 `section_hash` 做漂移锚点）+ 总览行（行数 / 节数 / 块数 / 链接数） |
| | `blocks` | 块清单：`§L{节} L{起}-{止} kind·计数`（kind = `frontmatter` / `code` / `table` / `list` / `quote` / `html` / `hr`；list 带条目数与嵌套层数 `d{n}`、table 带 `行×列`、code 带围栏语言、quote 带行数与嵌套、frontmatter 带键数，`html` / `hr` 无后缀）；可按 `kind` / `section` / `from`+`to` / `line` 过滤 |
| | `links` | 链接清单：`§L{节} L{行} kind 文本 → href`（kind = `link` / `image` / `definition`；`link` / `image` 的文本带引号、`definition` 显示为 `[tag]`，带 title 时附 ` "(title)"`）；可按 `linkKind` / `pattern` 过滤 |
| | `replace` | 改写结果：`已按节替换：<path>（N 处，整批原子写）` + 结构提示（继续改前重取范围）；失败 `code` + 原因 + 按 code 的下一步（`content_invalid` 补标题行 / `section_stale`、`file_changed` 重取 `·#hash` 与范围 / 其余重新 structure）与当前范围 / 签名（`section_drift` / `section_stale` / `file_changed`） |

选择成本（写进工具描述）：**只要标题 + 块快览 → `fs_digest`**；**要节行范围配 `read` 按节读、要链接清单 / 块细节 → 本工具**；**改 Markdown → `hash_edit`**（行级锚点 + 整批原子拒绝）。

## 改写面（`replace`）

- **安全语义**：每条 edit 的 `heading`（标题文本，与 `structure` 输出一致）+ `startLine` / `endLine`（`L{start}-{end}`）必须与**当前**文件解析结果一致；不一致 → `section_drift`（带当前范围，重新 `structure` 后再改）；标题不存在 → `section_missing`；区间重叠（父节含子节 / 同一节两条）→ `overlap`；参数非法 → `edits_invalid`。校验优先级：`edits_invalid` → `range_out_of_bounds`（行号越界）→ `section_missing` / `section_drift` / `section_stale`（按 edits 数组顺序）→ `content_invalid` → `overlap`。
- **节内容 hash 锚点**（2026-10-04）：`structure` 每行附 `·#xxxxxxxx` = `sha256(节原文行 [line, endLine] 含端点，以 \n 连接)` 前 8 位 hex（BOM / `\r\n` 不参与，与解析同归一；行内空白**敏感**、不 trim）。edit 可带可选 `section_hash`（须 8 位 hex，容忍抄渲染行时带的引号 / 反引号；格式不符 → `edits_invalid`），与当前内容不符 → `section_stale`（带当前范围与 hash；整批不落盘）——补「同标题 + 同范围但节体 / 标题层级已被外部改动」的漂移盲区。注意 hash 覆盖**标题行与全部子节**：改子节会使其所有祖先节的旧 hash 失效（fail-safe，重取 `structure` 即可）；不带 `section_hash` 时语义与旧版一致。
- **`content` 结构守卫**：非空 `content` 必须以标题行开头（ATX / setext），否则 `content_invalid`（防该节被静默并入父节、节从节树消失）；setext 首行在目标节前一行非空时会吞并上一段 → 此时改用 ATX；空串 = 删除该节。以 frontmatter、缩进代码块开头，或标题在引用 / 列表内的都不算「首行标题」，会被拒。
- **围栏 / 注释配对**（2026-10-04，**解析器裁决** 2026-10-05）：`content` 写未闭合的代码围栏或 HTML 注释会让**目标节之后的节从节树里静默消失**（CommonMark 里两者直到文件结尾才结束）→ 判据是**把 content 代进去重新解析**，比较「改前 / 改后」的节大纲：目标节**之后**（且不在其子树内）的节若有丢失 → `content_invalid`。用解析器本身裁决（而非字符串启发式）是因为容器（列表项 / 引用块）内的围栏与相位组合无法用行级规则穷举：实测启发式既有漏拦也有误拒。启发式扫描（`unclosedBlockReason`）保留但**只用于给出可读成因文案**（未闭合围栏 / 注释的行号），不作判据。判据文本与**落盘文本同口径**（沿用 ③ 的规则剥掉 content 的**单个尾随换行**）——否则空行敏感的构造（如以空行终止的 HTML 块 `<div>` 结尾、后节标题紧贴）会在两处解析出不同结果。目标节之后没有其它节时不拦（不存在丢节），其子树可整块重写、标题可改名。需要精确控制时可改用 `hash_edit` / 官方 `edit`。
- **层级一致**（2026-10-04）：首行标题的**层级**须与目标节一致——标题**文本**可以不同（合法重命名，放行），层级不同则 `content_invalid`。理由：节树按层级嵌套，改层级会连带改变其后同级 / 更低级别节的归属（`##` → `###` 把后续节吞成子节、`##` → `#` 把父节挤出）。**首行之外**的标题同理只允许**更深**层级（内嵌同级 / 更高级标题会提前收束该节、把后续节吞进新父节，同样拒绝）。确需改层级时走显式路径：改写**父节**的 `content`（把该节及其子节一并按新层级写入），或先用 `content=""` 删除该节后在父节内重建；**顶层节**（无父节）改层级请改用 `hash_edit` / 官方 `edit` 整体改写。setext 与 ATX 等价（`===` = h1、`---` = h2，按层级判定，不按写法）。
- **原子性**：所有 edit 先在内存里自下而上应用（坐标基于原文），**全部通过才写盘**；写盘走同目录临时文件 + `rename`，失败清理临时文件、**目标文件字节不变**；疑似二进制（含 NUL）拒写。**读→rename 的 TOCTOU 复核**：读盘时记文件签名（`ino` / `size` / `mtimeMs`），写临时文件后、`rename` 前复 `stat` 比对，不符 → `file_changed`（拒写，防「读完之后文件被外部改写 / 原子替换」被覆盖）；残余窗口 = 本次 `stat` 到 `rename` 之间的微秒级——**尽力而为**，不是完整事务（同尺寸且同 mtime 粒度的改写理论上可漏）。
- **风格保留**：BOM 与换行风格（`\r\n` / `\n`）原样保留；`content` 按文件风格落盘。删除节保留原分隔空行（不做空行折叠）。
- **三方分工**：`md_logic replace` = **按节**（标题 + 行范围 + 内容 hash 漂移检测，整节替换）；`hash_edit` = **行级** LINE:HASH 锚点；官方 `edit` = **文件级**字符串替换 + 版本守卫。
- **不做**：插入 / 移动节、Markdown 语法校验（只保证结构漂移安全 + `content` 首行标题与层级守卫）；不校验 `content` 首行标题与 `heading` 的**文本**一致性（改名属合法操作，放行）。

渲染口径：紧凑文本而非 JSON dump；行号 **1 基**，范围起止相同折叠为 `L{n}`；`structure` / `blocks` / `links` **每类独立 80 行预算**（`RENDER_LIMIT = 80`），超出以「…（其余 N 条略）」收尾。对照：`fs_digest` 的 Markdown 视图是两个独立预算（标题树 ≤ 45 行 + 块清单 ≤ 15 行）。

## 库 / 服务面

| 导出 | 说明 |
| --- | --- |
| `parseMarkdownDocument(text, options?)` | 解析为 `{ lines, frontmatter?, sections, blocks, links }`（纯函数，无 IO；结果 JSON-serializable） |
| `findSections(doc, { levels?, pattern?, line?, limit? })` | 节筛选（返回扁平节：层级、深度、标题路径、行范围） |
| `sectionAt(doc, line)` | 包含该行的**最深**节 |
| `queryBlocks(doc, { kind?, section?, from?, to?, line?, limit? })` | 块筛选 |
| `listLinks(doc, { kind?, pattern?, limit? })` | 链接 / 图片 / 定义筛选 |
| `flattenSections(sections)` | 节树 → 前序扁平清单（带 `path`，如 `标题一 › 小节 1.1`） |
| `renderStructure` / `renderBlocks` / `renderLinks` / `renderReplace` | 工具面同款文本渲染（`RENDER_LIMIT = 80`，`src/render.ts`） |
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

- **为什么不是 `remark`/`unified`**：remark 的节点原生带 `position`（含 offset），但实测 `npm i remark` 会引入 **52 个包**（只装 `remark-parse` + `unified` + `mdast-util-from-markdown` 也要 40 个）；本仓 21 个包（TUI + 20 插件）中带运行时依赖的只有 4 个——`session-channel`（redis）、`code-map` → `ast-tools`、`md-map` → `md-logic`（后两者是 `link:` 本仓包）与本包（`marked`），引入这么大的依赖树不划算。
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

两者**范围口径相同**（节 = 标题行 → 下一个层级 ≤ 本节标题的前一行、尾空行不计、父子包含），差异只来自解析精度（本包真实 CommonMark 解析，`fs_digest` 是文档化的轻量启发式）。同一 fixture 实测（2026-10-02）：

| 情形 | `md_logic`（本包） | `fs_digest` | 谁更准 |
| --- | --- | --- | --- |
| setext 标题（`标题\n===` / `---`） | 计入节树（H1/H2） | 只认 ATX，完全不认；并把上一个 ATX 节的 `endLine` 拉到文件末 | 本包 |
| HTML 块（`<div>…</div>`） | 单列 `html` 块，块内伪标题不进节树 | 无该 kind，块内 `# x` 会被当成标题 | 本包 |
| 缩进代码块（4 空格 / Tab） | 单列 `code` 块（无语言） | 无块（但也不会误判为标题——其正则要求行首无缩进） | 本包 |
| 懒续行（列表 / 引用下的非标记续行） | 计入同一块的 `line..endLine` 与计数 | 会切成两段（`list L1-1` + `list L3-3`） | 本包 |
| `hr` / `html` 块 kind | 有 | 无 | 本包（更细） |
| `depth` 参数语义 | 只过滤**展示**（节树 / 行范围 / 块归属都不变） | 建树时就按 `level <= depth` 剪枝（`endLine` 与块 `section` 随之改变） | 口径不同（非精度差异） |

**何时用谁**：只要标题 + 块快览 → `fs_digest`（轻量、与三模式统一、零依赖）；要行范围做「按节读」、要链接 / 引用式定义清单、要嵌套层数与表格维度 → 本包；改 Markdown → `hash_edit`。

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
