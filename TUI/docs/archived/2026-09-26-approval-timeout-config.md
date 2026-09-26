# 审批超时可配置（BACKLOG: TUI#3.3.7）

状态：关闭　　开启：2026-09-26　　关闭：2026-09-26

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

审批超时（1）默认值改为 **30s**；（2）作为可配置参数写入 TUI 配置文件 `tui.config.json`（`approval.timeoutMs`）。

## 调研

- 原先超时只能由宿主插件 config 的 `approvalTimeoutMs` 提供（`src/main.ts` 读 `config?.approvalTimeoutMs ?? 60_000`），**TUI 自己的配置段没有该项**；用户要求放进配置文件。
- TUI 配置：`src/app/config.ts` 的 `TuiConfig`（段：layout / notify / theme / session / symbols），文件名为 `tui.config.json`，按模块目录向上逐级定位；解析风格为「非法值忽略 → 回落缺省」。

## 决策

- `TuiConfig` 增 `approval?: TuiApprovalConfig`（`{ timeoutMs?: number }`），`normalizeApprovalSection`：非数字 / 非有限 / < 1000ms 一律**忽略**（不静默钳位，与其它段口径一致），否则取整。
- `src/main.ts` 优先级：`tui.config.json` 的 `approval.timeoutMs` > 宿主插件 config 的 `approvalTimeoutMs` > **缺省 30_000**。（装配点与配置文件读取不同作用域，故就地 `loadTuiConfig()` 一次。）
- `TUI/tui.config.json`（仓库中实际使用的配置）写入 `"approval": { "timeoutMs": 30000 }`。
- 文档：README 配置示例 + 说明项；SPEC §7.1 补优先级与缺省值。

## 测试与证据

- `tests/config.test.ts` 新增「审批段：approval.timeoutMs 解析与回落」：正常值 / 取整 / 低于 1s 忽略 / 非数字忽略 / 空段 / 未配置共 6 条断言。
- 全量 `node --experimental-transform-types --test tests/*.test.ts`：**1142 pass / 0 fail**；`npm run check` / `npm run build` 通过。
- 人工复验点：审批面板倒计时显示 `(30s)` 起始值；把 `tui.config.json` 的 `approval.timeoutMs` 改成别的值并重启后，倒计时随之变化。

## 收尾

- 条目 3.3.7 标「完成」；文档回写 `README.md`、`docs/SPEC.md`；本追踪文档归档 `TUI/docs/archived/`。
- 未做：交互式热重载（配置在启动时读取一次，与主题等段一致）。
