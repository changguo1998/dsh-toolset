# 根 README 双档 md-map 行措辞与实现口径不对齐（同任务一并做收尾小瑕疵：三个空 BACKLOG 补标记）

接取条目（`docs/BACKLOG.md`）：**根 README 双档 md-map 行措辞与实现口径不对齐**；同任务一并做收尾小瑕疵（`fs-digest` / `hash-edit` / `task-engine` 三个空表缺「（当前无未完成项）」标记，无独立条目，纯排版）。

状态：进行中　　开启：2026-10-05　　关闭：—

## 计划改动文件清单（只改这些）

- `README.md` / `README.zh.md`（第 26 行 md-map 的能力列举改按 `MdEdgeKind` 口径，补 `external`）
- `fs-digest/docs/BACKLOG.md` / `hash-edit/docs/BACKLOG.md` / `task-engine/docs/BACKLOG.md`（空表补标记）
- `docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研与决策（已核）

- 现状（两侧同构但口径不准）：EN 写「cross-doc refs (including inline-code path refs, `kind:ref`)」，ZH 写「跨文档引用（含行内代码路径引用 `kind:ref`）」——`md-map` 的边分类是 `internal`（文档间链接）/ `wiki` / `file` / `external`（站外）/ `broken` / `ref`（行内代码路径引用），**没有**「跨文档引用」这一项：它与紧随其后的「文档间链接」重叠，且两侧都漏了 `external`。
- 决策：**按边分类列举**，两侧逐项同构：标题锚点 → 文档间链接（`internal`）→ wiki 链接 → 行内代码路径引用（`kind:ref`）→ 代码 / 文件 / 目录引用（`file`）→ 站外链接（`external`）；断链 / 断锚点由尾句承接；尾句（`callers` / `impact` / `orphans` / `report`、注册 `md_map`、复用 `md-logic`）不动。
- 空表标记：`fs-digest` / `hash-edit` / `task-engine` 三份 BACKLOG 只剩表头却无「（当前无未完成项）」，与另外 8 份不一致 → 补齐（纯排版）。

## 测试与证据（2026-10-05）

- 文档类改动：`format` + 两侧逐项对照（7 项同序同括注；尾句未动）+ `git diff --stat` 自查（仅 6 文件）。
- 回归：无代码路径变化；根 `npm run check` 见收尾复跑。

## 子代理审阅（决策后 + 收尾前合并一轮，2026-10-05）

只读审阅结论「可提交」，3 条提示 / 次要均已处理：

1. **[提示]** `file` 边还含「目录引用」（`md-map/README.md`）→ 已在两侧列举补「/ 目录」。
1. **[提示]** `md-map/README.md` 模块档自身列举比根档少（未含 `ref` / `external`）→ 按流程**另开条目**（`docs/BACKLOG.md` 行 3）。
1. **[次要]** 本追踪文档标题写「接取两条目」，实际只有 1 条 BACKLOG 条目 + 收尾小瑕疵 → 已改标题与说明措辞。
1. 已核通过：两行逐项同构（7 项同序）、尾句未动；覆盖 `internal` / `wiki` / `file` / `external` / `ref`，`broken` 由尾句承接；三处空表标记与其它 8 份格式一致；diff 无越界。
