# script-interpreter Python venv / uv 自动探测（接取条目：script-interpreter/docs/BACKLOG.md「Python venv / uv 自动探测」）

状态：规划　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

在现有解释器路径覆盖（`pythonPath` / `SCRIPT_PY_INTERPRETER`）之外，按工作区探测 `.venv/bin/python`，或支持 `uv` 前缀；**不**自作主张改 `sys.path`；探测不到时回落当前解释器。验收按条目：有 / 无 `.venv` 两态各一例，且解释器路径写进回执。

## 调研

（待写 —— 用户指示：新建追踪文档后、调研前先停下。已预置的核实点：`src/probe.ts` 现有探测顺序、`pythonPath` / `SCRIPT_PY_INTERPRETER` 生效链、回执里解释器路径的现有口径。）

## 决策

（待写。待决点：探测顺序（显式覆盖 > .venv > uv 前缀 > 回落）与 `uv` 支持方式、解释器路径进回执的字段。）

## 规划

任务拆分：

- 定探测顺序与 `uv` 前缀支持方式。
- 改 `src/probe.ts`，补有 / 无 `.venv` 两态用例与解释器路径回执断言；同步 README 探测表。

计划改动文件清单（预估）：

- `script-interpreter/src/probe.ts`（探测顺序）
- `script-interpreter/tests/**`（两态用例）
- `script-interpreter/README.md`（探测表）
- 本追踪文档

明确不做：不改 `sys.path`；不创建虚拟环境；不做语言层面的其它探测。

## 实现记录

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
