# rule-engine 待办

> 职责：rule-engine 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、引擎契约与规则表（见 `rule-engine/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `rule-engine/docs/archived/`，不在此重复。
> 组织：单一「待办」区（按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）原因 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办








> 2026-10-16 关闭：条目 1-7 全部完成并**从本清单移除** —— 追踪文档归档为 `rule-engine/docs/archived/2026-10-16-test-coverage-and-defects.md`。结论：#1 单条正文上限 20000 → 200000 且超限告警（不再静默截断）；#2 `surfaceOp: "replace"` 的消息丢弃（与 TUI 显示面一致，不进 `turn-end` 载荷）；#3 `turn/end` 的 `reason` 归一（字符串按字面、对象读 `kind`、缺省 `completed`），其余非法值不唤醒 + 告警；#4 新建 `tests/tools.test.ts`（`src/tools.ts` 函数覆盖 33.33% → 100%）；#5 多 `delivery` 分组与段数预算用例；#6 `registerConsumer` / `update` 校验分支用例；#7 零散补钉十点（总行覆盖 93.11% → 100%、函数 89.71% → 97.84%，README 用例数 87 → 140）。证据：`npm --prefix rule-engine run check` 0 错误、`npm test` 140 例全绿、三处修正各做反向验证（撤改即转红）。跨包影响：`md-table-check/tests/surfaceDifferential.test.ts` 的镜像口径待同步（3 例转红，属 md-table-check 任务）。
