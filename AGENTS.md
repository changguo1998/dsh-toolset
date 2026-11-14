# AGENTS.md — dsh-toolset

本项目为 DSH（DeepSeek Harness）进程内集成插件集，包含 `TUI/` 终端界面包与 39 个进程内集成插件（共 40 个包）。

> 文档分工：根 `README.md` 面向人（项目总览、插件功能、快速开始、文档索引；英文主档 + `README.zh.md`），本文件面向 agent（协作规范，只留每次会话必读的行为规则）；查用型内容在别处——命令全量 / 一键安装 / 构建部署到 profile 见 `docs/DEVELOPMENT.md`，包清单与逐包职责见 `docs/PACKAGES.md`；变更规范详版分两份：`docs/WORKFLOW-STANDARD.md`（标准）、`docs/WORKFLOW-FAST.md`（快速）；状态对照见 `docs/STATUS.md`，宿主面知识与升级记录见 `docs/host/`。

## 语言约定

- 文档、注释、commit message：**中文**（跟随现有代码与文档的既有风格）。
- **例外：根 `README.md` 为英文主档**，中文版同目录 `README.zh.md`（命名随宿主 dsh 包惯例：英文 `README.md` + 中文 `README.zh.md`，点号分隔、语言码小写）。改动任一侧时同步另一侧，保持逐节同构；各包 `README.md` 仍为中文。
- 代码：`src/` 为 TypeScript，遵循 `tsconfig.json`（strict + noUncheckedIndexedAccess）。
- 符号规范：只用这 39 个符号：`✓ ✗ △ → ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ▶ ◀ ▲ ▼ ▷ ◁ ▽ ⟸ ⟹ ⟺ ⇆ ⟳ ↻ • ◦ ○ ◌ ● ◯ ■ □ ◇ ◆ ⓘ 〜 …`；表格与列表优先 `✓` / `✗` / `-` / `*` / `[x]`，装饰性强调用文字，不用 emoji 与列宽不定、带填色的字符。变体按固定映射替换：`✔` → `✓`、`✅` → `✓`、`☑` → `✓`、`🗸` → `✓`、`🗹` → `✓`、`✕` → `✗`、`✖` → `✗`、`✘` → `✗`、`❌` → `✗`、`🗙` → `✗`、`☒` → `✗`、`🗷` → `✗`、`⚠` → `△`、`➔` → `→`、`➜` → `→`、`➡` → `→`、`➠` → `→`、`➢` → `→`、`➣` → `→`、`⬅` → `←`。行内代码与围栏代码块内的符号不参与审查。
- 术语：明细与替换表见 [docs/GLOSSARY.md](docs/GLOSSARY.md)。高频口径：指代码模块用「包」，数插件写「插件」（本仓 40 个包 = TUI 与 39 个插件）；过程记录写「追踪文档」；符号规则写「符号规范」；模型可见工具面写「工具面」；界面名统一为（状态列 / 会话区 / 回合区 / 工具区 / 状态行 / 输入区 / 提示行），旧称由 `dev/standard` 的 `term.interface` 规则守着；「退化」指行为变差，「守成测试」指重跑旧用例确认未破坏旧行为。

## 常用命令

```sh
pnpm run check        # 全部子包类型检查（tsc --noEmit；每次改动后至少跑这个）
pnpm run build        # 全部子包编译到 dist/（产物性改动后必跑；并行）
pnpm run test         # 全部子包测试并行运行（逻辑改动后跑）
pnpm run test:tui     # TUI 单包测试（开发迭代常用，避免全包并行）
pnpm run check:docs   # 文档与注释标准检查（改动文档后跑；--strict 警告也算失败）
```

修改后至少跑 `pnpm run check`；逻辑改动跑 `pnpm run test`。命令全量（`test:tui` 过滤、单包子包命令、`demo` / `smoke`）、新机器一键安装与构建部署见 `docs/DEVELOPMENT.md`。

## 格式化

- 默认用 `format` 命令（`/home/guochang/fff/scripts/format`，按扩展名选择格式化器：TS/JS → prettier、MD → mdformat、YAML → yq、JSON → jq 等）格式化改动文件；若项目引入自有格式化脚本（如 `package.json` 中的 `format`），则优先使用项目脚本。提交前对本次改动的文件执行 `format <文件...>`。
- **例外（勿格式化）**：带注释的 YAML/JSON（`cordis.patch.yml`、`profiles/**/*.yml`）、首行是 YAML front matter 的 Markdown、生成的夹具 JSON（`tests/fixtures/*.json`）——yq 会吞掉注释、mdformat 会重写 front matter、jq 会整体重排缩进，产生大片无意义 diff（已实测）；这类文件按原格式手工编辑。

## 变更流程

- 任何产物性变更（代码/配置）完成后必须执行 `pnpm run build` 重新构建，并由**人工确认变更效果**（如运行 `pnpm run demo` 或实际接入验证），人工确认通过后才允许后续提交（commit）。

## 内容变更规范（简版）

任何改动（不论范围大小与种类：文档 / 代码 / 配置）默认走**标准流程**（本节各项）；**改动量少、逻辑简单直接**的小改动走**快速流程**——免条目与追踪文档（唯一记录是 commit message），验证不减（文档类 `format` + 自查 diff，代码类 `check` + `build` + `test`），提交前复核硬阈值（文件 ≤ 3 且增删合计 ≤ 50 行；不达标用三选一询问：转标准流程 / 维持快速流程 / 停手），完成后问一次是否提交；agent 判定后须先问用户（依据与选项写在正文，需要一次是非确认时用 `ask_user_question`；见 `docs/WORKFLOW-STANDARD.md` §5），同意才走，入口答否则不做处理、等用户新指示。详版见 `docs/WORKFLOW-STANDARD.md`（标准）与 `docs/WORKFLOW-FAST.md`（快速）。

分层：`docs/ROADMAP.md`（仅项目级，记方向）→ `<模块>/docs/DESIGN.md`（架构设计；**轻量包豁免**，见 `docs/PACKAGES.md`）→ `<层>/docs/BACKLOG.md`（可执行条目）→ `<层>/docs/implementation/<YYYY-MM-DD>-<slug>.md`（追踪文档）→ 关闭后移入 `<层>/docs/archived/`。本仓 40 个包 = TUI 与 39 个插件；跨模块条目归项目级。

1. **开工前**：对应层 `BACKLOG.md` 里要有可执行条目。
2. **开工时**：本次接取的**每个**条目标「进行中」（此后不再切状态）；建追踪文档——**一个任务可同时接取多个条目**，文件头按**条目标题**列出全部条目（**不写编号**），并先写「计划改动文件清单」。
3. **过程中**：所有文档变更只写这份追踪文档；**计划外文件一律不改**（不做「顺手改」）；途中发现的新问题记进追踪文档，并在 BACKLOG 追加新条目交其他 agent。
4. **完成时**：所接取的每个条目标「完成」，并在收尾时把对应已完成条目从 BACKLOG 清理移除（只留未完成项）；追踪文档移入 `docs/archived/`；随后按需回写 DESIGN / README / ROADMAP。
5. **提交询问点**：决策完成后 / 代码实现后 / 测试通过后 / 任务关闭后，各按 `docs/WORKFLOW-STANDARD.md` §5 的提问方式**阻塞**询问一次是否提交（未获同意不提交；答否则合并到关闭后）；**检查点必须经用户明确同意才能继续**（问答面板选择同意继续，或指令中有明确的继续下一步指令），未答 / 答非所问 / 仅提问 → 结束本回合并等待用户指令。各点范围与门禁：决策后仅提交文档；实现后先 `pnpm run check` + `pnpm run build` 再提交代码；测试后（人工确认通过之后）提交代码与测试用例；关闭后提交剩余全部相关变更，且为本次变更的**最后一次提交**（之后不得再有相关提交，残留另开条目）。详见 `docs/WORKFLOW-STANDARD.md` §5。
6. `STATUS.md` 是对照文档（记录已实现内容），由**用户择时更新**，流程内不改。

细则与追踪文档模板见 `docs/WORKFLOW-STANDARD.md`（快速流程见 `docs/WORKFLOW-FAST.md`）。

## 文档与结构约定

- 文档索引以根 `README.md` 的 `Documentation` 一节为**唯一来源**，本文件不重复列清单；结构：`docs/`（项目级）→ `docs/host/`（宿主面知识，升宿主后必复核，不参与变更流程）→ `dev/`（开发期辅助工具与规范，不参与构建与发布）→ `<模块>/docs/`（模块自管）→ 各包 `README.md`（模块契约）→ 根 `archive/`（根级历史，仅作历史，不是现状来源）。
- 包清单与各包一句话职责：`docs/PACKAGES.md`（含 TUI 目录要点与 `DESIGN.md` 轻重包口径）；各包详细用法 / 配置见其 `README.md`。
- 缺陷与待办写对应层 `BACKLOG.md`（模块 → `<模块>/docs/BACKLOG.md`；跨包 → `docs/BACKLOG.md`）；`STATUS.md` 由用户择时更新，勿自动改。
- 模块文档归模块自管；设计机制讨论沉淀在对应模块 `docs/DESIGN.md`（TUI 为 `TUI/docs/DESIGN.md`，渲染规格在 `TUI/docs/SPEC.md`）。
- DSH 集成契约以各包 `cordis.patch.yml` + `package.json` 的 `dsh.bundle` 为准；宿主契约对照见 `docs/host/DSH-CTX-API.md`（只读参考，勿改动）。

## Git

- Conventional Commits（`feat:` / `docs:` / `fix:` …），语言用中文，粒度适中。
- 默认不主动 commit / push。
