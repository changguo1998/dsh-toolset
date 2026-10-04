# `README.md:26`（md-map 行）英文句残缺（接取条目：`docs/BACKLOG.md`「`README.md:26`（md-map 行）英文句残缺」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `README.md`（补回 `document`）
- `docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研与决策（已核）

- 原句：`` …(including inline-code path refs, `kind:ref`),ument links, wiki links, code/file references and backlink counts… ``——`ument` 前缺 `doc`（疑编辑事故）；`README.zh.md:26` 同句为「文档间链接」，正常。
- 决策：**只补 `doc`**（`ument` → `document`），不重写句式——中文侧语义即「文档间链接」= `document links`，两侧恢复逐节同构；同一句其余部分不动（避免顺手改）。
- 来源与归属：本条是 2026-10-04「根 README 补 md-logic `replace`」任务的决策审阅发现的既有漂移，已按流程登记；本任务只做这一处。

## 实现记录（2026-10-04）

- `README.md:26`：``  `kind:ref`),ument links `` → ``  `kind:ref`), document links ``。
- 未改：`README.zh.md`（同句本就完整）、目录树注释、复用审计行。

## 测试与证据（2026-10-04）

- 文档类改动：验证 = `format` + diff 自查（`git diff -- README.md README.zh.md` 应为 1 增 1 删且仅 `README.md` 一侧）。
- 事实核对：`grep -n "document links" README.md` 命中；`README.zh.md` 无同类残缺（该行原文本就正常）。
- 回归：无代码路径变化；根 `npm run check` 见收尾复跑。

## 子代理审阅

（改动面极小（1 个单词），决策后与收尾前**合并一轮**；记录见下）

### 审阅（2026-10-04）

只读审阅结论「可提交」：补 `document` 后英文句语法完整，与中文侧「文档间链接」对应；全仓 `README*.md` / `docs/*.md` 再无同类残缺（另两处命中是 BACKLOG 里对残缺原文的**有意引用**）；diff 仅 1 增 1 删 + 状态标记；追踪文档与工作区一致。

1. **[次要] 新发现的既有漂移**：`README.md:26` 的 EN 句仍多列一项 `cross-doc refs`（`README.zh.md:26` 无该项，且两侧项序不同）——属**既有措辞漂移**、非本次引入。→ 按流程另开条目：`docs/BACKLOG.md`「根 README 双档 md-map 行措辞不对齐（`cross-doc refs` / 项序）」。
1. **[提示] BACKLOG 中的残缺原文引用**：`docs/BACKLOG.md` 的历史引用保留原样（引用完整性的有意选择），不动。

## 收尾

- 条目从 `docs/BACKLOG.md` 移除；同表登记收尾审阅发现的 EN/ZH 措辞漂移条目。
- 本追踪文档移入 `docs/archived/`；本次变更合并为一次提交（`README.md` + BACKLOG 两处 + 归档文档），提交见 git 历史。
- 复跑记录：文档类改动无代码路径变化；根 `npm run check` ✓（本轮收尾复跑）。
