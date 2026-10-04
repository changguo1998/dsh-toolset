# command-template 待办

> 职责：command-template 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、模板与契约（见 `command-template/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `command-template/docs/archived/`，不在此重复。

## 待办

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **`/playbook playbook` 触发无限递归**（源码缺陷）：`run()` 见到入口名会转 `#dispatch`（`main.ts` 约 206 行），而 `#dispatch` 把第一段当模板名再调 `run()`（约 247 行）；`ENTRY_COMMAND` 不在 `#reserved()` 里（保留名只有 `list` / `show` / `reload`），故 `/playbook playbook` 会 `run → #dispatch → run` 递归到爆栈（`RangeError`）——现有用例只覆盖 `list` / 空输入 / `show`。期望：把入口名并入保留名（`#dispatch` 对 `first === ENTRY_COMMAND` 走管理面 = 输出 list），或显式返回「模板不存在」错误；补用例（两形态都断言不递归）。来源：2026-10-04「command-template 补 `DESIGN.md`」任务的收尾审阅（源码隐患，非文档问题） | `command-template/src/main.ts`（`#dispatch` / `#reserved`）+ 测试 | 0.5 h | P3 |
