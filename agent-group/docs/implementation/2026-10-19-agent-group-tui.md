# agent-group TUI 命令或面板（接取条目：agent-group/docs/BACKLOG.md「TUI 命令或面板」）

状态：规划　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给 TUI 提供查看群组状态的入口（如 `/group` 命令或状态列），复用 agent-group 服务面 / 模型侧 `status` 工具结果，让人不必让模型调工具即可读组状态；实现归 TUI 模块。

## 调研

（待写 —— 用户指示：新建追踪文档后、调研前先停下。已预置的核实点：agent-group 服务面与 `status` 结果的可用形态、TUI 命令注册与状态列的既有机制（`TUI/docs/DESIGN.md` / `COMMANDS-SPEC.md`）。）

## 决策

（待写。待决点：命令 vs 状态列、呈现内容与刷新时机、与 agent-group 包的接线方式。）

## 规划

任务拆分：

- 定呈现形态（命令 / 状态列）。
- 在 TUI 侧接线 agent-group 服务面或复用 `status` 结果，实现只读视图 + 测试。

计划改动文件清单（预估；归 TUI 模块实现，跨包接线需与 agent-group 包对齐）：

- `TUI/src/app/**`（命令或状态列实现）
- `TUI/tests/**`（对应用例）
- `TUI/docs/COMMANDS.md` / `COMMANDS-SPEC.md` / `SPEC.md`（命令或状态口径，按需）
- 本追踪文档

明确不做：不做写操作命令（只读视图）；不改 agent-group 协议。

## 实现记录

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
