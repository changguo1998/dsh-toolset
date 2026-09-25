# dsh-toolset

DSH（DeepSeek Harness）进程内集成插件工具集：以 cordis bundle 方式挂载进 DSH 会话进程的一组 TypeScript 插件，补齐任务树、知识库与记忆、目标契约、指标循环等能力；另含一套自研终端 UI（TUI），是 Web UI / CLI 之外的第三种交互方式。

面向 agent 的协作规范见根目录 `AGENTS.md`；跨插件共享的 DSH 契约研读笔记见 `docs/host/DSH-CTX-API.md`（只读，版本口径 `dsh-v0.1.5-rc.3`）。

## 组成

仓库含 `TUI/` 终端界面包与 12 个进程内集成插件，均为独立 npm 包（`@dsh-toolset/*`）：

| 包 | 功能 |
|----|------|
| **TUI**（`TUI/`，`@dsh-toolset/tui`） | 终端 UI：会话/活动区/状态列/输入区四区布局，事件化渲染、slash 命令、会话切换与清理、模型/审批面板；运行时唯一依赖 `chalk` |
| **herdr-integration** | herdr 面板桥：agent 状态经 unix socket 上报 herdr 面板，并桥接 blocked 事件（ask-user 提问、approval 审批、turn 阻塞三类信号源） |
| **task-engine** | 任务树引擎：Frame 状态机、`decompose`/`implement`/`stop`/`status` 工具族、机械+语义双重门禁与 RET 验收路由 |
| **knowledge-base** | 跨会话知识库与持久记忆：`sources`/`chunks` 两张基表 + 两张 FTS5 虚表，两级写策略与淘汰提升，供其他插件经宿主共享面读写 |
| **goal-contract** | goal 会话契约起草：interview 式提问导出「目标 + Done-when 验证条款」（schema 对齐 task-engine 三级验收），落 dsh-goal 事件源 |
| **metric-loop** | 指标驱动自动循环：测量命令解析单个数字、plateau 平稳停止、轮数/时间/token 边界、cadence 自动唤醒 |
| **output-compress** | 大输出压缩入库：超阈值命令/工具输出的确定性摘要 + 切片索引写入 knowledge-base 共享库，原始大输出不进模型上下文 |
| **fs-digest** | 上下文感知文件读取：`outline`/`signatures`/`pruned` 三模式返回最小充分上下文，替代整文件 `read` |
| **hash-edit** | LINE:HASH 锚定编辑：读取得到每行内容哈希锚点，编辑按锚点定位，内容过期（stale）整批拒绝、防脏写 |
| **ast-tools** | 基于 ast-grep 的 AST 结构搜索、结构化替换、文件大纲与 YAML 规则执行（经系统 CLI 子进程，零运行时依赖） |
| **security-guard** | 安全守卫：危险命令黑名单 + 敏感文件保护策略层，挂在宿主 `tools/pre-execute` 水位线，命令下发前拦截 |
| **code-map** | 代码结构地图：文件节点 + import 图索引，`callers`/`callees`/`cycles`/`impact` 查询与项目/模块报告（引用为候选，无 LSP 语义层）；经 `link:` 依赖 `@dsh-toolset/ast-tools`（挂载时需一并安装） |
| **context-report** | 会话上下文与用量报告：host-only 投影 `sessionContext` 折叠会话累计（回合/步、模型与工具墙钟、首 token、token 分桶），工具 `context_report` 合成 token-meter 即时压力与模型容量读数 |

各包 `package.json` 均携带 `dsh.bundle` 集成契约与 `cordis.patch.yml`；功能细节见各包 `README.md`，开发状态见 `docs/DEVELOPMENT-STATUS.md`。

## 目录结构

```
dsh-toolset/
├── TUI/                  # 终端 UI 包（src/app 状态层、src/renderer 渲染层、src/app/adapter 适配层、demo/ mock）
├── herdr-integration/    # herdr 面板桥
├── task-engine/          # 任务树引擎
├── knowledge-base/       # 知识库与持久记忆
├── goal-contract/        # Done-when 契约起草
├── metric-loop/          # 指标循环
├── output-compress/      # 大输出摘要入库
├── fs-digest/            # 文件摘要（outline/signatures/pruned）
├── hash-edit/            # LINE:HASH 锚定编辑
├── ast-tools/            # AST 搜索/替换/大纲/规则
├── security-guard/       # 危险命令与敏感文件防护
├── code-map/             # 代码结构地图（符号/import 图、查询与报告）
├── context-report/       # 会话上下文/用量报告（sessionContext 投影 + context_report 工具）
├── profiles/             # profile 配置示例（example：清单 + 用户层 patch + pnpm 三件套；见 profiles/README.md）
├── scripts/              # install.sh（新机器一键安装）；测试调度脚本
├── docs/                 # 状态表、待办清单、agent 面组合说明、架构对照与宿主包清单
├── archive/              # 已归档：完成的任务清单与历史调研记录
├── AGENTS.md             # 面向 agent 的协作规范（语言/命令/格式化/构建部署/变更流程）
├── docs/host/DSH-CTX-API.md        # 跨插件共享研读笔记（只读）
└── package.json          # 根脚本：委托全部子包的 check/build/test
```

## 快速开始（构建与测试）

仓库根 `package.json` 委托全部子包：

```sh
npm run check   # 全部子包类型检查（tsc --noEmit）
npm run build   # 全部子包编译到 dist/
npm run test    # 全部子包测试并行运行（scripts/test-parallel.sh）
npm run demo    # TUI 构建并运行 mock demo（无 DSH 依赖）
npm run demo -- --smoke   # TUI 冒烟检查（帧断言 SMOKE_PASS）
npm run test:tui          # TUI 单包测试快捷入口（可接名字正则/文件名过滤）
```

单个子包内直接运行各自的 `npm run check / build / test / demo`（TUI 另有 `bench`、`smoke:pty`）。命令细节、并行调度参数与过滤用法见 `AGENTS.md`。

## 接入 DSH profile 使用

新机器一键安装（装 dsh → 构建全部插件 → 建 profile 挂载 13 个包）：

```sh
git clone <本仓库> && cd dsh-toolset
scripts/install.sh                 # profile 名默认 fff
scripts/install.sh --help          # --profile/--plugins/--dsh-version/--force/--dry-run
```

脚本幂等：已存在的 profile 配置文件默认保留，`--force` 才覆盖且先备份；只写 `$DSH_HOME`（默认 `~/.dsh`）与本仓库。

手工配置时各插件以 cordis bundle 方式挂载到 DSH profile。示例（`~/.dsh/profiles/fff`，详见 `TUI/README.md`）：

```jsonc
// <profile>/package.json
{
  "dependencies": { "@dsh-toolset/tui": "link:<本包路径>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsh-toolset/tui"] } }
}
```

本地开发期使用 `link:` 依赖，构建产物经 symlink 实时可见，无需重新安装；正式发布形态为 `dsh plugin --profile <p> add <包名>`。核对组合树用 `dsh --profile <p> --dump-config`，启动用 `dsh --profile <p>`。

仓库内 `profiles/example/` 是可直接复制的 profile 三件套示例（清单 + 用户层 patch + pnpm 配置），演示 `- id:` 覆盖与 `- insert:` 新增两种方言、`!!js` 表达式，以及权限预设表覆盖（自定义沙箱 + 审批捆绑预设）；部署步骤与边界见 `profiles/README.md`。

### agent 面组合（不使用 preset）

本项目只用 TUI，agent 面由 profile 的全局组合提供（`dsh-base` + 本项目 bundles + `cordis.patch.yml`），**不配置也不加载 agent preset**：官方设计里 TUI 是"没有 preset 的单组合面"，`/preset` 提示「agent 预设服务不可用」属正常。要改工具 / 提示 / 人格请落 profile 用户 patch；需要多套组合用多个 profile。官方依据、本机验证与 0.1.7 版本断层见 `docs/host/AGENT-COMPOSITION.md`。

## 文档

索引只此一处（`AGENTS.md` 不再重复列清单）；每份文档开头三行写明「职责 / 不负责 / 过期条件」。

**项目面（跨包：现状与推进）**

- `docs/DEVELOPMENT-STATUS.md` — 插件与宿主基线的现状快照（状态的唯一来源）。
- `docs/DEVELOPMENT-BACKLOG.md` — 跨包待办：缺陷 + 功能（P0/P1/P2）+ 里程碑 + 插件规划。

**宿主面（`docs/host/`，升宿主后必复核）**

官方接口研读与升级文档的集中地——**不限 dsh-base**：任何宿主官方接口（ctx API、各子系统与子包的契约）的研读笔记都放这里。

- `docs/host/DSH-CTX-API.md` — 宿主 ctx 接口研读笔记（跨插件契约，只读参考）。
- `docs/host/HOST-PACKAGES.md` — 宿主官方包与服务字典（生成物，升宿主后重新生成）。
- `docs/host/HOST-UPGRADE-0.1.7-rc.2.md` — 当前升级对照（0.1.5-rc.3 → 0.1.7-rc.2）与实施状态；下次升级另开新文件，本份移入 `archive/`。
- `docs/host/AGENT-COMPOSITION.md` — agent 面组合现状与官方依据（TUI 走 profile 全局组合、不配 preset）。
- `docs/host/AGENT-ARCHITECTURE-ANALOGY.md` — 官方 agent 架构与接口对照（task-engine、knowledge-base 的设计依据）。

**TUI 面（`TUI/docs/`，TUI 的变更优先写这里）**

- `TUI/README.md` — TUI 用法、配置项与命令行为表。
- `TUI/docs/STATUS.md`、`TUI/docs/BACKLOG.md` — TUI 现状、待办与开放项（含 herdr 外部问题取证）。
- `TUI/docs/SPEC.md` — 渲染管线规格；`TUI/docs/IMPLEMENTATION.md` — 实现记录。
- `TUI/docs/COMMANDS.md` — 命令清单（按本地 / 宿主注册层归属）；`TUI/docs/COMMANDS-SPEC.md` — 新命令的硬规格与排除项裁定。
- `TUI/docs/design/` — 内部设计与规范：`DESIGN.md`（机制与取舍）、`NOTICE-LEVELS.md`（提示分级）、`AUDIT-colors.md`（配色语义）、`REFACTOR.md`（模块拆分约定）。

**插件包**

- 各包 `README.md`（职责、契约、边界、测试命令）；`knowledge-base`、`output-compress`、`code-map` 另有 `DESIGN.md`。
- 包内缺陷与待办写在该包自己的 `BACKLOG.md`（如 `fs-digest/BACKLOG.md`；TUI 的是 `TUI/docs/BACKLOG.md`）。

**协作与历史**

- `AGENTS.md` — 面向 agent 的协作规范（语言、命令、格式化、构建部署、变更流程、结构约定、Git）。
- `archive/` — 已完成清单、历史调研、旧版契约快照与完成使命的升级文档；仅作历史记录，不作现状来源。
- 不维护 `CHANGELOG.md`：变更记录以 `git log`（Conventional Commits）与 `docs/host/HOST-UPGRADE-*.md` 为准。
