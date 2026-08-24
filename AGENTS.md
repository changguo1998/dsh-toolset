# AGENTS.md — dsh-toolset

本项目为 DSH（DeepSeek Harness）进程内集成插件工具集，目前包含 `TUI/` 终端界面包。

## 语言约定

- 文档、注释、commit message：**中文**（跟随现有代码与文档的既有风格）。
- 代码：`src/` 为 TypeScript，遵循 `tsconfig.json`（strict + noUncheckedIndexedAccess）。

## 命令（在 `TUI/` 目录下执行）

```sh
npm run check   # 类型检查（tsc --noEmit）
npm run build   # 编译到 dist/
npm run test    # 运行 tests/*.test.ts（node --test）
npm run demo    # 构建并运行 mock demo（无 DSH 依赖）
```

修改后至少跑 `npm run check`；涉及逻辑改动跑 `npm run test`。

## 结构与约定

- `TUI/src/app/` 状态与纯函数层（state/layout），`TUI/src/renderer/` 终端渲染层，`TUI/src/app/adapter/` 插拔适配层，`TUI/demo/` mock demo。
- 核心契约对齐官方 deepseek-harness：根目录 `DSH-CTX-API.md` 为跨插件共享研读笔记（只读参考，勿改动）。
- DSH 集成契约以 `TUI/cordis.patch.yml` + `package.json` 的 `dsh.bundle` 为准。
- 设计/实现讨论沉淀在 `TUI/DESIGN.md` 与 `TUI/IMPLEMENTATION.md`，改动行为时同步更新。

## Git

- Conventional Commits（`feat:` / `docs:` / `fix:` …），语言用中文，粒度适中。
- 默认不主动 commit / push。
