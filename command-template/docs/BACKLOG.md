# command-template 待办

> 职责：command-template 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、模板与契约（见 `command-template/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `command-template/docs/archived/`，不在此重复。

## 待办

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **模板运行的全局预算**：现在只有每步 `stepTimeoutMs`（缺省 600s）与 `maxSteps`（缺省 12），最坏 `12 × 600s ≈ 2h` 才回终态；给一次模板运行加总预算（或把 `maxSteps × stepTimeoutMs` 的上界显式化并计入 README） | 2026-10-02「取消/超时终态」条目的子代理审阅（漏项） | `command-template/src/main.ts`（Config 增 `totalTimeoutMs`）+ steps 传递 + 测试 | 1 h | P2 |
| 2 | **模块无 `DESIGN.md`**：AGENTS.md 的模块文档口径含 `DESIGN.md`（架构与机制沉淀），本包只有 README + BACKLOG。补一份（命令注册/模板加载/步骤执行/宿主面四节）或明确「不建」并记理由 | 同上（漏项） | `command-template/docs/DESIGN.md` 或本文件记录裁定 | 1 h | P3 |
