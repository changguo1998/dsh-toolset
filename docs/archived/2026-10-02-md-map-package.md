# 新建 `md-map` 插件（Markdown 项目级结构与引用分析，接取条目：`docs/BACKLOG.md`「新建 markdown 项目级结构分析插件（对标 `code-map`）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

建第 19 个包 `md-map/`（对标 `code-map`，但对象是文档）：索引项目内 `.md` 文件的**结构**与**关系**——标题锚点、文档间链接（`[x](path#anchor)`）、wiki 链接、对代码 / 文件的引用、被引用计数；查询面 `callers` / `impact` / `orphans` / `report`。

边界（用户 2026-10-02 裁定 + 已完成条目的分工）：

- **单文件结构解析复用 `md-logic`**（已落地并挂进 fff）：本条只做**项目级关系与影响面**，不重复实现 Markdown 解析。
- 与 `code-map` 的分工：代码 vs 文档；**跨类型引用（代码 → 文档）本轮不做**，记为后续条目。
- 包名 `md-map`；模板 = 已落地的 `md-logic`（骨架）+ `code-map`（服务 / 查询 / 工具形状）。

## 调研（2026-10-02）

- **模板形状**（`code-map/src/index.ts`）：`name` / `inject: ["tools"]` / `provide: ["codeMap"]` / `Config` / `CodeMapBundle extends CodeMapService {dispose}` / `createCodeMapBundle()`（ast-grep 缺失时返回降级 bundle，不抛）/ `getCodeMapBundle()` / `apply()` 内 `tools.register(toToolDef(...))`；工具 `code_map` 用 action 分派 + `output.schema` + `render` 返回 `JSON.stringify`。
- **可复用解析**（`md-logic`）：`parseMarkdownDocument(text)` → `{lines, frontmatter?, sections, blocks, links}`，`links` 已含 `link|image|definition` 三类（行内链接、图片、引用式定义），带 1 基行号与节归属；`flattenSections()` 给标题层级与行范围（**不含锚点 slug**，由本条补）。
- **依赖先例**：`code-map` 以 `"@dsh-toolset/ast-tools": "link:../ast-tools"` 复用本仓包；profile 以 `link:` 引用包后，其依赖由包内 `node_modules` 提供（`npm install` 落包内）——`md-map` 同样写 `link:../md-logic`。
- **接线面**（新增包必须同步，含上一条目新发现的项）：根 `package.json` 的 check/build 链、`scripts/install.sh` `canonical_pkgs`、`scripts/test-parallel.sh` `default_pkgs`、双语 `README`（表 + 计数 + 目录树）、`AGENTS.md`、`docs/WORKFLOW-STANDARD.md`、`docs/host/HOST-PACKAGES.md`（包数）、`docs/ARCHITECTURE-REUSE.md`（§0 / §2 / §3）。

## 决策

- **D1（索引发现）**：`index({root?})` / `refresh({root?})`；root 缺省 = 会话 cwd（工具 exec 的 `agent.session.header.cwd`）→ 进程 cwd；扫 `**/*.md`（大小写不敏感后缀）；默认排除 `node_modules` / `.git` / `dist` / `.pi-glla` / `tmp`；`maxFiles` 缺省 2000（超出截断并在 summary 标注 truncated）。
- **D2（单文件解析复用 `md-logic`）**：对每个文件调 `parseMarkdownDocument(text)`，取 `sections`（扁平化）与 `links`；**包依赖用 `link:../md-logic`**，不复制解析逻辑（口径天然一致）。
- **D3（锚点 slug）**：按 GitHub 风格从标题文本生成（**实现口径**：小写 → 去 `[^\p{L}\p{N}\s-]` → 连续空白折叠为单个 `-` → 重复标题加 `-1`/`-2` 后缀；注意实现会去掉下划线，与 GitHub 官方 slugger 的差异未实测）；`{#custom}` 显式锚点本轮不做（记 README 边界）。锚点表挂在每个文档上（`line` + `level` + `anchor`）。
- **D4（链接分类）**：每条链接解析出 `kind` 与目标：
  - `internal`：目标为索引内的 `.md` 文件（可带 `#anchor`）；
  - `wiki`：`[[Target]]` / `[[Target|文本]]` / `[[Target#anchor]]`（**md-logic 不产**，本条用行级正则补扫）；
  - `file`：目标存在但不是 `.md`（即「对代码 / 文件的引用」，如 `[x](src/foo.ts)`）；
  - `external`：`http(s)://` / `mailto:` 等；
  - `broken`：目标路径在仓库内不存在；`brokenAnchor`：文件在但锚点不在。
- **D5（查询面，对标 code-map）**：
  - `callers(target, {anchor?})`：谁引用了该文档 / 该锚点（列出 `from` 文档 + 行号）；
  - `impact(path, {depth?=2})`：反向引用闭包（文档 → 谁引用了它 → …），带层号；
  - `orphans()`：零入边的文档（标出 `README*` / `index*` 这类入口）；
  - `report()`：文档数 / 边数（内部 / 文件 / 站外）/ 断链 / 孤儿（按路径字典序取前 15）/ 被引 top-N（前 10）；
  - `summary()`：是否已索引 + 根 + 文件数 / 锚点数 / 边数 / 耗时。
- **D6（模型面）**：注册 `md_map`（action 分派 `index` / `refresh` / `callers` / `impact` / `orphans` / `report` / `summary`，与 `code_map` 同风格）；描述里写清三者分工——**代码结构 → `code_map`；单文件 Markdown 结构 → `md_logic`；项目级文档关系 / 影响面 / 断链 → 本条**；`output.schema`（object 根）+ 全函数 render（紧凑文本，非 JSON dump；行号 1 基；上限 80 行）。
- **D7（不做）**：跨类型引用（代码 / 配置 → 文档的反向引用）不做，记模块条目；不做增量 / 文件监视（每次 `index` 全量扫，秒级）；不做 Markdown 渲染与改写；`{#custom}` 锚点与 HTML 锚点不做。
- **D8（包骨架与接线）**：以 `md-logic` 为骨架模板（package.json / tsconfig / cordis.patch.yml / LICENSE / .gitignore / src / tests / README / docs）；接线 8 处（D-调研所列）+ `provide: ["mdMap"]` 与 `code-map` 同款。
- **D9（挂载）**：落 fff 属仓库外改动，需用户批准（沿用上一条目的 `install.sh --sync` 路径）。

## 计划改动文件清单

- `md-map/package.json`、`md-map/tsconfig.json`、`md-map/cordis.patch.yml`、`md-map/LICENSE`、`md-map/.gitignore`
- `md-map/src/types.ts`、`src/indexer.ts`、`src/links.ts`（锚点 / wiki / 目标分类）、`src/query.ts`、`src/render.ts`、`src/tools.ts`、`src/index.ts`
- `md-map/tests/helpers.ts`、`tests/links.test.ts`、`tests/indexer.test.ts`、`tests/query.test.ts`、`tests/tool.test.ts`
- `md-map/README.md`、`md-map/docs/BACKLOG.md`
- 接线：根 `package.json`、`scripts/install.sh`、`scripts/test-parallel.sh`、`README.md`、`README.zh.md`、`AGENTS.md`、`docs/WORKFLOW-STANDARD.md`、`docs/host/HOST-PACKAGES.md`、`docs/ARCHITECTURE-REUSE.md`
- `docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）、本追踪文档

## 实现记录

| 文件 | 改动 |
|---|---|
| `md-map/package.json` / `tsconfig.json` / `cordis.patch.yml` / `LICENSE` / `.gitignore` | 新包骨架；依赖 `"@dsh-toolset/md-logic": "link:../md-logic"`（与 `code-map` → `ast-tools` 同款），**不提交 lockfile**（`npm install` 不支持 `link:` 协议，改为手工 symlink + 自带 devDeps） |
| `md-map/src/types.ts` | 数据模型：`MdDoc` / `MdAnchor` / `MdEdge`（5 kind）/ `MdBrockenLink`（3 reason）/ `MdMapIndex` / 查询结果类型 |
| `md-map/src/links.ts` | `slugify` + `buildAnchors`（GitHub 风格、重名加后缀）、`scanWikiLinks`（含 `stripInlineCode`）、`fenceLines`（自带 CommonMark 口径围栏状态机，覆盖列表 / 引用内嵌围栏）、`isExternal` / `splitHref` / `resolveDocPath`（越界返回 null）/ `wikiCandidates` |
| `md-map/src/indexer.ts` | `findMarkdownFiles`（递归 + 排除 + `maxFiles` 截断）+ `buildIndex`：逐文件复用 `md-logic` 的 `parseMarkdownDocument` → 锚点、边分类（internal / wiki / file / external / broken）、锚点校验、入边计数（自引用不计）、断链登记 |
| `md-map/src/service.ts` | `createMdMapService`（持有最近一次索引；无外部二进制 → 不需要降级 bundle） |
| `md-map/src/query.ts` | `callers` / `resolveDocRef`（精确 + 唯一后缀 + 文件名）/ `impact`（按层反向闭包）/ `orphans` / `topBacklinks` / `report` / `summary` |
| `md-map/src/render.ts` | 工具面渲染（1 基、每类 80 行、`report` 孤儿预览 15 个逐行输出） |
| `md-map/src/tools.ts` | `md_map` 工具（action 分派；参数校验先于 IO；`output.schema` + 全函数 render；描述写清三方分工） |
| `md-map/src/index.ts` | bundle 契约：`name` / `inject: ["tools"]` / `provide: ["mdMap"]`（与 `code-map` 同款）+ `getMdMapService` / `getMdMapSummary` + 全部库面导出 |
| `md-map/tests/**` | 29 例：锚点 slug 与去重、wiki 三形态与行内代码剥离、围栏状态机（列表内嵌 / 未闭合 / `~~~` 混用）、目标解析（越界 / 绝对 / query / 百分号编码 / wiki 候选顺序）、索引（发现与排除、五类边、三类断链、自引用不计入边、目录引用、截断）、查询面、工具面（注册 / provide / 契约 / 参数矩阵 / 端到端 / 渲染全函数与形参顺序） |
| `md-map/README.md` / `docs/BACKLOG.md` | README（模型工具 / 边分类口径 / 库面 / 配置 / 示例 / **边界与限制**）；模块待办 #1 = 跨类型引用（代码 → 文档）、#2 = 无围栏缩进代码块漏判 |
| 接线 | 根 `package.json`（check/build 链 → 20 包）、`scripts/install.sh`、`scripts/test-parallel.sh`、双语 README（表 + 计数 + 目录树）、`AGENTS.md`、`docs/WORKFLOW-STANDARD.md`、`docs/host/HOST-PACKAGES.md`、`docs/ARCHITECTURE-REUSE.md`（§0 / §2 / §3） |

## 实现中发现并修掉的问题（自查 + 真实数据体检）

| 问题 | 现象 | 修法 |
|---|---|---|
| 相对路径越界未检出 | `resolveDocPath("README.md", "../../x.md")` 返回 `x.md` 而不是 null | `joinPosix` 增加 `escaped` 标记；越界映射为断链 `outside-root` |
| 断链目标重复拼锚点 | 报 `../b.md#不存在#不存在` | 直接用原始 `target`（已含锚点），reason 说明原因 |
| 报告整行撑爆上下文 | 对真实仓库（195 文档 / **172 个孤儿**）首跑时 `report` 把 172 个路径拼进一行 | 孤儿预览前 15 个、**逐行**输出 + 「其余 N 个（action=orphans 看全量）」；被引最多截 top 10 |
| 列表内嵌围栏里的 `[[ $a == b ]]` 被判为 wiki 链接 | `md-logic` 的 `blocks` 只报**顶层** code 块，列表 / 引用内嵌围栏不在其中 | `links.ts` 自带围栏状态机 `fenceLines()`，与顶层 code 块取并集 |
| 行内代码里的示例语法被判为 wiki 链接 | `` `[[Target]]` `` | 扫描前 `stripInlineCode()` 剥离行内代码 |

## 测试与证据（2026-10-02）

- `md-map` 包内：`npm run check` / `build` 通过；`npm run test` **29 例全绿**。
- 全仓：`npm run check` exit 0；`npm run build` exit 0；`npm run test` **20 包全 OK**（TUI 1290 / herdr 35 / knowledge-base 57 / task-engine 62 / ast-tools 37 / md-logic 34 / **md-map 29** / fs-digest 61 / goal-contract 35 / hash-edit 43 / metric-loop 35 / output-compress 45 / security-guard 37 / code-map 21 / context-report 42 / rule-engine 83 / symbol-normalizer 38 / session-channel 45 / session-title-cutoff 8 / command-template 13，fail 全 0）。
- **对仓库自身跑真机索引**（加载 `dist/src/index.js`，root = 仓库根）：
  - `index`：`已索引：195 个文档 / 1766 个锚点 / 2 条内部边 / 1 条断链（135 ms）`。
  - `report`：文档 195 / 锚点 1766 / 内部边 2 / 文件引用 0 / 站外链接 18 / 孤儿 172 / 断链 1；输出 **30 行、最长行 97 字符**（修掉整行 576+ 字符的版本）。
  - 唯一断链：`session-channel/docs/archived/2026-09-29-injection-origin-label.md:47 → %E6%9D%A5%E6%BA%90`——该文档正文里**示例性**写了 `[CHANNEL](来源)` 的编码形式，属真实文本而非解析缺陷（已记入 README 限制）；修掉围栏 / 行内代码两类误报后从 7 条降到 1 条。
  - `内部边只有 2 条`的原因：本仓文档习惯用**行内代码**写路径（如 `` `docs/BACKLOG.md` ``）而不是 Markdown 链接，属定义内的结果（`README.md ← 1 处`、`README.zh.md ← 1 处`）；若要覆盖这种引用形态属「跨类型 / 路径字面量」扩展，已记为模块待办 #1。

## 审阅（子代理，2026-10-02，设计 + 实现一并审）

**结论：有条件通过** → 1 项交付级 + 3 项中等 + 3 类小问题全部处置：

| 审阅发现 | 处置 |
|---|---|
| 【交付级】`link:` 协议 npm 不支持 → 新机 `install.sh` 会 die（`code-map` 同病）；`node_modules` 手工拼装、无 lockfile、`.bin/marked` 悬空 | ① `md-map` 改用 **pnpm**（`pnpm install` 生成 `pnpm-lock.yaml`，与 `code-map` 同款）；② **`scripts/install.sh` 对声明 `link:` 的包改走 pnpm**（无 pnpm 时明确报错而非静默失败）——同时修掉 `code-map` 的既有隐患；③ README 写明依赖与安装路径（含手工 symlink 兜底） |
| 【中】代码区误报 4 类 | 已修 `frontmatter` 与 `html` 块（并入 skip 集）；剩余两类（列表内 **4 空格**缩进围栏、跨行 code span）记入模块待办 #2（已改正原先「顶层缩进代码块会误报」的错误表述） |
| 【中】root 相对链接 `[x](/docs/x.md)` 被误判「指向仓库外」 | 修：`/` 开头先按仓库根解析（命中即 internal；未命中文档型则 file；都失败才 outside-root），加回归用例 |
| 【中】README 与实现矛盾（orphans 是否含入口文档） | README 改为「默认**排除**入口文档」；报告文案补「按路径字典序取前 15 个；入口文档已排除」 |
| 【低】root 不存在 → 报成功文案 0 文档 | 工具面加目录校验 → `{error: "root 不存在或不是目录：…"}` |
| 【低】`callers` 未知文档与「无人引用」不可区分 | service 增 `hasDoc()`；工具面返回 `{error: "索引内没有该文档：…"}` |
| 【低】impact 单行可达 21.8 KB（80 行上限不是字节上限） | 每层限 20 个 + 「…其余 N 个」 |
| 【低】`depth` 死分支 / 静默回落；wiki 到非 md 或目录目标口径与普通链接不一致 | 清理死分支；wiki 未命中文档时按 file 兜底、并补目录形式候选（`<x>/README.md` / `<x>/index.md`） |
| 【低】口径文档偏差（slug 规则、report 的「联邦外引用」未实现） | 本文件 D3 / D5 已按实现改写 |
| 【漏项】接线计数残留 3 处、README 示例数字、测试缺口 10 项 | 计数已修（ARCHITECTURE-REUSE ×2、HOST-PACKAGES、双语 README）；README 示例标注快照时间；测试补 7 项（图片/定义跳过、root 相对、wiki 非 md/目录/断链、排除与 BOM/CRLF、入口启发式、入口零入边、候选顺序）+ 修掉 1 处恒真空断言 → **36 例** |
| 【P4】内部边仅 2 条 = 漏本仓主导引用形态（行内代码里的路径，实测 1368 处高置信） | **判定：本轮不做**（条目枚举的是 Markdown 链接；新增 `kind:"ref"` 属能力扩展）。证据与最小改进方案写进 `md-map/docs/BACKLOG.md` #1（优先级提到「有依据」并给出 report 增列口径），README 边界同步说明「这类引用不计入边，故内部边 / 孤儿 / 被引数字偏小」 |

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理；其余条目重编（usage 口径 → #1，命令模板终态 → #2，executor 隔离 → #3，STATUS 对齐 → #4）；§1 索引 / §2 顺序依据 / §3 里程碑同步。
- **残余**：① 挂进 fff profile 属仓库外改动，需用户批准（构建产物 + 测试 + 对仓库自身的真机索引已完成）；② 会话内生效确认依赖上一步与重启 TUI；③ 模块待办 `md-map/docs/BACKLOG.md` #1（行内代码路径引用 → `kind:"ref"`）与 #2（列表内 4 空格围栏 / 跨行 code span）；④ `docs/STATUS.md` 无 md-map 行（按约定由用户择时更新，或由「STATUS 对齐现状」条目承载）。
- 本追踪文档移入 `docs/archived/`。
