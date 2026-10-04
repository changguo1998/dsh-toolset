# symbol-normalizer 待办

> 职责：symbol-normalizer 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、规则表与契约（见 `symbol-normalizer/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `symbol-normalizer/tests/`（如 F3 已实现提交），不在此重复。
> 组织：单一「待办」区（按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 待查 → 落点 → 验收 → 来源·状态·优先级。

## 待办

### 1. `F1` / `F2` / `F3` 悬空引用

- **现状**：`README.md`、`docs/DESIGN.md`、`docs/BACKLOG.md` 与 `src/{main,review,guide,symbols}.ts` 共 6+ 处引用已关闭并从本清单移除的 `F1` / `F2` / `F3`。
- **期望**：改为按**标题**引用（如「符号表（本包 README）」）或直接删掉编号指路；本模块编号口径为扁平 `#n`，`F*` 已废。
- **落点**：上述文件（跨 src 注释与模块文档；头部 `> 本文件只列未完成项…（如 F3 已实现提交）` 一句一并改）。
- **验收**：`grep -rn "F[123]" symbol-normalizer` 无残留；`npm --prefix symbol-normalizer run check` 全绿。
- **来源·状态·优先级**：2026-10-04 文档刷新（子代理报告）；未接取；P3。
