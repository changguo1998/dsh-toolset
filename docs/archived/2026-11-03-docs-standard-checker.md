# 文档检查器 `dev/standard/` 与 `check:docs`

> 接取条目: `docs/BACKLOG.md` #1（2026-11-03 开工）
> 层级: 项目级

## 计划改动文件清单

| 文件 | 作用 |
| --- | --- |
| `dev/standard/index.mjs` | 入口: 遍历仓库、跑全部规则、按规则汇总并决定退出码（`--all` 打印全部命中） |
| `dev/standard/rules.mjs` | 规则数据: 36 个符号白名单与 20 条变体映射、术语表（运行时解析 `docs/GLOSSARY.md`）、界面旧称与豁免口径 |
| `dev/standard/markdown.mjs` | Markdown 文本抽取（去围栏 / 行内代码 / 链接地址 / HTML 注释 / front matter，保留行号）与表格列数解析 |
| `dev/standard/links.mjs` | 相对链接与锚点解析、标题 slug 归一 |
| `dev/standard/ts-comments.mjs` | `.ts` 注释抽取（只取注释文本，带行号） |
| `dev/standard/json.mjs` | 两个 JSON 的字段与路径检查（`package.json` / `tsconfig.json`） |
| `dev/standard/README.md` | 用法、规则清单、豁免与「只报不改」口径 |
| 根 `package.json` | 新增 `check:docs` 脚本（`node dev/standard/index.mjs`） |
| `docs/BACKLOG.md` | 条目标进行中、关闭移除 |

## 调研

- 规则来源: `docs/archived/2026-10-28-history-cleanup.md` §2.3 与 §3.9。§2.3 划定四类文件的检查面（Markdown / `.ts` 注释 / `package.json` / `tsconfig.json`），§3.9 给出符号、注释、术语、引用与数量的具体口径。
- 一处冲突: §2.3 写「Markdown 查符号变体与全角标点」，§3.9 与 `AGENTS.md` 都写明「中文标点照写，检查器不查标点」。以后者为准（`AGENTS.md` 是现行规范），标点规则不实现，记入偏差。
- 术语表结构可解析: `docs/GLOSSARY.md` 的 `## 需要替换` 是「旧称 | 应当使用 | 条件与例外」三列表，§「保留」表不进规则；解析 GLOSSARY 而不是另抄一份规则，保证「规则与 GLOSSARY 对齐」是结构性的。
- 存量差异: 界面旧称（`活动区` / `历史区` / `系统状态区` / `对话区` / `交互区` 等）在对齐前约 280 处，属条目 #4 的清理面；若一律按错误处理，`check:docs` 在本条关闭时无法退出 0。故按严重度分两档：`error` 立即门禁，`warn` 只计数不失败；界面旧称初始为 `warn`，条目 #4 修完后改回 `error`。
- 宿主面豁免: `docs/host/` 整目录不参与术语与路径检查（`AGENTS.md` 定它不参与变更流程），只参与符号检查。
- `main` / `types` 指向 `dist/`，而 `dist` 不提交；存在性检查改为「由 `dist/src/x.js` 反推源文件 `src/x.ts` 是否存在」，避免要求先构建。

## 决策

1. 零依赖、纯 Node 标准库；所有文件都是 `.mjs`，与 `dev/coverage/*.mjs` 同风格，不参与构建与发布。
2. 规则按「文件类型 × 检查族」实现，共 16 条规则，每条有稳定 id、严重度与一句话说明；输出按规则汇总，默认每条规则只打印前 20 条命中，`--all` 全打印。
3. 严重度两档：`error` 让进程退出 1，`warn` 只计数；存量未清的口径（界面旧称）走 `warn`，并在 `dev/standard/README.md` 与规则表里写明何时改回 `error`。
4. 文本口径: 行内代码、围栏代码块、链接地址、HTML 注释、front matter 不参与检查；其余正文逐行保留行号。
5. 只报不改: 检查器不写任何文件；命中即打印 `文件:行` 与原文片段，改动由人做。

## 实现记录

- `dev/standard/` 六个模块: `index.mjs`（遍历 + 汇总 + 退出码）、`rules.mjs`（符号白名单与变体映射、GLOSSARY 解析、豁免）、`markdown.mjs`（文本抹除与表格列数）、`links.mjs`（相对链接与标题 slug）、`ts-comments.mjs`（注释抽取）、`json.mjs`（两个 JSON）。
- 规则 16 条（`dev/standard/README.md` 有表）：符号变体 / emoji、术语旧称（`term.replace` 错误档、`term.interface` 警告档）、包与插件数量断言、断链（`link.file` 错误、`link.anchor` 警告）、表格列数、注释简写路径与失效路径、`package.json` 结构、`tsconfig.json` 结构。
- 退出码: 默认有错误才退出 1；`--strict` 警告也算失败；`--rule <id>` 只看一条规则且该规则有命中即退出 1（供条目 #4 这类专项验收）；`--all` 不按规则截断命中。
- 根 `package.json` 增 `check:docs` 与 `check:docs:strict`；`AGENTS.md` 命令段补一行。
- 为让错误档在落地当天为 0，顺带修了三处真实偏差（都记在下面偏差里）: `TUI/docs/design/NOTICE-LEVELS.md` 三行表格与 `TUI/docs/COMMANDS-SPEC.md` 一行表格的单元格内裸 `|`（mdformat 会把转义写回成裸 `|`，故改为用行内代码包住整段，表格列数同时恢复正常）、`TUI/src/app/adapter/dsh.ts` 一处注释里的 emoji 加反引号。

## 测试与证据

- `pnpm run check:docs`: 110 篇现行 Markdown / 884 个 `.ts`，规则 3 项有命中，错误 0 / 警告 840，退出 0。
- `pnpm run check:docs:strict` 退出 1（警告档存量存在，符合设计）。
- 反向验证（临时夹具，跑完已删）: 夹具文档与 `.ts` 命中 `symbol.variant` / `symbol.emoji` / `term.replace` / `term.interface` / `count.packages` / `count.plugins` / `link.file` / `table.columns` / `comment.path-shorthand` / `comment.path-missing` 十条规则；`tmp/json-probe` 夹具命中 `pkg.structure` 5 条与 `tsconfig.structure` 5 条。
- 清零过程: 首轮跑出 878 错误，逐条区分真实偏差与规则误报：删掉 `.pi-glla` 评审产物与 `archive/` 的扫描、链接扫描跳过行内代码、表格只认顶格表格、`main` / `types` 反推源文件修两个解析 bug、数量断言只认「本仓」口径与规范句式、符号检查按行内代码与符号表文件豁免，最终错误档归零。
- 守成: `pnpm -C TUI run check` 0、`pnpm -C TUI run test` 1829 例全过、全仓 `pnpm run check` 0（改动只涉及文档与注释）。

## 偏差

1. **不查标点**（§2.3 写「符号变体与全角标点」，§3.9 与 `AGENTS.md` 写「中文标点照写，检查器不查标点」）。按后者实现，`dev/standard/README.md` 与追踪文档都注明。
2. **规则总数由 16 条收敛到实际启用的 12 类**：`pkg.structure` / `tsconfig.structure` 各自内含多条检查，汇总时按 id 聚合；`dev/standard/README.md` 列的是 12 行规则表。
3. **警告档是有意的存量基线**：界面旧称 192 处属 `docs/BACKLOG.md` #1；`.ts` 注释简写路径 588 处与失效路径 60 处已登记为 `docs/BACKLOG.md` #2（清完后把这两条规则改回 `error`）。这些不是误报，检查器按「错误档零命中、警告档计数」验收。
4. **归档不查**（条目原文「只查现行文档, 不改归档」），与 §2.3「符号查全部 496 篇归档一并归一」不同：归档符号归一未做，若将来要做另开条目。
5. **附带修了 4 行表格与 1 行注释**（见实现记录），超出「`dev/standard/` + 根 `package.json`」的改动位置，理由是不修就无法让错误档为 0；`TUI/docs/design/NOTICE-LEVELS.md` 与 `TUI/docs/COMMANDS-SPEC.md` 的表格是真实缺陷（渲染出多余列）。
