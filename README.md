English | [中文](README.zh.md)

# dsh-toolset

An in-process plugin toolset for DSH (DeepSeek Harness): a set of TypeScript plugins mounted into the DSH session process as cordis bundles, filling in capabilities such as task trees, a knowledge base with persistent memory, goal contracts, and metric loops. It also ships a homegrown terminal UI (TUI) — a third way to interact with DSH alongside the Web UI and the CLI.

For agent-facing collaboration rules, see `AGENTS.md` in the repository root. For DSH contract notes shared across plugins, see `docs/host/DSH-CTX-API.md` (read-only reference, re-checked clause by clause against `dsh-v0.1.7-rc.2`; the 0.2.0 comparison found no change on the surfaces this project consumes, and the differences are recorded in the upgrade comparison doc).

## Composition

The repository contains the `TUI/` terminal UI package and 20 in-process plugins, all standalone npm packages (`@dsh-toolset/*`):

| Package | What it does |
|----|------|
| **TUI** (`TUI/`, `@dsh-toolset/tui`) | Terminal UI: four-region layout (conversation / activity / status column / input), event-driven rendering, slash commands, session switching and cleanup, model and approval panels; **zero runtime dependencies** (no third-party imports in the source, colors via manual ANSI) |
| **herdr-integration** | herdr panel bridge: agent state is reported to the herdr panel over a unix socket, and blocked events are bridged across three signal sources (ask-user questions, approvals, turn blocking) |
| **task-engine** | Task tree engine: Frame state machine, the `decompose`/`implement`/`stop`/`status` tool family, mechanical + semantic dual gating, and RET acceptance routing |
| **knowledge-base** | Cross-session knowledge base and persistent memory: two base tables (`sources`/`chunks`) plus two FTS5 virtual tables, a two-level write policy with eviction and promotion, readable and writable by other plugins through the host's shared surface |
| **goal-contract** | Goal session contract drafting: interview-style questioning produces a goal plus Done-when acceptance clauses (schema aligned with task-engine's three-level acceptance), persisted to the dsh-goal event source |
| **metric-loop** | Metric-driven automatic loop: a measure command parses a single number, plateau stop, round/time/token bounds, cadence auto-wake |
| **output-compress** | Large-output compression into the store: deterministic digests of over-threshold command/tool output plus a slice index written to the shared knowledge-base store, so raw large output never enters the model context |
| **fs-digest** | Context-aware file reading: `outline`/`signatures`/`pruned` modes return the minimum sufficient context instead of a whole-file `read` |
| **hash-edit** | LINE:HASH anchored editing: reads return a content hash anchor for every line, edits locate lines by anchor, and stale content rejects the whole batch — no dirty writes |
| **ast-tools** | AST structural search, structured replacement, file outlines and YAML rule execution on top of ast-grep (through the system CLI as a subprocess, zero runtime dependencies); registers the model-facing `ast_query` (AST search / outline / rules) and `ast_replace` (dry-run by default) |
| **md-logic** | Markdown logical structure (single file, read + section-level rewrite): a section tree with per-section line ranges, a block inventory (list / table / code / quote / frontmatter / html / hr, with nesting depth and table dimensions) and a link / image / reference-definition inventory; registers the model-facing `md_logic` tool (`structure` / `blocks` / `links`), built on `marked` |
| **md-map** | Markdown project-level structure and reference analysis (the docs counterpart of `code-map`): indexes `**/*.md` for heading anchors, cross-doc refs (including inline-code path refs, `kind:ref`),ument links, wiki links, code/file references and backlink counts, with `callers` / `impact` / `orphans` / `report` queries (broken links and broken anchors included); registers the model-facing `md_map` tool and reuses `md-logic` for single-file parsing |
| **security-guard** | Security guard: a dangerous-command blacklist plus a sensitive-file protection policy layer, hooked into the host's `tools/pre-execute` watermark to intercept commands before they are dispatched |
| **code-map** | Code structure map: file nodes plus an import graph index, with `callers`/`callees`/`cycles`/`impact` queries and project/module reports (references are candidates, no LSP semantic layer); depends on `@dsh-toolset/ast-tools` via `link:`, so install both when mounting |
| **context-report** | Session context and usage report: the host-only `sessionContext` projection folds session totals (turns/steps, model and tool wall clock, first token, token buckets), and the `context_report` tool combines token-meter live pressure with model capacity readings |
| **rule-engine** | Rule-triggered automatic injection: matches model text, tool calls and turn boundaries by keyword/regex/built-in predicate, then injects a user-role message into the next turn (`followup`) or the nearest pre-step (`next-step`); exposes a consumer registration surface (`registerConsumer`, turn-end synchronous query with unified injection) and a read-only `evaluate` |
| **symbol-normalizer** | Symbol normalization: presentation-layer normalization of symbols in model text (alias substitution) plus turn review (human notice / model feedback), plugged in as a rule-engine consumer; provides the `symbolNormalizer` service for the TUI to consume |
| **ponytail** | Lazy senior dev mode (opt-in): injects a 7-rung ladder (YAGNI → reuse → stdlib → platform → installed deps → one line → minimal code) at session start. Off by default (overlaps `karpathy-guidelines`). |
| **session-channel** | Cross-session message channel (dedicated Redis instance + unix socket): `peers`/`send`/`inbox`/`status`, with messages injected into the target session's next turn (as `[CHANNEL](来源) 正文`); provides the `sessionChannel` service (aliases, shared KV with last-value + version number, and cross-session delegation: `channel_delegate`/`channel_task`/`channel_task_result` with a task table and automatic or explicit result return) |
| **session-title-cutoff** | Session title provider: keeps the all-prompts trigger but narrows the reference window to human messages after the most recent `git commit` (falls back to the full set when there are no commits or the window is empty); takes over as the sole provider of `ctx.sessionTitle`, so the official all-prompts implementation must be disabled in the profile |
| **command-template** | Template system: prompt flows declared as `.md` files (YAML-subset front-matter) and invoked through one slash command (`/playbook <template> [args]`) — dual-source directories (bundled `templates/` + user `~/.dsh/command-templates`, user wins), step types `prompt` (inject into the current session) and `agent` (one-shot subagent with per-run model override), chaining via `{{stepId}}`, `bestOf` + `judge`; plus a `/tpl` management command |

Every package's `package.json` carries the `dsh.bundle` integration contract along with a `cordis.patch.yml`; see each package's `README.md` for feature details and `docs/STATUS.md` for development status.

## Directory layout

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
├── ponytail/             # ponytail 模式（决策阶梯注入；rule-engine 消费者；缺省关闭）
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

## Quick start (build and test)

The repository root `package.json` delegates to all subpackages:

```sh
npm run check   # 全部子包类型检查（tsc --noEmit）
npm run build   # 全部子包编译到 dist/
npm run test    # 全部子包测试并行运行（scripts/test-parallel.sh）
npm run demo    # TUI 构建并运行 mock demo（无 DSH 依赖）
npm run demo -- --smoke   # TUI 冒烟检查（帧断言 SMOKE_PASS）
npm run test:tui          # TUI 单包测试快捷入口（可接名字正则/文件名过滤）
```

Inside a single subpackage you can run its own `npm run check / build / test / demo` directly (the TUI also has `bench` and `smoke:pty`). For command details, parallel scheduling flags and filter usage, see `AGENTS.md`.

## Wiring into a DSH profile

One-shot install on a new machine (install dsh → build all plugins → create a profile mounting 19 packages):

```sh
git clone <本仓库> && cd dsh-toolset
scripts/install.sh                 # profile 名默认 fff
scripts/install.sh --help          # --profile/--plugins/--dsh-version/--force/--dry-run
```

The script is idempotent: existing profile config files are kept by default, and only `--force` overwrites them (backing them up first). It writes only to `$DSH_HOME` (default `~/.dsh`) and this repository.

For manual setup, mount each plugin into a DSH profile as a cordis bundle. Example (`~/.dsh/profiles/fff`, see `TUI/README.md` for details):

```jsonc
// <profile>/package.json
{
  "dependencies": { "@dsh-toolset/tui": "link:<本包路径>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsh-toolset/tui"] } }
}
```

During local development, use `link:` dependencies: build artifacts are visible through the symlink immediately, with no reinstall. The release form is `dsh plugin --profile <p> add <包名>`. Inspect the composition tree with `dsh --profile <p> --dump-config`, and start with `dsh --profile <p>`.

`profiles/example/` in this repository is a ready-to-copy three-file profile example (manifest + user-layer patch + pnpm config); it demonstrates both dialects — `- id:` overriding and `- insert:` adding — as well as `!!js` expressions and permission preset table overrides (custom sandbox + approval-bundled presets). For deployment steps and boundaries, see `profiles/README.md`.

### Agent-side composition (no preset)

This project uses the TUI only, and the agent side comes from the profile's global composition (`dsh-base` + this project's bundles + `cordis.patch.yml`). **No agent preset is configured or loaded**: in the official design the TUI is "a single composition surface without a preset", so `/preset` reporting that the agent preset service is unavailable is expected. To change tools, prompts or persona, put it in the profile user patch; for multiple compositions, use multiple profiles. See `docs/host/AGENT-COMPOSITION.md` for the official basis, local verification, and the 0.1.7 version gap.

## Documentation

This is the only index (`AGENTS.md` does not repeat the list); every document opens with three lines stating "what it owns / what it does not own / when it expires".

There are two change flows: the standard flow in `docs/WORKFLOW-STANDARD.md` (full version) and the fast flow for small changes in `docs/WORKFLOW-FAST.md`, with the short version in `AGENTS.md` under "Content change policy": items live in `BACKLOG.md`, process records go into a tracking document, and closed ones move into `archived/` (the fast flow skips items and tracking documents).

**Project-level (`docs/`)**

- `docs/ROADMAP.md` — future development directions and completion criteria (progress, schedule and items live in `docs/BACKLOG.md` §3 milestones).
- `docs/BACKLOG.md` — actionable items: cross-package features and defects (P0/P1/P2) + milestones + plugin roadmap.
- `docs/STATUS.md` — reference document recording what has been implemented (updated by maintainers as needed).
- `docs/ARCHITECTURE-REUSE.md` — reuse audit: for each package (18 at audit time; `md-logic` / `md-map` added later), whether an official equivalent exists, plus the "reuse / keep / coexist" verdict and its reasons.
- `docs/WORKFLOW-STANDARD.md` — content change policy · standard flow (full version).
- `docs/WORKFLOW-FAST.md` — content change policy · fast flow (small changes).
- `docs/implementation/`, `docs/archived/` — tracking documents for cross-package items (in progress / closed).

**Host surface (`docs/host/`, outside the change process — always re-check after a host upgrade)**

The home for official interface study notes and upgrade documents — **not limited to dsh-base**: notes on any official host interface (the ctx API, the contracts of subsystems and subpackages) belong here.

- `docs/host/DSH-CTX-API.md` — host ctx interface study notes (cross-plugin contract, read-only reference).
- `docs/host/HOST-PACKAGES.md` — dictionary of official host packages and services (generated; regenerate after a host upgrade).
- `docs/host/HOST-UPGRADE-0.2.0-rc.2.md` — current upgrade comparison (0.1.7-rc.2 → 0.2.0-rc.2) and implementation status; the previous one is `docs/host/HOST-UPGRADE-0.1.7-rc.2.md` (0.1.5-rc.3 → 0.1.7-rc.2).
- `docs/host/AGENT-COMPOSITION.md` — current agent-side composition and its official basis (the TUI uses profile-wide composition, with no preset).
- `docs/host/AGENT-ARCHITECTURE-ANALOGY.md` — official agent architecture and interface comparison (the design basis for task-engine and knowledge-base).

**Module-level (`TUI/docs/`, `<package>/docs/`)**

- `TUI/README.md`, `<package>/README.md` — module entry points: usage, configuration, contracts, boundaries.
- `TUI/docs/DESIGN.md`, `<package>/docs/DESIGN.md` — architecture design and mechanism tradeoffs (present for `knowledge-base`, `output-compress`, `code-map`, `session-channel`).
- `TUI/docs/SPEC.md` — rendering pipeline spec; `TUI/docs/COMMANDS.md`, `TUI/docs/COMMANDS-SPEC.md` — command inventory and extension spec.
- `TUI/docs/design/` — TUI-internal conventions: `NOTICE-LEVELS.md` (notice levels), `AUDIT-colors.md` (color semantics), `REFACTOR.md` (module split conventions).
- `<module>/docs/BACKLOG.md` — module backlog (`TUI/docs/BACKLOG.md`, `fs-digest/docs/BACKLOG.md`, `session-channel/docs/BACKLOG.md`, `symbol-normalizer/docs/BACKLOG.md` already exist, the rest as needed); `<module>/docs/STATUS.md` — module-level reference document (TUI has one).

**Collaboration and history**

- `AGENTS.md` — agent-facing collaboration rules (language, commands, formatting, build and deployment, change process, short content change policy, structural conventions, Git).
- Root `archive/` — root-level history (completed lists, historical research, old contract snapshots, upgrade documents that have served their purpose); module history goes into `<module>/docs/archived/`.
- No `CHANGELOG.md` is maintained: change records live in `git log` (Conventional Commits) and `docs/host/HOST-UPGRADE-*.md`.
