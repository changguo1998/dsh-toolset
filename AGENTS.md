# AGENTS.md — dsh-toolset

本项目为 DSH（DeepSeek Harness）进程内集成插件工具集，包含 `TUI/` 终端界面包与 12 个进程内集成插件（herdr-integration / task-engine / knowledge-base / goal-contract / metric-loop / output-compress / fs-digest / hash-edit / ast-tools / security-guard / code-map / context-report）。

> 文档分工：根目录 `README.md` 面向人（项目总览、插件功能、快速开始、文档索引），本文件面向 agent（开发协作规范）；插件功能与当前状态见 `README.md` 与 `docs/DEVELOPMENT-STATUS.md`，`docs/` 其余文档与 `docs/host/DSH-CTX-API.md` 为设计/契约参考。

## 语言约定

- 文档、注释、commit message：**中文**（跟随现有代码与文档的既有风格）。
- 代码：`src/` 为 TypeScript，遵循 `tsconfig.json`（strict + noUncheckedIndexedAccess）。

## 命令

仓库根 `package.json` 委托全部子包（TUI / herdr-integration / knowledge-base / task-engine / ast-tools / fs-digest / goal-contract / hash-edit / metric-loop / output-compress / security-guard / code-map / context-report）：

```sh
npm run check   # 全部子包类型检查（tsc --noEmit）
npm run build   # 全部子包编译到 dist/
npm run test    # 全部子包测试并行运行（scripts/test-parallel.sh：GNU parallel 为主、xargs 兜底，node --test）
npm run demo    # TUI 构建并运行 mock demo（无 DSH 依赖）
npm run demo -- --smoke   # TUI 冒烟检查（帧断言 SMOKE_PASS）
npm run test:tui          # TUI 单包测试（开发迭代常用，避免全包并行）
```

`test:tui` 支持过滤：`-- <正则>` 按测试名跨文件过滤、`-- <文件>.test.ts` 只跑指定文件、两者可组合。实现为 `TUI/scripts/test.sh`——node `--test-name-pattern` 必须放在文件参数之前，而 `npm run x -- <arg>` 只追加到末尾，故由包装脚本把名字正则安插到正确位置。

单个子包内直接运行各自的 `npm run check / build / test / demo`（TUI 另有 `npm run bench` 排版性能基准、`npm run smoke:pty` 真机冒烟）。

新机器一键安装（装 dsh → 构建全部插件 → 建 profile 挂载 13 个包）：

```sh
scripts/install.sh          # profile 名默认 fff；幂等，--force 才覆盖
scripts/install.sh --help   # --profile/--plugins/--dsh-version/--skip-dsh/--skip-build/--dry-run
```

本项目只用 TUI：agent 面走 profile 全局组合，**不配置 agent preset**（依据见 `docs/host/AGENT-COMPOSITION.md`），改组合落 profile 用户 patch。

修改后至少跑 `npm run check`；涉及逻辑改动跑 `npm run test`。

## 格式化

- 默认用 `format` 命令（`/home/guochang/fff/scripts/format`，按扩展名选择格式化器：TS/JS → prettier、MD → mdformat、YAML → yq、JSON → jq 等）格式化改动文件；若项目引入自有格式化脚本（如 `package.json` 中的 `format`），则优先使用项目脚本。
- 提交前对本次改动的文件执行 `format <文件...>`。
- **例外（勿格式化）**：带注释的 YAML/JSON（`cordis.patch.yml`、`profiles/**/*.yml`）与生成的夹具 JSON（`tests/fixtures/*.json`）——yq 会吞掉注释、jq 会整体重排缩进，产生大片无意义 diff（已实测）；这类文件按原格式手工编辑。

## 构建 → 部署到 profile（本地迭代）

1. `npm run build` 编译到 `dist/`（产物性改动后按下方「变更流程」同步构建）。
1. profile（`~/.dsh/profiles/fff`，参见 `TUI/README.md` 挂载示例）以 `link:` 依赖指向本 TUI 包，构建产物经 symlink 实时可见，**无需** `pnpm install`——直接 `dsh --profile fff` 即生效。
1. 迭代回合：改代码 → `npm run build` → 重启 `dsh --profile fff`。
1. 勿用 `file:` 依赖：install 时复制快照且 pnpm v11 不跟踪目录内容变化，源码变更后 profile 报 `ERR_MODULE_NOT_FOUND`（已实测踩坑）。

## 变更流程

- 任何产物性变更（代码/配置）完成后必须执行 `npm run build` 重新构建，并由**人工确认变更效果**（如运行 `npm run demo` 或实际接入验证），人工确认通过后才允许后续提交（commit）。

## 结构与约定

- `TUI/src/app/` 状态与纯函数层（state/layout），`TUI/src/renderer/` 终端渲染层，`TUI/src/app/adapter/` 插拔适配层，`TUI/demo/` mock demo。
- 插件子包：`task-engine/`（任务执行引擎）、`knowledge-base/`（知识库与记忆）、`herdr-integration/`（herdr 面板桥）、`goal-contract/`（Done-when 契约起草）、`metric-loop/`（指标循环）、`output-compress/`（大输出摘要入库）、`fs-digest/`（文件摘要）、`hash-edit/`（LINE:HASH 锚定编辑）、`ast-tools/`（AST 搜索/替换/大纲）、`security-guard/`（危险命令与敏感文件防护）、`code-map/`（代码结构地图）、`context-report/`（会话上下文/用量报告）；各包的 `package.json` 带 `dsh.bundle` 集成契约与 `cordis.patch.yml`。
- 核心契约对齐官方 deepseek-harness：根目录 `docs/host/DSH-CTX-API.md` 为跨插件共享研读笔记（只读参考，勿改动）。
- 文档索引见 `README.md` 的「文档」一节（**唯一来源**，本文件不重复列清单）；分级：`docs/`（项目面：跨包现状与待办）、`docs/host/`（宿主面：**所有官方接口研读**与升级文档，升宿主后必复核）、`TUI/docs/`（TUI 面：STATUS / BACKLOG / SPEC / IMPLEMENTATION / COMMANDS，内部规范在 `TUI/docs/design/`）、各包 `README.md`（模块契约）、`archive/`（历史）。
- **TUI 的变更优先写 `TUI/docs/`**：现状 → `TUI/docs/STATUS.md`，待办与开放项 → `TUI/docs/BACKLOG.md`，规格与约定 → `TUI/docs/SPEC.md`、`TUI/docs/design/`；项目面 `docs/` 只保留跨包汇总与指针。
- **包内缺陷与待办写在该包的 `BACKLOG.md`**（如 `fs-digest/BACKLOG.md`；TUI 为 `TUI/docs/BACKLOG.md`），跨包项才写 `docs/DEVELOPMENT-BACKLOG.md`；改动行为时同步更新 `docs/DEVELOPMENT-STATUS.md`，功能完成时同步清理对应 BACKLOG。
- `archive/` 存放**已完成任务清单与历史调研**（如 `TUI-REFACTOR-TASKS.md`、`TUI-COMMANDS-TASKS.md`、`PI-DSH-FEATURE-COMPARISON.md`、`CODEMAP-RESEARCH.md`）：仅作历史记录，不是现状来源；当前口径以 `docs/DEVELOPMENT-STATUS.md`、`TUI/docs/STATUS.md`、`TUI/docs/SPEC.md`、`TUI/docs/IMPLEMENTATION.md`、`TUI/docs/COMMANDS.md`、`TUI/docs/COMMANDS-SPEC.md` 为准。
- DSH 集成契约以各包 `cordis.patch.yml` + `package.json` 的 `dsh.bundle` 为准。
- 设计/实现讨论沉淀在 `TUI/docs/design/DESIGN.md`、`TUI/docs/SPEC.md` 与 `TUI/docs/IMPLEMENTATION.md`，改动行为时同步更新。

## Git

- Conventional Commits（`feat:` / `docs:` / `fix:` …），语言用中文，粒度适中。
- 默认不主动 commit / push。
