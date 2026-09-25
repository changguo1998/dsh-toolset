# dsh-toolset

DSH（DeepSeek Harness）进程内集成插件工具集：以 cordis bundle 方式挂载进 DSH 会话进程的一组 TypeScript 插件，补齐任务树、知识库与记忆、目标契约、指标循环等能力；另含一套自研终端 UI（TUI），是 Web UI / CLI 之外的第三种交互方式。

面向 agent 的协作规范见根目录 `AGENTS.md`；跨插件共享的 DSH 契约研读笔记见 `DSH-CTX-API.md`（只读，版本口径 `dsh-v0.1.5-rc.3`）。

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
├── presets/              # agent preset 资产（example：官方 standard 组合克隆，安装名由脚本给；见 presets/README.md）
├── profiles/             # profile 配置示例（example：清单 + 用户层 patch + pnpm 三件套；见 profiles/README.md）
├── scripts/              # install.sh（新机器一键安装）；测试调度脚本
├── docs/                 # 状态表、待办清单、架构对照与宿主包清单
├── archive/              # 已归档：完成的任务清单与历史调研记录
├── AGENTS.md             # 面向 agent 的协作规范（语言/命令/格式化/构建部署/变更流程）
├── DSH-CTX-API.md        # 跨插件共享研读笔记（只读）
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

新机器一键安装（装 dsh → 构建全部插件 → 建 profile 挂载 13 个包 → 装 agent preset → 设默认 preset）：

```sh
git clone <本仓库> && cd dsh-toolset
scripts/install.sh                 # profile 与 preset 名默认都是 fff
scripts/install.sh --help          # --profile/--preset/--plugins/--dsh-version/--force/--dry-run
```

脚本幂等：已存在的 profile / preset 文件默认保留，`--force` 才覆盖且先备份；只写 `$DSH_HOME`（默认 `~/.dsh`）与本仓库。

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

### agent preset（会话 agent 组合）

`presets/` 随仓库分发 agent preset 资产（`presets/example/` = 官方 `standard` 组合克隆，与本项目插件正交叠加：插件工具由 profile 全局注册，preset 只承载官方 agent 面）。**资产目录名固定为 `example`，安装后的 preset id = 安装目录名**（`scripts/install.sh --preset <名字>` 默认 `fff`）。手工部署（软链接三步：真实目录 + 文件软链接指向 `presets/example/`、设 `agent-presets.default`、重启）见 `presets/README.md`。

## 文档

- `AGENTS.md` — 面向 agent：语言约定、命令、格式化、构建部署到 profile、变更流程、结构约定、Git 规范。
- `docs/DEVELOPMENT-STATUS.md` — 插件开发状态追踪表（状态的唯一来源）。
- `docs/DEVELOPMENT-BACKLOG.md` — 未完成功能清单（P0/P1/P2）与里程碑。
- `TUI/DESIGN.md`、`TUI/SPEC.md`、`TUI/IMPLEMENTATION.md`、`TUI/COMMANDS.md`、`TUI/COMMANDS-SPEC.md` — TUI 设计、渲染规格、实现记录、命令面与命令扩展规格。
- `docs/AGENT-ARCHITECTURE-ANALOGY.md` — agent 架构与 DSH 接口对照（任务树、知识库插件的设计依据）。
- `docs/HOST-PACKAGES.md` — 宿主官方包清单（`dsh 0.1.5-rc.3` 的 240 个包，分类 + 关键包说明 + fff 挂载清单；宿主升级后需刷新）。
- `archive/PI-DSH-FEATURE-COMPARISON.md`、`archive/CODEMAP-RESEARCH.md` — 已归档的调研记录（pi→dsh 迁移基线与 code-map 选型快照，仅作历史参考；现状以状态表/待办清单为准）。
- `DSH-CTX-API.md` — 对齐官方 deepseek-harness 的核心契约研读笔记（只读参考）。
