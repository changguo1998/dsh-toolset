# 评估 tool-consult 的匹配算法与预览上限（接取条目：`docs/BACKLOG.md`「tool-consult matcher 评估」）

状态：调研　　开启：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮只建立文档（接取），调研与实现均未开始。

## 目标

依据真实误用样本评估 `tool-consult` 的 BM25 参数、短语加成与 `oneLine` 预览上限是否需要调整；无证据不动算法。

## 调研

（未开始。已知量：`K1 = 1.2` / `B = 0.75`（`tool-consult/src/matcher.ts:58-59`）、名称精确 +20 / 包含 +10 / 描述包含 +4（`:157-159`）、预览上限 80 字符（`:96`）；描述与别名修完后真机 12 条查询达标（`docs/archived/2026-10-24-tool-description-review.md`「收尾」）。）

## 决策

（待调研后填写。）

## 规划

计划改动文件清单（草案，开工时定稿）：

- `tool-consult/src/matcher.ts`（若评估结论要求动权重 / 加成 / 预览）
- `tool-consult/tests/matcher.test.ts`、`tool-consult/tests/retrieval.test.ts`（回归）
- 若涉及预览口径：`tool-consult/src/tool.ts`

明确不做：

- 无真实误用样本不改权重。
- 不为改善排序去改工具名或参数 schema。
- 不降低现有 6 条 top-1 检索断言。

## 实现记录

（待开工。）

## 偏差

（待实现阶段填写。）

## 测试与证据

（待实现阶段填写。）

## 收尾

（待关闭时填写。）
