# check / build 根委托链并行化（接取条目：docs/BACKLOG.md「check / build 根委托链并行化」）

状态：进行中　　开启：2026-11-08　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 根 `pnpm run check` / `build` 由 38 包串行 `&&` 链改为与 `test` 同款并行调度：复用或扩展 `scripts/test-parallel.sh` 的 parallel / xargs 两路、`set -u` 累计退出、包清单双向校验、只跑存在的包。
2. 根 `package.json` 三链（check / build / test）统一一个并行入口（如扩展 `TEST_SCRIPT=check|build`, 或新 `scripts/run-all.sh <check|build|test> [包...]`）。
3. 处理 build 依赖序：`code-map` / `md-map` 在 `ast-tools` / `md-logic` 之后构建（复用 `install.sh` 已实现的排序）。
4. 保持失败汇总语义与 `test-parallel.sh` 一致（不 fail-fast）；全仓 check / build / test 行为不回退, 相关测试全绿。
