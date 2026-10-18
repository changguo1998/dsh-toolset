# session-paths 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 条目详情（待办）

（无。）

## 边界备查

- 编码漂移复核（宿主升级后按 `src/encode.ts` 注释里的出处行号核对四个函数）**不在本包待办里**，属宿主升级流程的一部分。
- 消费方接入（memory-base 的 S 层、output-compress 的 `digest.db`、auto-approve 的会话审计、agent-group 的状态文件）各自的落点由对应模块的条目承载，本包只提供契约与服务面。

> 2026-10-17：随包创建，承接项目级条目「新增 `session-paths` 插件：复刻宿主的会话目录编码，供其他插件共用」的实现过程；当前无包内待办。2026-10-18：该条目完成并关闭（追踪文档归档为 `docs/archived/2026-10-17-session-paths.md`）。
