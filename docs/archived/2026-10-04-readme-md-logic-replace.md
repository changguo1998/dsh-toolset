# 根 README 补 md-logic 的 `replace` 动作（接取条目：`docs/BACKLOG.md`「根 `README.md` / `README.zh.md` 的 md-logic 动作列表漏 `replace`」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `README.md`（md-logic 行：动作列表补写面 `replace`）
- `README.zh.md`（同节同构）
- `docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研（已核）

- 漏项位置：`README.md:25` 与 `README.zh.md:25` 的包表行（唯一命中；`README*.md` 内其余 `md-logic` 提及为目录树注释与复用审计条目，不含动作列表）。
- 事实依据（`md-logic/README.md`）：读面 `structure` / `blocks` / `links` **只读**；写面只有 `replace`（按节整节替换 / 删除，整批原子写，带 `section_hash` 漂移锚点；`content` 为空 = 删除该节）。
- 两文件逐节同构（英文主档 + 中文版），故两侧同批改。

## 决策

1. **补进动作列表**（不采用「改述为读 + 按节改写」的备选）：读面 / 写面分开写，与两侧同段已存在的「read + section-level rewrite」表述呼应，且保留四个动作名便于检索。
   - EN：`` registers the model-facing `md_logic` tool (`structure` / `blocks` / `links` for reading, and `replace` for section-level rewrite / deletion) ``
   - ZH：`` 注册模型侧工具 `md_logic`（读面 `structure` / `blocks` / `links`，写面 `replace` 按节整节替换 / 删除） ``
1. **不做**：不动目录树注释行与复用审计行（不同表述面，且不在条目范围内）；不顺带修 `README.md:26` 的既有排版残缺（见下「发现的问题」）。

## 发现的问题（登记，另开条目）

- `README.md:26`（md-map 行）英文句有残缺：`` …(including inline-code path refs, `kind:ref`),ument links, wiki links… ``（`d` 前应有 `doc`，疑为编辑事故）——经 `git show HEAD:README.md` 确认是**既有漂移**（非本任务引入），`README.zh.md:26` 同句正常。已按流程在 `docs/BACKLOG.md` 追加条目，不在本任务内顺手改。

## 子代理审阅（决策后，2026-10-04）

只读审阅结论「可实施」，四点核查全部通过：① 拟写表述与 `md-logic/README.md` 一致（读面只读 / 写面仅 `replace`，未误称 dry-run——dry-run 属 ast-tools 行）；② 范围完整（grep 两文件，仅 `:25` 列动作，`:53` / `:129` 不含）；③ 中英各 7 个标题逐节对应，同批改正确；④ 不修 `README.md:26` 的范围裁定合理（该残缺系既有漂移）。
采纳的次要项：本条「发现的问题」章节原先只被引用未写出，且未在 BACKLOG 追加条目——本回合补齐。

## 实现记录（2026-10-04）

- `README.md:25`：动作列表补写面 —— `` `structure` / `blocks` / `links` for reading, and `replace` for section-level rewrite / deletion ``。
- `README.zh.md:25`：同节同构 —— 「读面 `structure` / `blocks` / `links`，写面 `replace` 按节整节替换 / 删除」。
- `docs/BACKLOG.md`：本条标〔进行中〕；「发现的问题」按流程追加为表内第 4 条（`README.md:26` 残缺）。
- 本追踪文档：调研 / 决策 / 发现的问题 / 两轮审阅记录。
- 未改：目录树注释行、复用审计行、`README.md:26`（见「发现的问题」，另条处理）。

## 测试与证据（2026-10-04）

- 文档类改动，验证 = 格式 + diff 自查：`format` 后 `git diff --stat` = `README.md 2 +-`、`README.zh.md 2 +-`、`docs/BACKLOG.md 3 ++-`（每侧仅目标行 1 增 1 删，无附带重排）。
- 事实核对：`md-logic/README.md`（读面只读 / 写面仅 `replace`；`content` 空串 = 删除该节）；两文件 `grep md_logic` 仅 `:25` 含动作列表（`:53` 目录注释、`:129` 复用审计不含）。
- 中英同构自查：改后两文件各 6 个 `##` + 1 个 `###`，顺序一一对应；改动均落在同一表行内。
- 两轮子代理审阅：决策后「可实施」（4 项核查通过）；收尾前「需修」两处次要（BACKLOG 第 4 条嵌套反引号、本文档缺实现 / 证据 / 收尾三节）——均已在本回合补正。

## 收尾

- 条目从 `docs/BACKLOG.md` §2 移除；本追踪文档移入 `docs/archived/`；本次变更合并为一次提交（README 双档 + BACKLOG + 归档文档），提交见 git 历史。
