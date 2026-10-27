# session-paths 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 条目详情（待办）

（无。）

## 边界备查

- 编码漂移复核属宿主升级流程：每次升级后按 `src/encode.ts` 注释的出处行号核对四个函数（不在本包待办）。
- 消费方接入的落点与条目由对应模块维护（memory-base S 层 / output-compress `digest.db` / auto-approve 会话审计 / agent-group 状态文件），本包只提供契约与服务面。

> 2026-10-27 关闭：两条边界备查均核实完成 —— 编码漂移: 安装树 `lib/index.js` 四函数行号与语义逐字一致（encodeSegment 853-865 / projectKey 875-894 / projectDir 902-905 / sessionDir 912-914），rc.2 → rc.3 的 `packages/session/session-persistence-jsonl/src/format.ts` 无 diff（官方仓工作树 HEAD 亦同），无漂移; 消费方接入: memory-base `src/tiers.ts:122`、output-compress `src/hooks.ts:384`、auto-approve `src/audit.ts:157` + `learn.ts:1202`、agent-group `src/main.ts:324` + `core.ts:1068`，相关测试全绿（session-paths 24、memory-base tiers 9、output-compress hooks 30、auto-approve learn 31 + audit、agent-group main 21）。

> 2026-10-17：随包创建，承接项目级条目「新增 `session-paths` 插件：复刻宿主的会话目录编码，供其他插件共用」的实现过程；当前无包内待办。2026-10-18：该条目完成并关闭（追踪文档归档为 `docs/archived/2026-10-17-session-paths.md`）。
