# command-template 待办

> 职责：command-template 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、模板与契约（见 `command-template/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `command-template/docs/archived/`，不在此重复。

## 待办

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |

### 1. 随包模板 `code-review.md` 的 `verify` 步缩进错误

- **现象**：`templates/code-review.md` 的 `verify` 步里 `bestOf: 2` 与 `judge:` 只缩进 5 空格，被落进 `prompt: |` 块标量 —— 实跑解析得 `verify` 步无 `bestOf` / `judge`，且 prompt 尾部混入 `estOf: 2` / `udge:` / `---` 碎字。
- **期望**：缩进对齐同级键（或用显式 `judge` 块），解析后 `verify` 步带 `bestOf: 2` + `judge.prompt`。
- **落点**：`command-template/templates/code-review.md`（模板内容，属行为面，按代码改动流程走）。
- **验收**：`/playbook code-review` 的 verify 步按 bestOf=2 + 裁判执行；`npm --prefix command-template test` 全绿（宜补一条模板解析用例）。
- **来源·状态·优先级**：2026-10-04 文档刷新（子代理实跑发现）；未接取；P2（该模板当前不可用）。
