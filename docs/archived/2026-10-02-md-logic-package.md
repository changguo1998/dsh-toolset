# 新建 `md-logic` 插件（Markdown 逻辑结构，接取条目：`docs/BACKLOG.md`「新建 markdown 逻辑结构插件（对标 `ast-tools`，单文件粒度）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给 Markdown 一份「语法 / 块级结构」能力：标题层级、列表、表格、代码块、引用、链接、frontmatter，输出**带行范围的结构树**（供模型按节读、按节改），单文件粒度、以 `ast-tools` 为模板建新包 `md-logic/`。

边界（用户 2026-10-02 裁定）：

- 与已完成条目「Markdown 结构视图」（`fs_digest`）**并存不合并**：`fs_digest` = 轻量通用入口（只读、零依赖、快览、与三模式统一）；`md-logic` = 专用深能力（精确解析 / 查询 / 可选改写）。
- 只做 Markdown；PDF 与纯文本不做。
- 包名 `md-logic`（原名 `md-tools`，用户改名）。

## 调研（2026-10-02）

- **入口参照**：`ast-tools/`（`package.json` 的 `dsh.bundle.patch` → `./cordis.patch.yml`、`main: dist/src/index.js`、`tsconfig.json`、`src/{index,tools}.ts` + `tests/` + `README.md`）；`fs-digest/` 的 `src/render.ts`（渲染单点）。
- **行范围口径现状**：`fs-digest/src/outline.ts` 的 `scanMarkdown()`（2026-10-02 导出）已给出「节 = 标题行 → 下一个层级 ≤ 本节标题的前一行、尾空行不计、父子包含、depth 以下归最近输出祖先」的口径与块 kind（`frontmatter|code|table|list|quote`）。本条**复用其口径**（同文件两工具必须给同一组 L 区间，否则模型会绕晕）。
- **依赖政策**：本仓 18 包中 17 个零运行时依赖，两个例外——`session-channel` 引入 `redis`（外部依赖，`npm install` 落在包内 `node_modules`，profile 以 `link:` 引用后由 Node 解析到包内依赖，实测 profile 无 redis 目录也能加载），`code-map` 以 `link:../ast-tools` 复用本仓包。→ **外部依赖有先例、可行**，但应尽量少。
- **接线面**（新增包必须同步）：根 `package.json` 的 `check` / `build` 链（逐包 `npm --prefix`）、`scripts/install.sh:26 canonical_pkgs`、`scripts/test-parallel.sh:17 default_pkgs`、`README.md` / `README.zh.md`（包清单 + 计数）、`AGENTS.md`（包清单）、`docs/WORKFLOW-STANDARD.md:11`（模块定义）、`docs/host/HOST-PACKAGES.md:482`（「本项目 18 个包」）、`docs/ARCHITECTURE-REUSE.md:3`（口径计数）。
- **既有缺口（不改，记录）**：`scripts/test-parallel.sh` 的 `default_pkgs` 已漏 `session-title-cutoff` 与 `command-template`（与本条无关的既有问题）；`docs/host/HOST-UPGRADE-0.2.0-rc.2.md` 的「17 个包」是升级当时的历史口径，不改。

## 决策

- **D1（解析选型）**：用 **`marked`** 作解析器（唯一新增运行时依赖，`marked` 自身**零传递依赖**）。
  - 备选与取舍：`remark`/`unified` 原生带 `position`（含 offset），但传递依赖 ≈ 30-40 个，对「本仓插件零依赖」的常态冲击过大；纯自研（正则）无法覆盖嵌套列表 / 表格转义 / setext 标题 / HTML 块等 CommonMark 边角，做不出条目要求的「精确解析」。
  - 行范围实现：`marked.lexer()` 的块级 token 按文档顺序给出 `raw`，按 `raw` 逐块推进游标即得**精确行范围**（块级 `raw` 拼接等于原文，测试里断言该不变量）；**口径与 `fs-digest` 对齐**并用同一 fixture 交叉核对。
  - `frontmatter`：`marked` 不认，按 `fs-digest` 的口径自处理（仅文件首行 + 有界配对 + 内部只含 YAML 键 / 注释 / 空行），区间内不产块、不产标题。
- **D2（结构模型）**：`parseMarkdownDocument(text)` → `{ frontmatter?, sections: SectionNode[], blocks: MdBlock[], links: LinkRef[], stats }`：
  - `SectionNode{ level, title, line, endLine, children }`，范围口径同 `fs-digest`（父子包含）。
  - `MdBlock{ kind: "list"|"table"|"code"|"quote"|"html"|"hr"|"frontmatter", line, endLine, section?, … }`；`list` 带 `items` 与 `depth`（嵌套层）、`table` 带 `rows` / `cols`（不含表头分隔行）、`code` 带 `lang`、`quote` 带 `depth`。kind 命名沿用 `fs-digest` 的五个 + `html` / `hr`。
  - `LinkRef{ kind: "link"|"image"|"definition", text, href, title?, line, section? }`——引用式链接定义（`[x]: url`）与行内链接、图片都收；这是 `fs_digest` 没有的面。
- **D3（服务面）**：`parseMarkdownDocument` / `flattenSections` / `queryBlocks(doc, {kind?, section?, pattern?, limit?})` / `listLinks(doc, {kind?})`（纯函数，零宿主依赖，可被 TUI / 其它插件消费）。
- **D4（模型面）**：注册**一个**模型侧工具 `md_logic`，`action` 分派 `structure`（节树 + 行范围）/ `blocks`（按 kind / 节 / 行范围过滤）/ `links`（链接与定义清单）。渲染：紧凑文本、行号 **1 基**、每类上限 80 行带省略标记；`output.schema`（object 根）+ **全函数** render（`ast-tools` 那批的教训）；schema 不暴露内部参数。
  - **描述里互相指路**（条目硬要求）：本工具描述指向 `fs_digest` / `read` / `hash_edit`；**并给 D8 开一处最小例外**——`fs-digest` 的工具描述与 README 边界各加一句指向 `md_logic`（否则只是单向指路，不满足条目「互相」）。
  - 不注册与 `fs_digest` 重名的工具；`md_logic` 不重复输出整篇大纲以外的内容（`structure` 默认 `depth: 3`）。
- **D5（改写面本条不做）**：条目标注「可选改写」；安全改写需要锚定语义（`hash-edit` 先例：读后改前 + 漂移检测 + 整批原子拒绝），本条的 3-4 h 预算放在**解析 + 查询 + 模型面**上。改写在 `md-logic/docs/BACKLOG.md` 立模块条目（按节替换 + 锚点安全），并把取舍写进 README。
- **D6（包骨架与接线）**：以 `ast-tools` 为模板建 `md-logic/`（`package.json` / `package-lock.json` / `tsconfig.json` / `LICENSE` / `cordis.patch.yml` / `src/` / `tests/` / `README.md` / `docs/`）；接线 9 处（根 `package.json` 两条链、`install.sh`、`test-parallel.sh`、双语 README 的表 + 计数 + 目录树、`AGENTS.md`、`WORKFLOW-STANDARD.md`、`HOST-PACKAGES.md`、`ARCHITECTURE-REUSE.md` 的 §0 表 / §2 边界 / §3 复用面）。
  - **顺带补齐既有链缺口**（评审建议，本次本来就在改这两个链）：根 `package.json` 的 `check` / `build` 各缺 `command-template`，`test-parallel.sh` 缺 `session-title-cutoff` + `command-template` → 一并补齐（此前 `npm run check` / `npm run test` 永远不覆盖这三个包）。
- **D7（挂载到 fff）**：仓库外改动，需用户批准（与上批 profile 同样的提权）；本条先保证「构建产物 + 测试 + 本地真跑」，落 fff 单独征询。
- **D8（不做）**：不做 PDF / 纯文本；不改 `fs-digest`；不改其它包；不引入第二个解析器；不做 Markdown 渲染（只做结构，不做 HTML 输出）。

## 计划改动文件清单

- `md-logic/package.json`、`md-logic/tsconfig.json`、`md-logic/cordis.patch.yml`
- `md-logic/src/types.ts`、`src/parse.ts`、`src/query.ts`、`src/tools.ts`、`src/index.ts`
- `md-logic/tests/helpers.ts`、`tests/parse.test.ts`、`tests/query.test.ts`、`tests/tool.test.ts`
- `md-logic/README.md`、`md-logic/docs/BACKLOG.md`
- 接线：`package.json`（根）、`scripts/install.sh`、`scripts/test-parallel.sh`、`README.md`、`README.zh.md`、`AGENTS.md`、`docs/WORKFLOW-STANDARD.md`、`docs/host/HOST-PACKAGES.md`、`docs/ARCHITECTURE-REUSE.md`
- `docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）、本追踪文档

## 实现记录

| 文件 | 改动 |
|---|---|
| `md-logic/package.json` / `tsconfig.json` / `cordis.patch.yml` / `LICENSE` / `package-lock.json` | 新包骨架（`dsh.bundle.patch` → `cordis.patch.yml`；唯一运行时依赖 `marked@^18`；devDeps 与 `ast-tools` 同款） |
| `md-logic/src/types.ts` | 结构模型：`MarkdownDocument` / `SectionNode`（带 `endLine`）/ `MdBlock`（7 kind，含 `html`·`hr`）/ `MdLink`（link·image·definition）/ `FrontmatterInfo` |
| `md-logic/src/parse.ts` | `parseMarkdownDocument()`：BOM/CRLF 归一化 → frontmatter 识别（仅首行 + 有界配对 + 内部只含键/注释/空行，区间**置空保行数**）→ `Marked` 实例 lex → 偏移游标 + 行首偏移表二分 → 节树（父子包含、尾空行不计）+ 块 + 链接（行内按出现顺序消歧、`def` 块级定位） |
| `md-logic/src/query.ts` | `flattenSections` / `findSections` / `sectionAt` / `queryBlocks` / `listLinks`（纯函数） |
| `md-logic/src/render.ts` | 工具面文本渲染（1 基、范围折叠、每类 80 行预算 + 省略标记） |
| `md-logic/src/tools.ts` | `md_logic` 工具（action 分派 structure / blocks / links；参数校验先于磁盘 IO；`maxBytes` 读取守卫；`output.schema` + 全函数 render） |
| `md-logic/src/index.ts` | bundle 契约：`name` / `inject: ["tools"]` / `Config{maxBytes}` / `apply` + 全部库面导出 |
| `md-logic/tests/{helpers,parse,query,tool}.test.ts` | 34 例：frontmatter 正反例、节范围（跳级/连续/无尾换行/空文档/setext）、块（7 kind + 计数/嵌套/行列）、链接（三类 + 重复消歧）、口径锁定 6 例（与 fs-digest 的 5 类差异）、文本边界（BOM/CRLF/纯 CR/无尾换行/JSON 可序列化）、查询面、工具面（注册/契约/参数矩阵/读取守卫/渲染/形参顺序） |
| `md-logic/README.md` / `docs/BACKLOG.md` | README（模型工具 / 库面 / 解析选型 / 配置 / 示例 / **与 fs_digest 的口径差异** / 边界 / 依赖前置）；模块待办 #1 = 改写面（按节替换 + 锚点安全，未做） |
| 接线 | 根 `package.json`（check/build 链 + 补齐 command-template）、`scripts/install.sh`、`scripts/test-parallel.sh`（+ 补齐两个漏项）、`README.md` / `README.zh.md`（表 + 计数 + 目录树）、`AGENTS.md`、`docs/WORKFLOW-STANDARD.md`、`docs/host/HOST-PACKAGES.md`、`docs/ARCHITECTURE-REUSE.md`（§0 / §2 / §3） |
| `fs-digest` | 工具描述 + README 边界各加一句指向 `md_logic`（D4 的最小例外）；`fs-digest/docs/BACKLOG.md` 追加「口径差异记录在案（不做）」 |

## 测试与证据（2026-10-02）

- `md-logic` 包内：`npm run check` / `build` 通过；`npm run test` **34 例全绿**。
- 全仓：`npm run check` exit 0（19 包）、`npm run build` exit 0、`npm run test` **19 包全 OK**（TUI 1290 / herdr 35 / knowledge-base 57 / task-engine 62 / ast-tools 37 / **md-logic 34** / fs-digest 61 / goal-contract 35 / hash-edit 43 / metric-loop 35 / output-compress 45 / security-guard 37 / code-map 21 / context-report 42 / rule-engine 83 / symbol-normalizer 38 / session-channel 45 / session-title-cutoff 8 / command-template 13，fail 全 0）。
- **dist 产物真机核对**（加载 `md-logic/dist/src/index.js`，与宿主同一份编译产物；对仓库内真实文件 `md-logic/README.md`）：
  - `structure`：`Markdown 结构：94 行 / 8 节 / 9 块 / 1 链接` + `L1-93 h1 @dsh-toolset/md-logic` / `L7-19 h2 模型侧工具`（节行范围 ✓）。
  - `blocks`（kind=table）：`§L7 L11-15 table·3行×3列` ✓；`links`（pattern=marked）：`§L35 L37 link "marked" → https://marked.js.org/` ✓。
  - 相对路径按 `exec.agent.session.header.cwd` 解析 ✓（用例覆盖）。
- **与 `fs-digest` 的交叉核对**（同一 fixture 跑两个解析器）：范围口径一致，分歧 5 类（setext / HTML 块 / 缩进代码块 / 懒续行 / 新增 kind），实测数据写进 `md-logic/README.md` 的差异表。
- 会话内 `md_logic` 的生效确认需重启 TUI **且需先挂进 profile**（见残余）。

## 审阅（子代理，2026-10-02，实现前设计评审）

**结论：有条件通过** → 9 条问题 + 8 条漏项全部处置：

| 审阅发现 | 处置 |
|---|---|
| 【高】「raw 拼接 === 原文」错误（CRLF 下不成立；BOM 不剥） | 注释 / README / 追踪文档统一改为「归一化后文本」；实现本已归一化；新增纯 CR 与空白密集用例 |
| 【高】「与 fs-digest 同一组 L 区间」不成立（5 类分歧） | README 增「与 fs_digest 的口径差异」专节（含实测表与「何时用谁」）；测试改口径锁定（不断言相等）；`fs-digest/docs/BACKLOG.md` 立「记录在案（不做）」条目 |
| 【中高】「互相指路」与「不改 fs-digest」自相矛盾 | 明确开最小例外：`fs-digest` 描述 + README 各 1 句（本条目硬要求），记入 D4 |
| 【中】marked 全局单例可被同进程污染 | 改用 `new Marked({ gfm: true })` 实例 |
| 【中】接线既有缺口只记了一半 | 一并补齐根 `package.json`（`command-template`）与 `test-parallel.sh`（`session-title-cutoff` + `command-template`），并写进 D6 |
| 【中】计划文件清单不全（`render.ts` / `LICENSE` / lockfile） | 补齐清单；`ARCHITECTURE-REUSE.md` 增 §0 一行 + §2 边界一条 + §3 一行（不只改计数） |
| 【低】游标表述与 O(n·k) 行号查询 | 注释写清「字符偏移 + 行首偏移表二分」；实现改为一次建表 + 二分 |
| 【低】工具 schema 暴露内部参数 `patternLevelsOnly` | 删除 |
| 【低】`HOST-PACKAGES.md` 是生成物 | 已改（19 包 / 18 插件），并在本文件注明「升宿主重生成会回退」 |
| 【漏项】DESIGN.md 取舍 / 模块 BACKLOG / README 四段 / 根 README 目录树 / TUI COMMANDS / STATUS / 依赖幂等 / 检查前置 | 全部落地：不建 DESIGN 并在 README 写明理由、建 `md-logic/docs/BACKLOG.md`、README 补「口径差异 / 解析选型实测数字 / 输入归一化 / 依赖与前置」、双语目录树补行、`TUI/docs/COMMANDS.md` 与 `docs/STATUS.md` 不改（后者由 BACKLOG「STATUS 对齐现状」条目承载，已记于此） |

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理；其余条目重编（`md-map` → #1，usage 口径 → #2，命令模板终态 → #3，executor 隔离 → #4，STATUS 对齐 → #5）；§1 索引 / §2 顺序依据 / §3 里程碑同步。
- **残余**：① 挂进 fff profile 属仓库外改动，需用户批准（本条先保证构建产物 + 测试 + dist 真跑）；② 会话内生效确认依赖上一步与重启 TUI；③ 改写面（按节替换 + 锚点安全）落在 `md-logic/docs/BACKLOG.md` #1；④ `docs/STATUS.md` 的 md-logic 行由既有对齐条目承载；⑤ `docs/host/HOST-PACKAGES.md` 的包数改动在升宿主重生成时会回退。
- 本追踪文档移入 `docs/archived/`。
