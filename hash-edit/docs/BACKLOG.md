# hash-edit 待办

> 职责：hash-edit 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与能力（见 `hash-edit/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `hash-edit/tests/`，不在此重复。

## 待办

| # | 事项 | 来源 | 落点 | 工作量（估） | 优先级 |
|---|------|------|------|--------------|--------|
| 1 | **相对路径基准拿不到会话 cwd**：`execute(args)` 丢弃宿主第二实参 `exec`（`src/main.ts:82`），`resolvePath` 只用 `config.root ?? process.cwd()`（`src/fs.ts:52-53`）→ 会话 cwd 与进程 cwd 不同时，`hash_read` / `hash_edit` 的相对路径解析到错目录（not_found 或读错文件）。契约证据：宿主 `dsh-tools/lib/index.js:3310` 传 `exec`；会话 cwd 取 `exec.agent?.session?.header?.cwd`（对照宿主 `dsh-tool-fs/lib/index.js:174` 与本仓 `fs-digest/src/main.ts:63`、`md-logic/src/tools.ts:27`、`md-map/src/tools.ts:25` 的 `resolveExecCwd`）。修法：`execute(args, exec)` 解析 cwd 作为 root 缺省（显式 `config.root` 优先）+ 一条「exec 带 cwd 且与进程 cwd 不同」的单测；README 的「宿主 cwd」文案一并改为「会话 cwd」 | 2026-10-02 `render` 形参顺序条目的子代理审阅（同一次宿主面复核） | `hash-edit/src/{main,fs}.ts` + `hash-edit/tests/` + README | 0.5 h | P2 |
