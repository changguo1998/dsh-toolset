# code-map 待办

> 职责：code-map 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、能力与查询契约（见 `code-map/README.md`）、架构与取舍（见 `code-map/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `code-map/docs/archived/`，不在此重复。

## 待办

### 1. `cycles` 不触发建索引，与 `callers` / `callees` / `impact` 行为不一致

- **现状**：`callers` / `callees` / `impact` 会先 `ensureIndexed`；`cycles` 未索引时**静默返回 `[]`**（`src/index.ts` 的 action 分派）。同一查询面下「未索引即空」容易被读成「确实没有环」。
- **期望**：三选一——① `cycles` 同样先建索引；② 未索引时返回明确的 `{ok:false, error}`（如 `not_indexed`）；③ 保持现状但在 `code_map` 的工具描述与 README 里写明「`cycles` 不建索引」。
- **落点**：`code-map/src/index.ts`（行为面改动，按代码流程走）或仅工具描述文案（②/③）。
- **验收**：`npm --prefix code-map run check` 与测试全绿；未索引调用 `cycles` 的行为与 README 描述一致（含新增用例）。
- **来源·状态·优先级**：2026-10-04 文档刷新（子代理实读发现，已写进 README/DESIGN 现状描述）；未接取；P3。
