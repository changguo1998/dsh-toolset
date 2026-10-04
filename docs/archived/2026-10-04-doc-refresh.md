# 全目录文档与注释刷新（接取条目：docs/BACKLOG.md「更新文档：全目录文档整理」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

自底向上刷新全仓文档，使文档与实现一致：

1. 逐模块校准 `src/` 注释（阶段 1）；
2. 逐模块更新模块文档 `README.md` / `docs/DESIGN.md` / 模块 `docs/*`（阶段 2）；
3. 汇总更新项目级文档（根 `README.md` / `README.zh.md` / `AGENTS.md` / `docs/*.md`）（阶段 3）。

约束（用户 2026-10-04 指示）：

- 每个模块在**独立 git worktree + 分支**中完成，**每模块一条提交**，再按模块合并回 `main`；
- 子代理**最多 8 个**，且**子代理不得再嵌套子代理**；
- 不改运行时逻辑（`src/` 只动注释）。

## 调研

- 全仓共 **21 个模块**（TUI + 20 个插件包），`src/` 合计约 32.6k 行（TUI 占 28.0k = 86%），模块文档（不含 `archived/`）约 4.2k 行。
- 模块文档现状两类：有 `DESIGN.md` 的重包（TUI / task-engine / knowledge-base / session-channel / code-map / rule-engine / symbol-normalizer / output-compress / ponytail / command-template / md-logic / md-map），只有 `README.md` 的轻包（ast-tools / context-report / fs-digest / goal-contract / hash-edit / herdr-integration / metric-loop / security-guard / session-title-cutoff）。
- 仓库已有 worktree 约定（`.gitignore` 含 `.worktree`；task-engine 隔离器与既有追踪文档均用 `<repo>/.worktree/<seg>`），本任务沿用 `.worktree/<name>` + 分支 `docs/<name>`。
- 各包 `node_modules` 位于包目录内且被忽略；worktree 内用**软链**指回主库同名目录，避免重复安装。

## 决策

- **任务分解**：21 个模块 → 8 个子代理分两波执行（波次 1 用满 8 个、波次 2 复用其中 6 个；全程无嵌套）。TUI 体量过大，拆 3 个工作域（`TUI/src` 核心层 / `TUI/src` IO 层 / `TUI/docs` + `TUI/README.md`），三域文件不相交。
- **合并方式**：模块分支的**每模块提交**用 `git cherry-pick` 逐条落到 `main`（一模块一条提交，无 merge commit）；TUI 的三个域分支改用 `git checkout <branch> -- <files>` 逐域取文件后**一次性提交**（保持「TUI 一条提交」）。
- **注释口径**：只改「事实性注释」（文件头说明、导出符号 JSDoc、含行号 / 计数 / 路径 / 工具名 / 阈值 / 状态机描述的注释），不改逻辑、标识符、字符串字面量、导出面、测试。
- **不做**：`docs/STATUS.md` 与模块 `STATUS.md`（用户择时维护）、`docs/host/**`（宿主面知识，不参与变更流程）、`**/docs/archived/**`、`archive/**`、测试文件注释、`profiles/**`。
- **文档 vs 行为面**：文档与**模型/用户可见字符串**（工具 description、命令表文案）冲突时不改字符串，只在模块 `docs/BACKLOG.md` 追加条目留待按代码流程处理（本次共登记 5 条：rule-engine 工具文案、code-map 工具文案 + `cycles` 不建索引、command-template 模板缩进 + `/tpl` 已废弃文案、symbol-normalizer `F1`-`F3` 悬空引用、hash-edit 并发临时文件冲突）。

## 规划

计划改动文件清单（全量）：注释 `TUI/src/**/*.ts` 与 20 包 `<pkg>/src/**/*.ts`（仅注释行）；模块文档各包 `README.md` + `docs/*.md`（`STATUS.md` 除外）；项目文档根 `README.md` / `README.zh.md` / `AGENTS.md` / `docs/BACKLOG.md` / `docs/ROADMAP.md` / `docs/ARCHITECTURE-REUSE.md` / `docs/ponytail-investigation.md` / 本追踪文档。

波次与工作域：

| 波次 | 工作域 | worktree / 分支 |
|------|--------|------------------|
| 1 | TUI 核心层注释 | `.worktree/tui-src-core` / `docs/tui-src-core` |
| 1 | TUI IO 层注释 | `.worktree/tui-src-io` / `docs/tui-src-io` |
| 1 | TUI 模块文档 | `.worktree/tui-docs` / `docs/tui-docs` |
| 1 | task-engine + ponytail | `.worktree/w1a-task-engine` |
| 1 | session-channel + session-title-cutoff | `.worktree/w1b-session-channel` |
| 1 | rule-engine + symbol-normalizer | `.worktree/w1c-rule-engine` |
| 1 | knowledge-base + output-compress + metric-loop | `.worktree/w1d-knowledge-base` |
| 1 | security-guard + md-map | `.worktree/w1e-security-guard` |
| 2 | md-logic | `.worktree/w2a-md-logic` |
| 2 | ast-tools + fs-digest | `.worktree/w2b-ast-tools` |
| 2 | code-map + context-report | `.worktree/w2c-code-map` |
| 2 | command-template | `.worktree/w2d-command-template` |
| 2 | goal-contract + hash-edit | `.worktree/w2e-goal-contract` |
| 2 | herdr-integration | `.worktree/w2f-herdr-integration` |

## 实现记录

- 2026-10-04：建 goal 契约（`goal-929e1863-08a3-4390-82a7-9b8d20f6f64b`）；建本追踪文档；`docs/BACKLOG.md` 条目标「进行中」。
- 2026-10-04：建 14 个 worktree（`.worktree/*`，分支 `docs/*`，node_modules 软链回主库；worktree 内 `tsc --noEmit` 先验证可用）；波次 1 起 8 个子代理。
- 2026-10-04：**首轮 8 个并发时 7 个被系统中断**（0 改动 0 提交），仅 `tui-src-core` 交付；此后**再次复现**同类批量失败。处置：复用同批代理 id（不新增代理，仍 ≤8）、把并发压到 4-6、并明确要求「worktree 内已有未提交改动时基于现状收尾，不要重来」——最终 21 个模块全部交付，无重做浪费。
- 2026-10-04：逐条复核「只改注释 / 文档」：`git diff -U0 <范围> | grep -E '^[+-][^+-]' | grep -vE '^[+-][[:space:]]*(//|/\*|\*|$)'` 输出为空。发现 `task-engine` 分支的 `src/main.ts` 有两处**被 `format` 顺带重排的长行**（`main` 上该文件本就不满足 prettier，属无关格式化）→ 合并时用 `git commit --amend` 还原为原单行写法，保持 diff 最小。
- 2026-10-04：模块提交逐条 cherry-pick 落 `main`（共 21 条：TUI 1 + 20 包各 1），逐包 `tsc --noEmit` 复跑；TUI 一条提交另含主库复核补正两处（`layout.ts` 的 Agents 块条目行 JSDoc 改实现口径、`TUI/docs/BACKLOG.md` 新增 `/collapse` 文案条目）。
- 2026-10-04：项目级回写——根 `README.md` / `README.zh.md` 各 7 处（code-map 的 LSP 口径、ARCHITECTURE-REUSE 审计基线、DESIGN.md 存在包清单、模块 BACKLOG 清单、rule-engine 消费者与投递路径、command-template 去 `/tpl`、code-map 入 BACKLOG 清单），双语逐节同构；`docs/ROADMAP.md` 重写依据引用（改为文档路径，废弃不稳定的 `#n` 跨引用）并修「16 个包」→「TUI + 20 包」、「git worktree 未落地」→「已落地」；`docs/ARCHITECTURE-REUSE.md` 修计数口径（21 模块 = TUI + 20 包）、补 `ponytail` 总表行（保留 12 → 15）、§3 复用面补 `ponytail`；`docs/ponytail-investigation.md` 补「后记：已按路径 a 落地」；`docs/BACKLOG.md` 修 `form:'notice'` 旧口径、`scanMarkdown` 复用说法、「宜与 render 缺陷同批」，并清理已完成条目；新建 `code-map/docs/BACKLOG.md`（登记 2 条），模块 BACKLOG 新增条目共 5 条。
- 2026-10-04：顺带修正的两处跨文件过期引用（均非行为面）：根 README 双语 + `command-template/cordis.patch.yml` 头注释的 `/tpl`（该命令早已废弃，入口只有 `/playbook`）。

## 测试与证据

- 中间态（15 模块合并后）与**终态**各跑一次全仓：`npm run check` exit 0；`npm run test` → **21 包全绿 / 0 失败**。
- 各包测试例数（终态；用于核对模块文档里的「测试例数」声明，被本次刷新校正的计数均与此一致）：TUI 1325、task-engine 136、security-guard 122、rule-engine 87、fs-digest 66、knowledge-base 57、md-logic 57、hash-edit 52、md-map 49、session-channel 47、output-compress 45、metric-loop 44、context-report 44、symbol-normalizer 39、ast-tools 38、goal-contract 37、herdr-integration 35、command-template 26、code-map 23、session-title-cutoff 8、ponytail 5。
- 「一模块一提交」核对：`git log --oneline 87480af..HEAD` = 21 条，模块名与条目标题一一对应。
- 抽检复核（主库侧，非子代理自述）：TUI 核心层提交的三处事实性注释分别对回 `layout/tool-line.ts` 的 `turnHeaderLine`（`⇆N`）、`layout.ts` 的状态栏分隔（`separator: { char: "•", color: "plain" }`）、`statusBarSeamCols` 恒空（状态栏行已无 border 色 `│`）；symbol-normalizer 符号表与 `src/symbols.ts` 的白名单 / 别名表逐项一致；`command-template/templates/code-review.md` 的缩进缺陷（`bestOf: 2` 落在 `prompt: |` 块内）实读确认。

## 收尾

- 回写的文档：见「实现记录」项目级回写条目；模块侧回写由各子代理落在本模块 `README.md` / `docs/DESIGN.md` / `docs/BACKLOG.md`，随模块提交入库。
- 本追踪文档移入 `docs/archived/2026-10-04-doc-refresh.md`；`docs/BACKLOG.md` 的已完成条目「更新文档：全目录文档整理」按流程清理移除。
- 遗留项（不阻塞关闭）：① `docs/STATUS.md` 与 TUI `docs/STATUS.md` 中的旧计数（如 goal-contract 35→37、hash-edit 43→52）由用户择时更新；② 5 条「文档 vs 行为面字符串」条目已落各模块 `docs/BACKLOG.md`；③ `docs/host/HOST-PACKAGES.md` 关于 `output-compress` 的 `codeRuntime 回退` 说法属宿主面文档（生成物、不参与变更流程），未改；④ goal-contract 仍无模块 `docs/BACKLOG.md`（本次无待办可记，未新建）。
- 清理：14 个 worktree 与对应 `docs/*` 分支在收尾提交后删除（`.worktree/` 本身在忽略内）。
