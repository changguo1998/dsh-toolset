# 其余包接入定时器统一面 `clock`（接取条目：`docs/BACKLOG.md` §2「3. 其余包接入定时器统一面 `clock`」）

状态：进行中（仅接取：本文档已建，调研未开始；本期未排期）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把各包里的裸 `setInterval` / `setTimeout` 换成 `timer` 插件提供的 `clock` 服务（`now` / `schedule` / `interval`），使排期随调用方 fiber 卸载自动撤销、测试可注入 `ManualClock`。

交付：8 个包（`herdr-integration` / `herdr-use` / `script-interpreter` / `rule-engine` / `task-engine` / `auto-approve` / `ast-tools` / `command-template`）的逐包改造 + 假时钟断言 + 服务缺失时的降级（退回裸定时器并告警一次）。

边界：不动 TUI 内部的渲染节律定时器（34 处，另有专门考量）；不改 `timer` 的服务面（除非调研发现必须补键）。

## 调研

（待填；2026-10-22 计数：`herdr-integration` 5、`herdr-use` 5、`script-interpreter` 2、`rule-engine` 2、`task-engine` 1、`auto-approve` 2、`ast-tools` 1、`command-template` 1；TUI 内部 34 处不在本条范围）

## 决策

（待填；需定「可注入」的判据与降级告警口径）

## 规划

### 计划改动文件清单

（初判，调研后定稿）

- 上述 8 个包的 `src/` 与各自测试（假时钟断言）
- `timer/README.md`（若服务面需补充口径）

### 验收

（初判）

- 每包卸载后无残留排期；`check` / `test` 全绿；服务缺失降级用例存在
