# hash-edit 待办

> 职责：hash-edit 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与能力（见 `hash-edit/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `hash-edit/tests/`，不在此重复。

## 待办

| # | 事项 | 来源 | 落点 | 工作量（估） | 优先级 |
|---|------|------|------|--------------|--------|
| 1 | **`render` 形参顺序反了 → `hash_read` / `hash_edit` 的结果到不了模型**：`toDshTool` 写成 `render: (value) => [text: JSON.stringify(value)]`（`src/main.ts:86`，接口声明同错在 `:72`），而宿主契约是 **`render(args, value)`**——本仓其余 12 处 render 全为 `(_args, value)`（`task-engine/src/main.ts:506`、`code-map/src/index.ts:376`、`fs-digest/src/main.ts:41` 等）。后果：模型每次只拿到**入参回显**——真机实测 `hash_read(path="tmp/hashread-probe.txt")` 返回 `{"path":"tmp/hashread-probe.txt"}`（无 `hashlines`），而对同一文件直调后端 `readHashlines()` 正常返回 `{ok,path,file_hash,line_count,hashlines:[{line,hash,text}…]}`。即 LINE:HASH 锚点在模型侧永远拿不到 → 锚定编辑链路实际不可用（会话里只能改用 `edit` / python 绕行）。期望：改成 `(_args, value)`，并补一条 render 形状断言（照 `task-engine` 的 render 用例） | 2026-10-02 宿主升级真机验证时发现（`docs/archived/2026-10-02-host-upgrade-execution.md`）；**非升级引入**，0.1.7-rc.2 上同样复现 | `hash-edit/src/main.ts`（2 处）+ `hash-edit/tests/` | 0.5 h | P1 |
