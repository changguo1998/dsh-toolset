# 节级内容 hash 锚点（接取条目：`md-logic/docs/BACKLOG.md`「节级内容 hash 锚点（漂移盲区）」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给按节改写补一层**内容锚点**：现有锚点是「标题 + 行范围」，挡不住「同标题 + 同范围但节体 / level 已被外部改动」（实测 4 组反例）。做法：`sha256(该节原文行) 前 8 位 hex`——`structure` 渲染附 `·#xxxxxxxx`；`replace` 的 edits 增可选 `section_hash`（不符 → `section_stale`，**additive**、不动既有调用语义）；并说明 / 收紧读→rename 的 TOCTOU。

## 调研

- 校验现状（`src/edit.ts:188-320`）：`replaceSections` ⓪ 越界 → ① 「同标题 + 精确行范围」（`section_missing` / `section_drift`）→ ①.5 content 首行标题守卫 → ② 重叠 → ③ 自下而上应用；比对只涉及 `title` / `line` / `endLine`（`:231-246`），**不读节体**。
- 读面：`structure` action 返回 `sections: FlatSection[]`（`src/tools.ts:301-311`）+ `doc`；渲染 `renderStructure(doc, depth)`（`src/render.ts:25-38`）**只吃 doc、拿不到原文** → hash 必须进 value（渲染只由 value 决定，见镜头测试口径）。
- 写盘：`replaceSectionsFile`（`src/edit.ts:330-404`）读原文 → 纯函数 → 临时文件 + `rename`；读写之间无任何并发校验（TOCTOU）。
- 既有测试口径：`tests/edit.test.ts:6-7` 明确「`content: "x"` 填充同时是**校验优先级承重测试**（漂移 / 缺失 / 越界先于 `content_invalid`）」；`tests/tool.test.ts:126-127` 用 `^L6-34 h1 标题一$` 精确断言 structure 渲染（加后缀需同步改）。
- `flattenSections` 也被 `md-map/src/links.ts:48` 消费（只读 level / title / line / endLine）→ `FlatSection` 加可选字段是 additive。

## 决策（待审阅）

1. **hash 口径**：`sectionHash(text, line, endLine)`（落 `src/edit.ts`，复用其 `normalize`）= `sha256(节原文行含端点以 \n 连接)` 前 8 位小写 hex；BOM / `\r\n` 不参与（与 parse 同归一，风格翻转不算内容改动）；`structure` 在读到的内容上算，`replace` 对**重新读取**的当前内容复算比对。
1. **structure 面**：`FlatSection` 增可选 `hash`（仅 structure 输出附带）；`renderStructure(doc, depth, sections?)`（第三参可选 = 带 hash 的行）渲染为 `L6-34 h1 标题一 ·#a1b2c3d4`；JSON 的 `sections[].hash` 同值（渲染只由 value 决定）。
1. **replace 面**：`SectionEdit.sectionHash?` ← 工具入参 `section_hash`（可选；`parseEdits` 校验为非空字符串）；比对位置在 ① 内（title → range → **hash**），不符 → 新码 **`section_stale`**（details 带 `{line, endLine, hash}` = 当前值）；比对大小写不敏感（trim + lower）；**不带 hash 的既有调用语义完全不变**。
1. **TOCTOU**：`replaceSectionsFile` 读盘时记 `ino:size:mtimeMs` 签名，写临时文件前复 stat 比对，不符 → 新码 **`file_changed`**（拒写、目标字节不变）；README 写明「尽力而为 + 残余窗口 = 临时文件写入 → rename（毫秒级）」。该竞态路径**无注入点、无法单测**（追踪文档记录；不带 hash 的普通写不受影响）。
1. **文案 / 文档**：`renderReplace` 下一步按码分派补 `section_stale` / `file_changed`（重新 structure 取 `·#hash` 与范围）；工具描述、README 的 structure / replace / 优先级 / 三方分工段同步。
1. 不做：不给 `section_hash` 加强格式校验（只比对）；不把 hash 写进 `MarkdownDocument` / parse（避免 md-map 全量索引为每个节付哈希成本）；不用「读→rename 复算 hash」替代 stat 签名（成本更高、收益相同）；不动 `content` 首行标题与 `heading` 一致性（BACKLOG #1 另议）。

## 规划

- 计划改动文件清单（**只改这些**）：`md-logic/docs/BACKLOG.md`（状态）、本追踪文档、`md-logic/src/{edit,render,tools,query?}.ts`（query 仅在需要时改 `FlatSection` 定义——预计加字段）、`md-logic/tests/{edit,tool}.test.ts`、`md-logic/README.md`。
- 验证：`md-logic` 包 `check` / `build` / `test`；撤修复必红（撤 hash 比对 → `section_stale` 用例红；撤 structure 附 hash → 渲染用例红）；根 `npm run check`。
- 明确不做：不动其它包；不顺手改相邻代码。

## 实现记录（2026-10-04）

- 子代理只读审阅（决策后、实现前）：通过；修订——① TOCTOU 比对点改到 **rename 前**（写临时文件后复 stat；不符走既有清理路径）并抽 `sameSignature(a, b)` 纯函数（竞态本身无注入点，抽纯函数保证可验证性）；② `section_hash` 加**轻量格式校验**（trim + 剥引号 / 反引号后须 `^[0-9a-f]{8}$`，否则 `edits_invalid`）——否则抄错位数会被误报 `section_stale`，白烧一轮 structure；③ **不采用逐行 trim** 口径（会让行首缩进这类真实改动静默通过，安全回归），保持原文行口径并补空白敏感用例钉死契约；④ details 与 `section_drift` 对齐用**数组** `[{line, endLine, hash}]`；⑤ `structure` 必须把 hash 放进 value 并把（带 hash 的）`sections` 传给渲染（渲染只由 value 决定）；`renderStructure` 对无 hash 的行不渲染后缀（避免半带混面）；⑥ README 优先级串补 `section_stale`；`renderReplace` 的三元改为按码分派（stale / file_changed 一族）。
- 代码：`edit.ts`（`sectionHash` / `sameSignature` / `FileSignature` / `SectionEdit.sectionHash` / `section_stale` / `file_changed` / TOCTOU 复核）、`query.ts`（`FlatSection.hash?`）、`render.ts`（`·#hash` 后缀 + 分派）、`tools.ts`（structure 附 hash、value 面补 `sections`、`parseEdits` 改为「edits | 错误文案」并校验 `section_hash`、schema / 描述）、`index.ts`（导出 `sectionHash` / `sameSignature` / `FileSignature`）。
- 未做（记录 `记账`）：TOCTOU 的**第二道**（带 `section_hash` 时复算目标节 hash）——签名已覆盖绝大多数外部改动，残余 = 「同尺寸且同 mtime 粒度的改写」，README 已明示「尽力而为、不是完整事务」；如后续需要再单开条目。`content` 首行标题与 `heading` 的一致性仍属 BACKLOG #1（另一裁定）。
- 附带修正：README `:104` 历史残片「。做）。」删除（一行记录，未单开条目）。

## 测试与证据

- `md-logic` 包 `check` / `build`：exit 0；`npm test`：55 pass / 0 fail（新增 5 条：`sectionHash` 口径（风格无关 / 空白敏感 / 覆盖子节）、`replaceSections` 盲区四例（节体 / 缩进 / 层级 / 祖先节）、`sameSignature` 正反例、连续两次写真不误报 `file_changed`、工具面 `section_hash` 端到端（旧 hash 拒写且字节不变 → 重取新 hash 放行，含引号容错）；`structure` 渲染断言与 `edits_invalid` 用例同步扩展）。
- 反向验证（撤修复必红）：撤 hash 比对 + 撤 structure 附 hash + 撤 hash 格式校验 → 4 条用例红（盲区四例 / structure 渲染 / 工具面 replace 参数校验 / 端到端）；恢复后复绿（55 pass）。
- 真机未做（沙箱无真机 md_logic 调用场景）：`replace` 的 hash 路径在工具面端到端用例里已真实读写临时文件系统（等价于工具面行为）；未验证项 = 宿主会话中的实际调用链。

## 收尾

- 回写：`md-logic/README.md`（structure / replace 渲染口径、节内容 hash 锚点段、TOCTOU 复核段、三方分工、库面导出、输出示例、测试计数 55、残片笔误）。
- 新发现问题：无（审阅提出的第二道复核按「未做」记账，不单开条目）。
- 本文件移入 `md-logic/docs/archived/`；`md-logic/docs/BACKLOG.md` 清理所接条目（仅留未完成项，不重编号）。
- 临时产物：无。
