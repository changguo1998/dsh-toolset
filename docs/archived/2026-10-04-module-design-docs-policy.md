# 模块 `DESIGN.md` 口径裁定与补建（接取条目：`docs/BACKLOG.md`「11 个模块缺 `DESIGN.md`（系统性缺口）」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `AGENTS.md`（口径裁定：哪些包必须有 `DESIGN.md`、哪些轻量包豁免）
- `md-logic/docs/DESIGN.md`（新建，7 节）
- `md-map/docs/DESIGN.md`（新建，8 节）
- `docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研（已核）

- 现状：21 个包/层里 **11 个**没有 `DESIGN.md`（`ast-tools` / `context-report` / `fs-digest` / `goal-contract` / `hash-edit` / `herdr-integration` / `md-logic` / `md-map` / `metric-loop` / `security-guard` / `session-title-cutoff`）；已有 10 份（`TUI` / `task-engine` / `knowledge-base` / `session-channel` / `code-map` / `rule-engine` / `symbol-normalizer` / `output-compress` / `ponytail` / `command-template`）。
- 已有个体差异很大：薄包（如 `session-title-cutoff` 一个 provider）与厚包（`task-engine` 的引擎 + 语义门 + executor 适配）用同一套「必须有」要求并不合适。
- 用户已裁定（2026-10-04，`ask_user_question`）：**混合口径**——机制密度高的包补，其余明确豁免并同步 `AGENTS.md`。

## 决策

1. **补两份**（`md-logic` 7 节、`md-map` 8 节，体例同已有个体：定位 / 取舍 / 机制 / 边界 / 明确不做）：
1. **豁免 9 份**：`ast-tools` / `context-report` / `fs-digest` / `goal-contract` / `hash-edit` / `herdr-integration` / `metric-loop` / `security-guard` / `session-title-cutoff`——能力面在 README 已讲清，另写 DESIGN 只会重复；**豁免写进 `AGENTS.md`**（口径唯一来源），并写明「机制变厚（跨组件协议 / 状态机 / 时序契约）时再补」。
1. **口径落在 `AGENTS.md` 的「结构与约定」**（文档结构的归属地），并在「内容变更规范」的分层行加一句指向，避免两处各说一套。
1. 两份新 DESIGN 的结构沿用已有个体例（职责 / 不负责 / 过期条件三行头 + 定位 / 取舍 / 机制 / 边界 / 明确不做），**只写代码里真实存在的机制**并标注落点文件。

## 实现记录（2026-10-04）

- 新建 `md-logic/docs/DESIGN.md`（7 节）：定位与三工具分工、5 条架构取舍（节树为主数据 / 整块替换 / 双锚 / 结构守卫而非语法校验 / 稳定错误码）、解析与节树、改写管线（① 定位 → ①.5 守卫 5 条 → ② 重叠 → ③ 原子写 + `file_changed`，附失败码全集 12 个）、渲染与工具面、约束与已知边界（容器盲、限长、单文件）、明确不做。
- 新建 `md-map/docs/DESIGN.md`（8 节）：定位与 `md-logic` 分工、5 条取舍（内存态显式重建 / 边分六型（含 `external`）/ 锚点独立校验 / exclude 只管入索引 / 不猜歧义）、扫描与索引（递归 DFS + `localeCompare`、`DEFAULT_EXCLUDES`、`maxFiles`、`toPosix`）、引用解析口径（候选序 + `ref` 三处补口 + 出边恒 root 内规范化）、查询与渲染、服务面与工具、约束与边界、明确不做。
- `AGENTS.md`：新增「`DESIGN.md` 口径（2026-10-04 裁定）」列出 12 个必须有 + 9 个豁免及其理由与「何时再补」；分层行加指向。

## 测试与证据（2026-10-04）

- 文档类改动（无代码路径变化）：`format` + 逐节对照源码复核（`md-logic/src/{parse,query,edit,render,tools}.ts`、`md-map/src/{indexer,links,query,render,service,index}.ts` 的导出与注释）+ diff 自查。
- 回归：根 `npm run check` / `npm run build`（见收尾复跑）；`md-logic` 57 例、`md-map` 49 例在各自条目收尾时全绿，本次未改代码。

## 子代理审阅

（文档类改动，决策后与收尾前**合并一轮**；记录见下）

## 子代理审阅（决策后 + 收尾前合并一轮，2026-10-04）

只读审阅（逐节对照源码）结论「需修」，两处必改 + 两处计数，均已同批修：

1. **[重要] `md-logic` 失败码名与源码不符**：文档原写 `not_found` / `ambiguous` / `range_mismatch`，实际是 `section_missing` / `section_ambiguous` / `section_drift`（另有 `range_out_of_bounds`），且漏了 `edits_invalid` / `read_failed` / `not_utf8` / `write_failed` → 已按 `src/edit.ts` 的 `EditFailureCode` 补正，并补「失败码全集（12 个）」一条。
1. **[重要] `md-map` 边类型漏 `external`**：`MdEdgeKind` 实为 6 型（含 `http(s)` / `mailto` / `tel` 等站外目标）→ 已补。
1. **[次要] 「BFS」不实**：`indexer.ts` 的 `walk()` 是递归 DFS + 每层 `localeCompare` 排序 → 措辞已改。
1. **[次要] 追踪文档计数**：`md-logic` 实为 7 节 / 5 条取舍、`md-map` 取舍实列 5 条 → 已改正。
1. **[自检发现并修复]** 按码名改段落时，用「替换到下一个空行」的脚本误吞了同列表内的其它条目（`md-logic` §4 的 ①.5/②/③、`md-map` §2 的 3 条取舍与 §3 的 2 条）→ 已按原稿整节重写两份文档的对应章节，并逐节复核条目数（`md-logic`：§2 5 / §3 4 / §4 5 步 + 码全集 / §5 3 / §6 4 / §7 4；`md-map`：§2 5 / §3 3 / §4 4 / §5 2 / §6 2 / §7 4 / §8 4）确认无遗漏。
1. **[提示]** `AGENTS.md` 新增段落前的空行是 mdformat 风格（与同文件其它节不一致）——属既有漂移，未动。

已核无问题：两串包名与仓库一致（12 个有 `DESIGN.md` + 9 个豁免 = `TUI` + 20 包，无重复遗漏）；`docs/BACKLOG.md` 状态标记正确；两文档其余各节与源码一致；diff 无越界。

## 收尾

- 条目从 `docs/BACKLOG.md` 移除（表内其余条目重编号）。
- 本追踪文档移入 `docs/archived/`；本次变更合并为一次提交（`AGENTS.md` + 两份 `DESIGN.md` + BACKLOG + 归档文档），提交见 git 历史。
- 复跑记录（纯文档改动）：`format` ✓、根 `npm run check` / `npm run build` ✓（无代码路径变化）。
