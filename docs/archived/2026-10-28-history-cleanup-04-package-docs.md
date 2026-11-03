# 整理历史代码和文档: 阶段 4 包文档 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 完成　　开启: 2026-11-01　　关闭: 2026-11-01
本文件是阶段 4 的阶段追踪文档, 记录范围、批次、门禁与合并结论; 逐包执行清单在 34 份包追踪文档的「实现规划 / 包文档」节, 计划外的文件不改.

## 目标

把 34 份包 `README.md` 归并为六节, 15 份 `docs/DESIGN.md` 归并为四节, 命令统一为 `pnpm`, 修 7 条非归档断链, 去工具数与包数硬编码, 统一术语与界面名; 不改代码、测试与配置, 不改行为.

## 现状

- 34 份 README 目前 4 至 12 个二级标题, 首节写法 14 种; 15 个包有 `docs/DESIGN.md`, 26 个包有 `docs/BACKLOG.md`.
- 非归档断链 7 条: `agent-group/docs/DESIGN.md`、`auto-approve/README.md`、`coagent/README.md`、`coagent/docs/DESIGN.md`、`herdr-use/README.md`、`rule-engine/README.md`、`tool-consult/README.md`; 另 1 条在 `docs/host`, 归阶段 5.
- 命令多为 `npm`; 术语与界面名以 `docs/GLOSSARY.md` 与总追踪 6.6 为准.
- 34 份包追踪文档的「包文档」节已由主分支写好逐包规划 (本阶段开工提交); 34 个 `history-cleanup/02-tests-*` 与 25 个 `03-code-*` 旧分支已合并且删除, 阶段 4 分支从本笔提交后的 `main` 开.

## 实现规划

### 执行顺序

1. 主分支提交 34 份包追踪文档的包文档规划与本文件.
2. 从该提交开 34 个分支与 worktree; 每包只改本包文档.
3. 每包顺序: README 六节 → DESIGN 四节 (有则) → 命令 / 术语 → 断链 / 专项 → `format` 后自查 diff.
4. 通过后合并回 `main`, 删 worktree; 分支保留到总任务关闭.
5. 全部合并后全仓复扫: 断链、符号变体、包数口径、README 六节与 DESIGN 四节名单.

### 统一口径

- 六节: `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省配置节; 只改节名、合并重复段落, 不删内容、不新增结论.
- 四节: `## 背景` / `## 结构` / `## 机制` / `## 取舍`; 只改结构, 机制与取舍内容不动.
- 命令: 正文与示例的 `npm` 改 `pnpm`; 命令名与根 `package.json` 一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6; 界面名跟代码 (活动区 / 输入区 / 状态列 / 提示行).
- 断链: 指向 `docs/implementation/` 的归档链接改为实际归档路径; 不修归档文件自身.
- 数字: 工具数、动作数、包数不写死, 用「模型侧工具」「终端工具」「34 个包 (TUI 与 33 个插件)」等表述.

### 文件清单

| 组 | 文件 | 动作 |
| --- | --- | --- |
| 包说明 | 34 份 `<包>/README.md` | 六节归并 |
| 设计 | 15 份 `<包>/docs/DESIGN.md` | 四节归并 |
| 条目 | 26 份 `<包>/docs/BACKLOG.md` | 命令与术语同步 |
| TUI 专项 | `TUI/docs/SPEC.md` / `COMMANDS.md` / `COMMANDS-SPEC.md` / `docs/design/` | 界面四组术语与命令 |
| 模板 | `command-template/templates/adversarial-review.md` / `code-review.md` | 「评审」改「审阅」 |
| 包追踪 | 34 份 `docs/archived/2026-10-28-history-cleanup-<包>.md` | 追加实现记录 / 偏差 / 测试与证据 |
| 本文件 | `docs/archived/2026-10-28-history-cleanup-04-package-docs.md` | 新建 |

### 提交批次

- 每包一笔 `docs(<包>): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.
- 合并提交 `merge: 合并 <包> 包文档整理`.
- 全部合并后, 本文件补实现记录与证据, 总追踪补同步记录.

### 验证与门禁

- 每包: `format` 后自查 diff; 六节齐 (无配置可省), 有 DESIGN 的四节齐; 正文命令全 `pnpm`; 符号变体 0; 断链 0; 术语与 `docs/GLOSSARY.md` 一致.
- 全量: 34 份 README 六节、15 份 DESIGN 四节; 非归档断链 0; 正文符号变体 0; 包数口径统一 34.
- 文档改动不跑代码门禁; 全部合并后跑一次 `pnpm run check` 确认无代码变化 (预期无 diff).

### 明确不做

- 不改 `src` / `tests` / `package.json` / `tsconfig` / `cordis.patch.yml`.
- 不重写 SPEC / COMMANDS / design 的规格内容, 只统一术语与命令.
- 不合并、不改写归档文档; 不修归档内的断链.
- 不改 `docs/STATUS.md` / `docs/host` / 根 `archive/`.
- 不做阶段 5 的根 README / ROADMAP / GLOSSARY 终稿 / 追踪文档搬归档 / BACKLOG 清理.

## 实现记录

- 2026-11-01: 从 `61227e60` 开 34 个 `history-cleanup/04-package-docs-*` 分支与 `.worktree/04-package-docs/<包>`; 每包一个 coagent (permission `danger-full-access`), 只改本包文档。
- 34 个分支各一笔文档提交, 工作区全干净; 合并回 `main` 用 `git cherry-pick` 逐笔落地 (保持线性历史, 未用 merge commit), 6 个分支对包追踪文档的顺带记录在合并后补回。
- 改动面: 75 个文件, 其中 34 份 `README.md`、15 份 `docs/DESIGN.md`、22 份 `docs/BACKLOG.md`, 另 4 份 TUI 专项 (`docs/SPEC.md` / `docs/COMMANDS-SPEC.md` / `docs/design/AUDIT-colors.md` / `docs/design/REFACTOR.md`)。
- 34 份 README 六节齐 (无配置项的包省 `## 配置`), 15 份 DESIGN 四节齐; 命令统一 `pnpm`, 归档断链改实际路径, 工具数与包数硬编码改为泛指, 界面四组术语统一。
- 全量复扫: 断链 0 (脚本报 6 条均为行内代码里的示例 `url` / `href` / `a.md` / `来源`), 符号变体 0 (命中均在行内代码或符号规则示例内), 裸 `npm` 仅剩指 npm 仓库 / npm 包 / `npm install -g` 的说明性文字。

## 偏差

- 计划列的 `command-template/templates/*.md`「评审」改「审阅」未落地: 执行中判为模板运行时内容、超出阶段 4 只改文档的范围, 已从分支恢复; 模板与包文档术语暂不一致, 留待专项。
- 6 个分支 (`fs-digest` / `hash-edit` / `md-table-check` / `security-guard` / `task-engine` / `tool-consult`) 顺带补了包追踪文档的阶段 4 记录; 合并时先剔除, 关闭前已补回主分支。
- 测试数字处理不一致: 部分包补了 `test:integration` / `test:coverage` 并更新用例数 (`herdr-integration` / `code-map` / `agent-group` / `rule-engine` / TUI 等), 部分包按「不新增结论」保留旧数 (`memory-base` 仍写 61 例, 实际 90 单测 + 6 集成; `task-engine` 结构清单与用例数过时); 需一次事实同步补正。
- `rule-engine/docs/DESIGN.md` 结构节仍列拆分前 `main.ts` / `match.ts` / `rules.ts` / `persist.ts`, 与阶段 3 的五个新文件不符; `command-template/docs/DESIGN.md` 的 `src/main.ts` 路径与 `availableProviders` 旧句按范围要求回退; 均需补正。
- 合并方式与计划写的 merge commit 不同, 改用 cherry-pick; 不影响内容。

## 测试与证据

- `pnpm run check`: 退出 0 (文档改动, 无代码 diff)。
- `format` 覆盖 75 个改动文件: 退出 0, 复跑无 diff。
- 标题扫描 (跳过代码围栏): 34 份 README 六节 `readme_bad=0`; 15 份 DESIGN 四节 `design_bad=0`。
- 链接扫描: 75 份 Markdown, 相对链接缺失 0 (6 条为行内代码示例)。
- 合并后 `git status` 干净; `git rev-list --count 61227e60..HEAD` = 34, 逐笔均为 `docs(<包>): ...`; 无 `src` / `tests` / `package.json` / `tsconfig` / `cordis.patch.yml` 改动。
- 分支与 worktree 保留待总任务关闭时统一清理; 未 push。
