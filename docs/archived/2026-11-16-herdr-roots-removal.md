# herdr 状态检测失效（agents.roots() 在 rc.3 被移除）（接取条目：`docs/BACKLOG.md`「herdr 状态检测失效」）

状态：完成　　开启：2026-11-16　　关闭：2026-11-16
本文件是本任务唯一的追踪文档；本条目为 rc.3 升级引入的功能退化，修复代码已先行提交（`960c3d3c`），本文件补齐其记录，用户 2026-11-16 实机确认后关闭。

## 目标

恢复 herdr 面板「正忙 / 待机」状态判定：`herdr-integration` 需要在 rc.3 宿主上重新枚举顶层 agent，并保持对 rc.1 服务面的兼容回退。

## 根因

- 状态判定读 `ctx.get('agents').roots()`，取顶层 agent（rc.1 实现即 store 里 `owner === undefined` 者）后按 `status` 判 `running`。
- 宿主 rc.3 已移除 `roots()`，服务面只剩 `get(id)` / `list()` → `roots()` 恒空 → `agentActive` 恒 false → 面板一直报「待机」。
- 期望口径：顶层 agent 等价于「无父会话」，`list()` 全量里 `session.header.parentSession === undefined` 者为根；子代理由 `childSessionMeta` 写入 `parentSession` 且 `origin: 'subagent'`，须排除。

## 改动

- `herdr-integration/src/index.ts`：`RootAgentLike` 增补 `session.header.parentSession`；`readRoots` 先试 `roots()`（rc.1 兼容回退），不可用再经 `list()` 派生并按 `parentSession` 过滤子代理；文件头插件依赖注释同步 rc.1 / rc.3 两种取法。
- `herdr-integration/tests/integration/plugin.test.ts`：新增「服务面无 roots()、经 list() 派生根并过滤子代理」用例（子代理 running 不翻转面板、根回 idle 时面板跟随回 idle）。

## 测试与证据

- `herdr-integration`：check 通过、单测 60 全绿、集成 12 全绿、build 通过。
- 真机探针确认根 / 子会话 header 判定前提（根无 `parentSession`，子代理带 `parentSession` + `origin: 'subagent'`）。
- 2026-11-16 用户 herdr 面板实机确认：正忙 / 待机切换恢复正常。

## 收尾

- 归档：本文件移入 `docs/archived/`。
- BACKLOG：条目从 `docs/BACKLOG.md` §2 清理移除。
- 提交：`fix(herdr-integration)` 修复提交 `960c3d3c` + 本文件与条目清理的收尾提交。
