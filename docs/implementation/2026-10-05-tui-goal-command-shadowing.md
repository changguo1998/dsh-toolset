# TUI `/goal` 与官方命令双注册（接取条目：`docs/BACKLOG.md`「TUI `/goal` 与官方命令双注册」）

状态：调研　　开启：2026-10-05　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把「TUI 本地 `/goal` 覆盖宿主同名命令」这件事从**隐式行为**变成**显式契约**，并确认宿主命令缺失 / 改名时的降级路径可见。

## 调研

来源：本仓源码实测（`grep` + 逐文件阅读）与官方包 lib 阅读，无真机运行。

### 覆盖机制

`routeSlashCommand`（`TUI/src/app/commands.ts:349-350`）实现为：

```ts
export function routeSlashCommand(name: string): SlashRoute {
  return LOCAL_ROUTES.get(name) ?? "registry";
}
```

`LOCAL_ROUTES` 由 `LOCAL_COMMANDS` 在模块加载时构建（`commands.ts:344-347`）。因此**本地表命中即走本地分支，宿主注册表里是否有同名命令不被查询** —— 覆盖是隐式的，代码里没有任何声明。

### `/goal` 的两个分支

`TUI/src/app/index.ts:2781-2789`：

- **无参**（`line.slice("/goal".length).trim() === ""`）→ 发 notice「goal/todo 详情见左侧信息栏」，直接 return —— **完全不走宿主**；
- **带参** → `this.deps.adapter.runCommand(line)`，整行原样转交宿主。

### 官方侧

`dsh-command-goal` 注册名确为 `goal`（lib 中 `name: "goal"`），package 描述「Human-facing slash command for persisted same-session goals」，内含 `clear` / `resume` 子命令。

### 缺失命令的降级路径（关键结论）

转发链路：`runCommand`（`TUI/src/app/adapter/dsh.ts:2574`）→ `dispatchCommand`（`:3795`）→ `commands.execute(...)`（`:3820`）→ `finish`（`:3846`）。

`finish` 在 `exec === undefined` 时：

```ts
emit({ type: "notice", text: "未知命令，输入 /help 查看可用命令。", error: true, tone: "error" });
```

即**宿主命令缺失时已有可见降级**（error notice + 失败色），另有 `commands` 服务未就绪的前置告警（`dsh.ts:3806-3814`）。条目验收里的「不可静默失配」**当前已经成立**。

### 已有测试

- `TUI/tests/app.test.ts:3867` —— `/goal` 无参只提示、不开面板；
- `TUI/tests/app.test.ts:3879` —— `/goal <objective>` 带参转交宿主，断言转发内容为 `["/goal 打磨状态列"]`。

### 残余风险

1. **语义分叉**：宿主 `/goal` 无参时的行为被 TUI 遮蔽（宿主可能也展示状态），两处文案会随各自演进而分叉；
1. **无契约记录**：本地覆盖宿主同名命令这件事没有写进注释、README 或 DESIGN，下一个人改命令表时不会知道存在这个约束；
1. **改名/改参不可测**：官方若把 `goal` 改名或改参数形态，TUI 转发会落到「未知命令」（可见），但**没有测试**守住这个边界。

## 决策

（待定；调研已给出结论：验收的「可见降级」一条已满足，剩余工作是把覆盖语义显式化）

## 规划

**计划改动文件清单（待决策后收敛；未列出的文件一律不改）**

- `TUI/src/app/commands.ts` —— `LOCAL_COMMANDS` 中 `goal` 条目补覆盖语义注释（或集中声明「本地可覆盖宿主同名命令」）
- `TUI/src/app/index.ts` —— `case "goal"` 的转发分支补一句说明与断言
- `TUI/tests/app.test.ts` —— 补一条「宿主无 `goal` 命令 → 落到未知命令的可见降级」用例
- `TUI/docs/DESIGN.md` 或 `TUI/README.md` —— 记录覆盖口径

**明确不做**

- 不改命令名（`/goal` 是用户肌肉记忆，改名成本高于收益）
- 不改动官方包
- 不动无参分支的文案（除非决策阶段另有结论）

## 实现记录

- 2026-10-05：接取条目并标记「进行中」；完成现状调研（见上），**无代码改动**。

## 测试与证据

（待实现后补）

## 收尾

（待关闭时补）
