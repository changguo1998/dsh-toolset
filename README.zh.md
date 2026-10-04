[English](README.md) | 中文

# dsh-toolset

DSH（DeepSeek Harness）进程内集成插件工具集：以 cordis bundle 方式挂载进 DSH 会话进程的一组 TypeScript 插件，补齐任务树、知识库与记忆、目标契约、指标循环等能力；另含一套自研终端 UI（TUI），是 Web UI / CLI 之外的第三种交互方式。

面向 agent 的协作规范见根目录 `AGENTS.md`；跨插件共享的 DSH 契约研读笔记见 `docs/host/DSH-CTX-API.md`（只读参考，按 `dsh-v0.1.7-rc.2` 基线逐条复核；0.2.0 对照确认本项目消费面无变化，差异与判定见升级对照文档）。

## 组成

仓库含 `TUI/` 终端界面包与 20 个进程内集成插件，均为独立 npm 包（`@dsh-toolset/*`）：

| 包 | 功能 |
|----|------|
| **TUI**（`TUI/`，`@dsh-toolset/tui`） | 终端 UI：会话/活动区/状态列/输入区四区布局，事件化渲染、slash 命令、会话切换与清理、模型/审批面板；**零运行时依赖**（源码零第三方 import，颜色走 manual ANSI） |
| **herdr-integration** | herdr 面板桥：agent 状态经 unix socket 上报 herdr 面板，并桥接 blocked 事件（ask-user 提问、approval 审批、turn 阻塞三类信号源） |
| **task-engine** | 任务树引擎：Frame 状态机、`decompose`/`implement`/`stop`/`status` 工具族、机械+语义双重门禁与 RET 验收路由 |
| **knowledge-base** | 跨会话知识库与持久记忆：`sources`/`chunks` 两张基表 + 两张 FTS5 虚表，两级写策略与淘汰提升，供其他插件经宿主共享面读写 |
| **goal-contract** | goal 会话契约起草：interview 式提问导出「目标 + Done-when 验证条款」（schema 对齐 task-engine 三级验收），落 dsh-goal 事件源 |
| **metric-loop** | 指标驱动自动循环：测量命令解析单个数字、plateau 平稳停止、轮数/时间/token 边界、cadence 自动唤醒 |
| **output-compress** | 大输出压缩入库：超阈值命令/工具输出的确定性摘要 + 切片索引写入 knowledge-base 共享库，原始大输出不进模型上下文 |
| **fs-digest** | 上下文感知文件读取：`outline`/`signatures`/`pruned` 三模式返回最小充分上下文，替代整文件 `read` |
| **hash-edit** | LINE:HASH 锚定编辑：读取得到每行内容哈希锚点，编辑按锚点定位，内容过期（stale）整批拒绝、防脏写 |
| **ast-tools** | 基于 ast-grep 的 AST 结构搜索、结构化替换、文件大纲与 YAML 规则执行（经系统 CLI 子进程，零运行时依赖）；注册模型侧工具 `ast_query`（AST 搜索 / 大纲 / 规则）与 `ast_replace`（默认 dry-run） |
| **md-logic** | Markdown 逻辑结构（单文件，读 + 按节改写）：节树（每节带 `L{起}-{止}` 行范围）、块清单（列表 / 表格 / 代码块 / 引用 / frontmatter / html / hr，带嵌套层数与表格行列数）与链接 / 图片 / 引用式定义清单；注册模型侧工具 `md_logic`（读面 `structure` / `blocks` / `links`，写面 `replace` 按节整节替换 / 删除），解析基于 `marked` |
| **md-map** | Markdown 项目级结构与引用分析（文档版的 `code-map`）：索引 `**/*.md` 的标题锚点、文档间链接（`internal`）、wiki 链接、行内代码路径引用（`kind:ref`）、代码 / 文件 / 目录引用与站外链接，以及被引计数，查询面 `callers` / `impact` / `orphans` / `report`（含断链与断锚点）；注册模型侧工具 `md_map`，单文件解析复用 `md-logic` |
| **security-guard** | 安全守卫：危险命令黑名单 + 敏感文件保护策略层，挂在宿主 `tools/pre-execute` 水位线，命令下发前拦截 |
| **code-map** | 代码结构地图：文件节点 + import 图索引，`callers`/`callees`/`cycles`/`impact` 查询与项目/模块报告（引用为候选：`callers` 的语义精度需官方 LSP 三件套，而 profile 不分发它，故回落 `structural`）；经 `link:` 依赖 `@dsh-toolset/ast-tools`（挂载时需一并安装） |
| **context-report** | 会话上下文与用量报告：host-only 投影 `sessionContext` 折叠会话累计（回合/步、模型与工具墙钟、首 token、token 分桶），工具 `context_report` 合成 token-meter 即时压力与模型容量读数 |
| **rule-engine** | 规则触发的自动注入：按关键词/正则/内置谓词匹配模型正文、工具调用与回合边界，命中后作为独立新回合（`followup`）、挂到最近 pre-step 并唤醒（`steer`）或不唤醒（`inject`）注入 user-role 消息；提供按节点的消费者注册面（`registerConsumer`，`sources` 缺省 `turn-end`，同步询问、统一注入）与只读 `evaluate` |
| **symbol-normalizer** | 符号规范：模型正文符号的展示层归一（别名替换）+ 回合审查（人类 notice / 模型反馈），以 rule-engine 消费者形式接入；provide `symbolNormalizer` 服务供 TUI 消费 |
| **ponytail** | ponytail 模式（2026-10-05 起缺省开启；`enabled: false` 关闭）：会话起始注入「懒资深工程师」7 级决策阶梯（YAGNI → 复用 → 标准库 → 平台特性 → 已装依赖 → 一行 → 最少代码）。 |
| **session-channel** | 跨会话消息通道（专用 Redis 实例 + unix socket）：`peers`/`send`/`inbox`/`status`，消息注入目标会话的下一回合（形如 `[CHANNEL](来源) 正文`）；provide `sessionChannel` 服务（含别名、共享 KV：last-value + 版本号，以及跨会话委托：`channel_delegate`/`channel_task`/`channel_task_result` + 任务表 + 结果自动/显式回传） |
| **session-title-cutoff** | 会话标题 provider：触发保持 all-prompts，参考窗口改为「最近一次 `git commit` 之后」的人类消息（无提交/窗口为空回退全量）；接管 `ctx.sessionTitle` 唯一 provider，需在 profile 禁用官方 all-prompts 实现 |
| **command-template** | 模板体系：把提示词流程写成 `.md` 模板（YAML 子集 front-matter）并统一经一个 slash 命令调用（`/playbook <模板> [参数]`，另有 `list` / `show` / `reload` 子命令）——双源目录（随包 `templates/` + 用户 `~/.dsh/command-templates`，同名用户优先）、步骤 `prompt`（注入当前会话）与 `agent`（一次性子代理，可覆盖模型且仅本次生效）、`{{stepId}}` 串链、`bestOf` + `judge` 裁判 |

各包 `package.json` 均携带 `dsh.bundle` 集成契约与 `cordis.patch.yml`；功能细节见各包 `README.md`，开发状态见 `docs/STATUS.md`。

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
├── md-logic/            # Markdown 逻辑结构（节树 + 块 + 链接，带行范围，模型工具 md_logic）
├── md-map/              # 文档版 code-map（锚点 / 引用 / 影响面 / 断链，模型工具 md_map）
├── security-guard/       # 危险命令与敏感文件防护
├── code-map/             # 代码结构地图（符号/import 图、查询与报告）
├── context-report/       # 会话上下文/用量报告（sessionContext 投影 + context_report 工具）
├── rule-engine/          # 规则触发的自动注入（规则 / 消费者面 + 注入器）
├── symbol-normalizer/    # 符号规范（展示归一 + 回合审查，rule-engine 消费者）
├── ponytail/             # ponytail 模式（决策阶梯注入；rule-engine 消费者；缺省开启）
├── session-channel/      # 跨会话消息通道（专用 Redis 实例 + unix socket）
├── session-title-cutoff/ # 会话标题 provider（all-prompts 触发不变，参考窗口=最近一次 git commit 之后）
├── command-template/     # 模板体系（slash 命令模板 + 模板级模型选择，双源模板目录）
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

新机器一键安装（装 dsh → 构建全部插件 → 建 profile 挂载 21 个包：TUI + 20 个插件）：

```sh
git clone <本仓库> && cd dsh-toolset
scripts/install.sh                 # profile 名默认 fff
scripts/install.sh --help          # --profile/--plugins/--dsh-version/--skip-dsh/--skip-build/--force/--sync/--take-over-title/--dry-run/--skip-verify
```

脚本幂等：已存在的 profile 配置文件默认保留，`--force` 才覆盖；仅当内容确有变化时才写入并备份（`.bak.<时间戳>`），反复 `--sync` 不会堆积备份文件。`--sync` 按**当前选择集**刷新本仓库插件：已不在选择集的本仓库条目（依赖与 bundle）会被**移除**，而非本仓库条目（用户自加依赖 / 额外 bundle）一律保留；移除项会打日志。只写 `$DSH_HOME`（默认 `~/.dsh`）与本仓库。`--sync` **不改写** `cordis.patch.yml` 的标题 provider 配置：禁用官方 all-prompts 标题 provider 是显式选择（`--sync --take-over-title`），不带开关时只在检测到冲突时提示。`--sync --force` 组合被拒（会覆盖 patch、丢掉生成的接管片段）。生成片段按 patch 内容重建，故幂等：带开关重跑只补缺（provider/model 可读后自动重试），**删除**以 `# install.sh generated: title-takeover-` 开头的生成片段即放弃接管。

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

索引只此一处（`AGENTS.md` 不重复列清单）；每份文档开头三行写明「职责 / 不负责 / 过期条件」。

变更流程分两条：标准流程见 `docs/WORKFLOW-STANDARD.md`（详版）、小改动快速流程见 `docs/WORKFLOW-FAST.md`，简版见 `AGENTS.md`「内容变更规范」：条目在 `BACKLOG.md`，过程记录写进追踪文档，关闭后移入 `archived/`（快速流程免条目与追踪文档）。

**项目级（`docs/`）**

- `docs/ROADMAP.md` — 未来开发方向与完成判据（进度、排期与条目见 `docs/BACKLOG.md` §3 里程碑）。
- `docs/BACKLOG.md` — 可执行条目：跨包功能与缺陷（P0/P1/P2）+ 里程碑 + 插件规划。
- `docs/STATUS.md` — 对照文档：记录已实现的内容（由维护者择时更新）。
- `docs/ARCHITECTURE-REUSE.md` — 复用审计：逐包（审计基线为 TUI + 17 包；`md-logic` / `md-map` / `ponytail` 为后加，总表已补行）「官方是否有等价物」与「改用 / 保留 / 并存」结论及理由。
- `docs/WORKFLOW-STANDARD.md` — 内容变更规范 · 标准流程（详版）。
- `docs/WORKFLOW-FAST.md` — 内容变更规范 · 快速流程（小改动）。
- `docs/implementation/`、`docs/archived/` — 跨包条目的追踪文档（进行中 / 已关闭）。

**宿主面（`docs/host/`，不参与变更流程，升宿主后必复核）**

官方接口研读与升级文档的集中地——**不限 dsh-base**：任何宿主官方接口（ctx API、各子系统与子包的契约）的研读笔记都放这里。

- `docs/host/DSH-CTX-API.md` — 宿主 ctx 接口研读笔记（跨插件契约，只读参考）。
- `docs/host/HOST-PACKAGES.md` — 宿主官方包与服务字典（生成物，升宿主后重新生成）。
- `docs/host/HOST-UPGRADE-0.2.0-rc.2.md` — 当前升级对照（0.1.7-rc.2 → 0.2.0-rc.2）与实施状态；上一份 `docs/host/HOST-UPGRADE-0.1.7-rc.2.md`（0.1.5-rc.3 → 0.1.7-rc.2）。
- `docs/host/AGENT-COMPOSITION.md` — agent 面组合现状与官方依据（TUI 走 profile 全局组合、不配 preset）。
- `docs/host/AGENT-ARCHITECTURE-ANALOGY.md` — 官方 agent 架构与接口对照（task-engine、knowledge-base 的设计依据）。

**模块级（`TUI/docs/`、`<包>/docs/`）**

- `TUI/README.md`、`<包>/README.md` — 模块入口：用法、配置、契约、边界。
- `TUI/docs/DESIGN.md`、`<包>/docs/DESIGN.md` — 架构设计与机制取舍（`TUI`、`task-engine`、`knowledge-base`、`session-channel`、`code-map`、`rule-engine`、`symbol-normalizer`、`output-compress`、`ponytail`、`command-template`、`md-logic`、`md-map` 有；轻量包只留 `README.md` + `docs/BACKLOG.md`）。
- `TUI/docs/SPEC.md` — 渲染管线规格；`TUI/docs/COMMANDS.md`、`TUI/docs/COMMANDS-SPEC.md` — 命令清单与扩展规格。
- `TUI/docs/design/` — TUI 内部规范：`NOTICE-LEVELS.md`（提示分级）、`AUDIT-colors.md`（配色语义）、`REFACTOR.md`（模块拆分约定）。
- `<模块>/docs/BACKLOG.md` — 模块待办（`TUI`、`task-engine`、`rule-engine`、`symbol-normalizer`、`session-channel`、`md-logic`、`md-map`、`command-template`、`ast-tools`、`fs-digest`、`hash-edit`、`code-map` 已建，其余按需）；`<模块>/docs/STATUS.md` — 模块级对照文档（TUI 已有）。

**协作与历史**

- `AGENTS.md` — 面向 agent 的协作规范（语言、命令、格式化、构建部署、变更流程、内容变更规范简版、结构约定、Git）。
- 根 `archive/` — 根级历史（已完成清单、历史调研、旧版契约快照、完成使命的升级文档）；模块历史进 `<模块>/docs/archived/`。
- 不维护 `CHANGELOG.md`：变更记录以 `git log`（Conventional Commits）与 `docs/host/HOST-UPGRADE-*.md` 为准。
