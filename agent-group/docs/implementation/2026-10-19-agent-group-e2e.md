# agent-group 真机联调全流程（接取条目：agent-group/docs/BACKLOG.md「真机联调未做（两个会话各挂本插件跑通全流程）」）

状态：规划　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

起两个真机会话（各挂 session-channel / session-paths / agent-group），一个建组并把另一个加为成员，跑通 `create_group → add_member → link → send → check → remove`；确认 `<会话目录>/agent-group.json` 真实落点且为 0600，memory-base 已挂时能按 `search({kind: "agent_group"})` 检索到镜像行；验收按条目：上述流程真机走通，回报正文与成因在 `check` 结果里正确出现。预期无代码改动，除非联调暴露问题。

## 调研

（待写 —— 用户指示：新建追踪文档后、调研前先停下。）

## 决策

（待写。）

## 规划

任务拆分：

- 起两个会话（各挂 session-channel / session-paths / agent-group），执行全流程动作。
- 核对状态文件路径与 0600；memory-base 挂载时按 `kind: "agent_group"` 检索镜像行。
- 联调暴露的问题：登记新 BACKLOG 条目（另立任务），不在本任务内改代码。

计划改动文件清单（预估）：

- 本追踪文档
- 无代码改动预期；若暴露问题，在 agent-group/docs/BACKLOG.md 追加条目并交其他 agent（本任务不落修复代码）
- 两会话的启动动作为 profile 侧手工操作，不落仓库

明确不做：不做二期能力（广播 / 平等连接 / TUI 入口 / 轮次）；不改协议版本。

## 实现记录

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
