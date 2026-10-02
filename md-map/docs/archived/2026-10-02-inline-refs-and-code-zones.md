# 行内代码路径引用（`kind:"ref"`）+ 代码区两类漏判（接取条目：`md-map/docs/BACKLOG.md` #1 #2）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

1. **#1 `kind:"ref"`**：本仓文档大量用行内代码写路径（如 `` `docs/BACKLOG.md` ``，子代理实测 1368 处），而现只识别 Markdown 链接 → 内部边仅 2 条、孤儿 172，`orphans` / `impact` / `topBacklinks` 基本无信息量。新增 `kind:"ref"`：只计能解析到**索引内文档**的行内代码 token、名字型多解跳过、**不计入断链**（示例路径不该变噪声），默认纳入 backlinks / impact，report 增「另有 N 条行内代码路径引用」。
1. **#2 代码区漏判**：① 列表 / 引用内 **4 空格缩进围栏**（`fenceLines` 的 `^ {0,3}` 按行首算，未计容器缩进）被当正常行 → 里面的 `[[W]]` 被当 wiki 链接；② **跨行 code span**（反引号开在多行前、闭在后续行）只处理单行。

## 调研（2026-10-02）

- `links.ts`：`stripInlineCode(line)` 单行正则 `/`[^\`]\*\`/g\`；\`fenceLines(lines)\` 自制 CommonMark 围栏状态机（\`^ {0,3}\`、闭合串不短于开启串）；\`scanWikiLinks(lines, skipLines)\` 先 skip 围栏行再 strip 行内代码；\`wikiCandidates\` / \`resolveDocPath\` / \`candidateDocPaths\` 是既有的「目标 → 索引内路径」解析器（含 root 相对与源目录相对两口径）。
- `indexer.ts`：`classify({from,target,line,anchor,text,wiki})` 把目标分类为 `internal` / `wiki` / `file` / `external` / `broken`；`broken` 只在 `missing-file` / `outside-root` 时 push；backlinks 由边统计（`to` 有值的边即计入）。
- `types.ts`：`MdEdgeKind = internal | wiki | file | external | broken`。
- md-logic 的 `blocks` 只报顶层块（嵌套围栏不在其中）——这是 `fenceLines` 自带状态机的原因；本条目**不**要求 md-logic 暴露嵌套块（改动面更小）。
- `readInlineCode`… 无此函数；`stripInlineCode` 是唯一行内代码处理点，被 `scanWikiLinks` 调用（也用于其它扫描？实现时确认调用点，保持导出兼容）。

## 决策

- **D1（容器缩进跟踪）**：`fenceLines` 内置容器缩进栈：逐行扫描时维护 `containers: number[]`（各层容器的内容缩进）；遇到列表标记（`^(\s*)([-*+]|\d{1,9}[.)])\s+`）入栈 `缩进 + 标记宽度`，遇到引用标记（`^(\s*)>\s?`）入栈 `缩进 + 2`；行缩进小于栈顶则弹栈。围栏判定改为「相对容器缩进 ≤ 3」（`indent <= base + 3`，base = 栈顶或 0）。**保持既有导出签名不变**（`fenceLines(lines) => Set<number>`）。
- **D2（跨行 code span）**：新增 `stripInlineCodeAcross(lines: string[]): string[]`（行状态机）——未闭合反引号时把该行截断到开启处、后续行整行视为代码直到出现等长闭合串（闭合串后同行的内容继续参与扫描）；`scanWikiLinks` 改用它（先按 D1 的 `skipLines` 跳过围栏行）。`stripInlineCode` 保留导出（单行语义，供其它调用点/测试）。
- **D3（行内路径 token）**：新增 `scanInlineRefs(lines, skipLines): { token: string; line: number }[]`——取行内代码片段（复用 D2 的剥离结果，即**只看代码片段内容**），逐片段按路径形态筛选：无空白、含 `/` 或匹配 `\.md$`；去首尾 `/`；排除 `http(s)://` 与 `-`/`#` 开头（命令行 flag、锚点）。同一行去重。
- **D4（解析口径）**：`classify` 增 `ref?: boolean` 分支：按 `wikiCandidates(from, token)` 取**索引内**命中（两口径：root 相对 → 源目录相对；无扩展名时试 `<x>.md` / `<x>/README.md` / `<x>/index.md`）；命中 **>1 个不同文档** → 跳过（名字型多解，如 `README.md`）；命中 1 个 → `kind:"ref"` + `to`；0 个 → **不产边**（不计断链、不进 `broken`）。
- **D5（口径与呈现）**：`MdEdgeKind` 增 `"ref"`（`MdEdge.to` 有值 → 自动进 backlinks / impact / `topBacklinks`）；report 增一行「另有 N 条行内代码路径引用（kind=ref，不计断链）」（N = 全部 ref 边数）；`orphans` / `broken` 语义不变（ref 不算断链）。README 的边种类说明与工具描述同步。
- **D6（验证）**：单测——① 容器缩进围栏（列表内 4 空格围栏里的 `[[W]]` 不计；列表内围栏闭合后同层正常行仍计）；② 跨行 code span（`` `a ⏎ [[W]] ` `` 内的 `[[W]]` 不计，闭合后同行 `[[X]]` 仍计）；③ ref 命中（root 相对 / 源目录相对 / 无扩展名目录形态）；④ ref 多解跳过（两个同名 `README.md` 命中 → 无 ref 边）；⑤ ref 未命中不计断链（`docs/不存在.md` → 无边、`broken` 为空）；⑥ report 行计数；⑦ 既有 36 例不回归。dist 级真跑一次（本仓自索引：ref 边数 > 0、`orphans` 显著下降）。
- **D7（不做）**：不要求 md-logic 暴露嵌套块；不做行内代码里的**锚点**引用（`doc.md#x` 只在 `.md` 前缀命中时按路径处理）；不把 ref 计入 `broken` / `missing-file`；不动 `file` / `external` 语义。

## 计划改动文件清单

- `md-map/src/links.ts`（D1 / D2 / D3）、`md-map/src/types.ts`（`"ref"`）、`md-map/src/indexer.ts`（`classify` ref 分支 + stats）、`md-map/src/render.ts` 或 report 渲染处（D5 行）、`md-map/src/tools.ts` + `README.md`（边种类与描述）
- `md-map/tests/{links.test.ts, indexer.test.ts 或现有同名}（新增用例）+ 既有 36 例回归`
- `md-map/docs/BACKLOG.md`（两条标进行中 → 关闭）、本追踪文档

## 实现记录

| 文件 | 改动 |
|---|---|
| `md-map/src/links.ts` | ① `fenceLines` 重写：**容器缩进栈**（列表标记宽度 / 引用 +2；空行不弹栈，行缩进小于栈顶才弹），围栏判定改「相对容器 ≤3 空格」；② `stripInlineCodeAcross(lines)`（跨行 code span 状态机，等长反引号闭合）+ `inlineCodeSpans(lines)`；③ `scanInlineRefs(lines, skipLines)`（只取代码片段内容、路径形 token、同 (行,token) 去重）；④ `scanWikiLinks` 改用跨行剥离 + 围栏行掩码（先掩码再剥，避免围栏反引号污染状态） |
| `md-map/src/types.ts` | `MdEdgeKind` 增 `"ref"`；两处 stats 增 `refEdges` |
| `md-map/src/indexer.ts` | `classify` 增 `ref?: true` 分支（`wikiCandidates` 取索引内命中，**唯一**才成边；0 = 不产边不计断链、>1 = 多解跳过）+ `scanInlineRefs` 扫描接线 + `refEdges` 统计（ref 边计入 `edges` 与 backlinks） |
| `md-map/src/query.ts` / `render.ts` | report 增 `refEdges` 与一行「另有 N 条行内代码路径引用（kind=ref，已计入内部边，不计断链）」 |
| `md-map/tests/refs.test.ts`（新） | 4 例：容器缩进围栏（含 8 空格缩进代码块不算围栏）、跨行 code span（闭合后同行仍计）、ref token 提取口径、indexer 级（命中 / 多解跳过 / 未命中不计断链 / `refEdges` 与 backlinks） |
| `md-map/README.md` | kind 表增 `ref` 行、代码区识别口径改写、导出清单与例数（36 → 40） |

## 测试与证据（2026-10-02）

- 包内：`npm run check` exit 0、`npm run test` **40 例全绿**（改前 36；既有用例无回归）。
- **dist 级真跑（本仓自索引，204 文档）**：
  - 改前基线：内部边 **2**、孤儿 **172**（条目描述的数字）；
  - 改后：`内部边 1432`（其中 `另有 1430 条行内代码路径引用（kind=ref`），孤儿 **96**，文件引用 0 / 站外 18（未误伤既有口径）；
  - 命令：加载 `md-map/dist/src/index.js` → `apply` → `action:index root=本仓` → `action:report`（见关闭前复跑）。
- 全仓：`npm run check` / `build` / `test` 全绿（20 包）。

## 审阅（子代理，2026-10-02）——结论：**有条件通过**

收益成立（自索引内部边 2 → 1404、孤儿 172/180 → 96、topBacklinks 有信息量）；必修项全部处置：

| 审阅发现 | 处置 |
|---|---|
| 【必修】D2 跨行 span 无段落边界：孤立反引号吞掉后续段落（本仓 4 篇、追踪文档自身产出 4 条**假断链**，broken 1 → 5） | 改**按段落**处理：段内无等长闭合串 → 该段按**字面量**（CommonMark 口径）；处处补 `[[W]]` 段内/跨空行两例 |
| 【必修】D1 只覆盖 \`\`\`：容器内 `~~~` 漏判（产出假 wiki 边）；标记后 ≥5 空格按 4 计引入**回归**（缩进代码块被当围栏吞行） | 围栏判定先**剥离容器前缀**（`>` + 列表标记 + 1..4 空格填充；≥5 按 1 计）再看相对缩进；`~~~` 同口径；补 K/N 两例回归测试 |
| 【必修】D3 写了「去首尾 /」未实现 → 527 个尾斜杠 token 全丢（其中 53 个可唯一解析） | 已实现 `trim().replace(/^\/+|\/+$/g,"")` |
| D4「>1 即跳过」把 root/源目录歧义（4/5 例）一并丢弃，且与 wiki 同串不同解 | 改「**源目录形态优先**，否则候选序首个」；测试断言 `b.md` → `docs/b.md` |
| D5 呈现：`refEdges` 缺字段时渲染 `undefined` | `render.ts` 加 `?? 0` |
| 漏项：README:86 仍写「不覆盖行内代码里的路径」与 :30 新行自相矛盾、:68 快照过期、报告行未提新计数、工具描述未提 ref | 全部已改（README 边界段改写 + 快照与报告行更新 + 工具描述补 ref 口径） |
| 未修（转条目）：未命中 token 完全不可见；ref 计入 backlinks 稀释 impact（`callers(docs/BACKLOG.md)=146` 全为 ref）；`summary()` 未含 `refEdges` | 模块 BACKLOG #1（三条合并：report 增「未解析 token 计数」+ callers/impact 加 kind 过滤或分开计数 + `summary` 对称暴露） |

## 关闭记录

- 两条条目（`md-logic`… 本包 #1 #2）从 `md-map/docs/BACKLOG.md` 清理；模块现存 #1（上表最后一行）+ 原有 #3（代码区边角，编号顺延）。
- **最终证据（dist 级、本仓自索引、修复后重测）**：`docs=204 / edges=1404 / refEdges=1402 / broken=1`，report 行「另有 1402 条行内代码路径引用」、孤儿 96（接入前 197 文档 / 2 内部边 / 1 断链 / 孤儿 172；审阅期实测 180）。`broken` 回落到 1 即 D2 段落口径修复的直接证据（修复前含追踪文档自身的 4 条假断链）。
- 残余：① 会话内生效需重启 TUI（dist 已重建）；② 真机 profile 未挂载实测；③ 容器围栏仍自带状态机（未改成 md-logic 递归暴露嵌套块——D7 未变，但审阅建议在含 `~~~`/懒续行/引用内缩进代码块的文档上再审一次）。
- 本追踪文档移入 `md-map/docs/archived/`。
