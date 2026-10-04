# 根 README 双档 md-map 行措辞不对齐（接取条目：`docs/BACKLOG.md`「根 README 双档 md-map 行措辞不对齐」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `README.zh.md`（md-map 行的项目列表向英文主档对齐）
- `docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研与决策（已核）

- 现状：`README.md:26`（英文主档）列「heading anchors → **cross-doc refs (including inline-code path refs, `kind:ref`)** → document links → wiki links → code/file references → backlink counts」；`README.zh.md:26` 列「标题锚点 → 文档间链接 → wiki 链接 → **行内代码路径引用**（`kind:ref`）→ 代码 / 文件引用 → 被引计数」——**多一项 / 项序不同**（英文侧把「跨文档引用」作为上位项，`kind:ref` 作为其括注）。
- 决策：**以英文主档为准**（AGENTS.md：英文 `README.md` 为主档），把中文行改成同构项序——「标题锚点、**跨文档引用**（含**行内代码路径引用** `kind:ref`）、文档间链接、wiki 链接、代码 / 文件引用与被引计数」；语义无变化（英文侧的上位项本来就覆盖中文侧的两项），只修「逐节同构」。
- 不做：不动英文主档（它是基准）；不动该行的尾句（`callers` / `impact` / `orphans` / `report` 与工具 / 复用说明两侧本就一致）。

## 实现记录（2026-10-04）

- `README.zh.md:26`：项目列表改为与英文主档逐项同序（见上）。

## 测试与证据（2026-10-04）

- 文档类改动：`format` + 两侧 diff 对照（项数与项序逐项核过；尾句未动）。
- 回归：无代码路径变化；根 `npm run check` 见收尾复跑。

## 子代理审阅

（单行措辞对齐，决策后与收尾前**合并一轮**；记录见下）

### 审阅（2026-10-04）

只读审阅结论「可提交」：

1. **[次要]** 「跨文档引用」不是 `md-map` 的边分类项（边分类 = `internal` / `wiki` / `file` / `external` / `broken` / `ref`）：它与紧随其后的「文档间链接」（= `internal`）语义重叠，且**两侧都漏了 `external`（站外链接）**；英文主档同措辞，故本任务不改（本条目只做「以英文为准修中文」）→ 已按流程**另开条目**（`docs/BACKLOG.md`「根 README 双档 md-map 行措辞与实现口径不对齐」，建议两侧统一按边分类列举）。
1. **[提示] 中文侧多一处加粗**（`**行内代码路径引用**`，英文侧无强调）→ 已去粗，两侧严格同构。
1. 已核：两行现为 **6 项同序**、尾句一致（`callers` / `impact` / `orphans` / `report` + 断链断锚点括注、注册 `md_map`、复用 `md-logic`）；抽查 `md-logic` / `task-engine` 两行无同类 EN/ZH 漂移；diff 无越界。

## 收尾

- 条目从 `docs/BACKLOG.md` 移除（同表登记收尾审阅发现的措辞口径条目）；表内其余条目重编号。
- 本追踪文档移入 `docs/archived/`；本次变更合并为一次提交（`README.zh.md` + BACKLOG 两处 + 归档文档），提交见 git 历史。
- 复跑记录（纯文档改动）：`format` ✓、根 `npm run check` / `npm run build` ✓。
