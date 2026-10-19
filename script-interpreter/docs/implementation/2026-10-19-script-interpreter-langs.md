# script-interpreter 语言后端（bash / node / sh）（接取条目：script-interpreter/docs/BACKLOG.md「打开 bash 语言后端与二期语言（node / sh）」）

状态：规划　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按 `LangBackend` 契约打开 / 新增语言后端：bash（`src/langs/bash.ts` 已随包实现，加入 `languages` 缺省表前先确认不与官方 `tool-bash` 工具面重复）；node / sh 按需以新 `langs/<语言>.ts` 落地并在配置追加；不改工具名与协议。验收按条目：新语言一例真实执行断言；未启用语言仍明确报错。

## 调研

（待写 —— 用户指示：新建追踪文档后、调研前先停下。已预置的核实点：`src/langs/bash.ts` 现状、`src/index.ts` 语言表与 `LangBackend` 契约、`languages` 配置形态、官方 `tool-bash` 覆盖面。）

## 决策

（待写。待决点：bash 是否打开（与官方重复度核实结论）；node / sh 是否本期实现及默认启用名单。）

## 规划

任务拆分：

- 核实 bash 与官方 `tool-bash` 的重合度，定是否加入 `languages`。
- 按 `LangBackend` 契约实现 / 登记语言（bash / node / sh），改 `src/index.ts` 语言表与配置。
- 各语言一例真实执行断言 + 未启用语言报错用例；同步 README 参数表。

计划改动文件清单（预估）：

- `script-interpreter/src/langs/bash.ts`（登记 / 若需调整）
- `script-interpreter/src/langs/node.ts` / `sh.ts`（按决策新增）
- `script-interpreter/src/index.ts`（语言表）
- `script-interpreter/tests/**`（语言相关用例）
- `script-interpreter/README.md`（参数表与语言面）
- 本追踪文档

明确不做：不做 REPL / 跨调用状态保持；不改工具名与协议；不碰 `languages` 之外的配置面。

## 实现记录

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
