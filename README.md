English | [中文](README.zh.md)

# dsh-toolset

An in-process plugin toolset for DSH (DeepSeek Harness): a set of TypeScript plugins mounted into the DSH session process as cordis bundles, filling in capabilities such as task trees, a knowledge base with persistent memory, goal contracts, and metric loops. It also ships a homegrown terminal UI (TUI) — a third way to interact with DSH alongside the Web UI and the CLI.

For agent-facing collaboration rules, see `AGENTS.md` in the repository root. For DSH contract notes shared across plugins, see `docs/host/DSH-CTX-API.md` (read-only reference; last clause-by-clause review against `dsh-v0.1.7-rc.2`, and the `0.2.0-rc.2` / `0.2.1-rc.2` comparisons found no change on the surfaces this project consumes — see `docs/host/HOST-UPGRADE-0.2.0-rc.2.md` / `docs/host/HOST-UPGRADE-0.2.1-rc.2.md`).

## Composition

The repository contains the `TUI/` terminal UI package and 32 in-process plugins, all standalone npm packages (`@dsh-toolset/*`):

| Package | What it does |
|----|------|
| **TUI** (`TUI/`, `@dsh-toolset/tui`) | Terminal UI: four-region layout (conversation / activity / status column / input), event-driven rendering, slash commands, session switching and cleanup, model and approval panels; **zero runtime dependencies** (no third-party imports in the source, colors via manual ANSI) |
| **clock-base** | Timer unification surface: the `clock` service (`now()` plus `scope(ctx)` returning `schedule(delayMs, cb)` / `interval(delayMs, cb)`, whose disposal is registered on the caller's `ctx.effect` so a plugin unload leaves no live timer; handles are `unref`ed by default). Also exports a hand-driven `ManualClock` (advance the clock, fire due callbacks in order) for tests. Coexists with, and does not wrap, the host's `cordis-plugin-timer`: no `schedule`, no `unref`, and a required `inject` make wrapping a worse deal |
| **herdr-integration** | herdr panel bridge: agent state is reported to the herdr panel over a unix socket, and blocked events are bridged across three signal sources (ask-user questions, approvals, turn blocking) |
| **herdr-use** | Terminal read/write over herdr: ten model-facing tools `herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run` (no `action` parameter); a terminal = one tab plus its own root pane, and `terminal_id` is that root pane id, so the model never deals with panes, tabs or workspaces; the foreground lane inherits the parent herdr session, the background lane lives in a `dshbg` session and starts that headless server on demand; each dsh session is strictly bound to one workspace per lane; it also provides the `herdrUse` service surface to other in-process plugins, sharing the same registry and the same write lock as the tools; write tools pass through the read-only sandbox gate and security-guard registration |
| **task-engine** | Task tree engine: Frame state machine, the `decompose`/`implement`/`execute`/`stop`/`status` tool family, mechanical + semantic dual gating, and RET acceptance routing |
| **session-paths** | Host session-directory encoding, replicated as one in-repo source of truth: `encodeSegment` / `projectKey` / `projectDir` / `sessionDir` re-implemented character-for-character from `@deepseek-ai/dsh-session-persistence-jsonl`, exposed as the `sessionPaths` service (`root` / `projectKey` / `projectDir` / `sessionDir` / `sessionDirFor` / `ensureSessionDir`). Pure functions never touch disk; `sessionDirFor(sessionId)` resolves `header.cwd` through the host `sessions` service (optional read, not in `inject`) |
| **memory-base** | Tiered memory store — one SQLite database per tier (S/P/U, created lazily; the S location comes from `sessionPaths.sessionDirFor`) with two FTS5 indexes per kind table. Storage only: a kind is registered as a table and written/deleted through the returned scope handle (`writableTiers` + `preWrite`), while reads are global across kinds and tiers (`search` / `list`); the model gets one read-only tool, `memory_query` |
| **goal-contract** | Goal session contract drafting: interview-style questioning produces a goal plus Done-when acceptance clauses (schema aligned with task-engine's three-level acceptance), persisted to the dsh-goal event source |
| **metric-loop** | Metric-driven automatic loop: a measure command parses a single number, plateau stop, round/time/token bounds, cadence auto-wake |
| **output-compress** | Large-output compression: deterministic digests of over-threshold command/tool output plus a slice index written to its own per-session `digest.db` (one file per session, placed via `sessionPaths.sessionDirFor`); `is_error` digests are additionally pushed into memory-base through the write-scope handle (`kind: "digest"`, `tier: "session"`), so raw large output never enters the model context |
| **fs-digest** | Context-aware file reading: `outline`/`signatures`/`pruned` modes return the minimum sufficient context instead of a whole-file `read` |
| **hash-edit** | LINE:HASH anchored editing: reads return a content hash anchor for every line, edits locate lines by anchor, and stale content rejects the whole batch — no dirty writes |
| **ast-tools** | AST structural search, structured replacement, file outlines and YAML rule execution on top of ast-grep (through the system CLI as a subprocess, zero runtime dependencies); registers the model-facing `ast_query` (AST search / outline / rules) and `ast_replace` (dry-run by default) |
| **md-logic** | Markdown logical structure (single file, read + section-level rewrite): a section tree with per-section line ranges, a block inventory (list / table / code / quote / frontmatter / html / hr, with nesting depth and table dimensions) and a link / image / reference-definition inventory; registers the model-facing `md_logic` tool (`structure` / `blocks` / `links` for reading, and `replace` for section-level rewrite / deletion), built on `marked` |
| **md-map** | Markdown project-level structure and reference analysis (the docs counterpart of `code-map`): indexes `**/*.md` for heading anchors, document links (`internal`), wiki links, inline-code path refs (`kind:ref`), code/file/directory references and external links, plus backlink counts, with `callers` / `impact` / `orphans` / `report` queries (broken links and broken anchors included); registers the model-facing `md_map` tool and reuses `md-logic` for single-file parsing |
| **security-guard** | Security guard: a dangerous-command blacklist plus a sensitive-file protection policy layer, mounted on the host's monotonic `ctx.tools.guard` (a denial cannot be overturned by later listeners), falling back to the `tools/pre-execute` waterfall on hosts without that surface |
| **code-map** | Code structure map: file nodes plus an import graph index, with `callers`/`callees`/`cycles`/`impact` queries and project/module reports (references are candidates: semantic `callers` precision needs the official LSP trio, which the profile does not distribute, so it falls back to `structural`); depends on `@dsh-toolset/ast-tools` via `link:`, so install both when mounting |
| **context-report** | Session context and usage report: the host-only `sessionContext` projection folds what the official projections lack (token buckets), turns/steps and wall clock are read from the official `sessionStats` projection, and the `context_report` tool combines token-meter live pressure with model capacity readings |
| **rule-engine** | Rule-triggered automatic injection: matches model text, tool calls and turn boundaries by keyword/regex/built-in predicate, then injects a user-role message as a new turn (`followup`), onto the nearest pre-step with a wake (`steer`), or without one (`inject`); exposes a per-node consumer registration surface (`registerConsumer`, `sources` defaulting to `turn-end`, asked synchronously, injected centrally) and a read-only `evaluate` |
| **behavior-correction** | Behavior correction (rule-engine guard consumer on `tools/pre-execute`): before a tool runs, matches the tool name plus its argument string against its own config rule table and, on a hit, denies the call with a reason naming the dedicated tool. The default rule blocks `bash` commands containing `herdr` and points at `herdr_run` / `herdr_text` / `herdr_key` (write) and `herdr_read` / `herdr_list` (read); `rules` replaces the table wholesale, an empty array / `enabled: false` disables blocking, and the optional `ruleEngine` service is read through `ctx.get` (a missing service only warns, never blocks) |
| **symbol-normalizer** | Symbol normalization: presentation-layer normalization of symbols in model text (alias substitution) plus turn review (human notice / model feedback), plugged in as a rule-engine consumer; provides the `symbolNormalizer` service for the TUI to consume |
| **ponytail** | Lazy senior dev mode (on by default since 2026-10-05; set `enabled: false` to turn off): injects a 7-rung ladder (YAGNI → reuse → stdlib → platform → installed deps → one line → minimal code) at session start. |
| **md-table-check** | Reply-body markdown table check (rule-engine consumer on `assistant-text`): compares the cell counts of header / delimiter / data rows and, on mismatch, injects one consolidated prompt (header line + excerpt + expected vs actual columns) asking the model to resend the corrected reply. Report-only: it never rewrites the reply or any file, ignores column-count-consistent tables, width-driven fallbacks and pseudo-tables |
| **auto-approve** | Approval-chain auto-decision: answers `approval/request` with `allowed-once` / `rejected` through a priority ladder (deny list → same-session fingerprint → same-session form coverage → read-only tools → path / command allowlists → sandbox-escalation allowlist → LLM gray-zone review) and delegates unmatched requests to the TUI approval panel. A learning layer turns a manual panel approval into form-level coverage (quoted strings / long hex / numbers masked, minimal generalization after a second successful observation, LLM admission review, restart rehydration from the session log) with `learn off|on|list|undo|clear`. Audits both a session JSONL and a memory-base `approval_audit` row (never arguments); `/autoapprove status|mode|on|off|log|clear-fingerprints`; when disabled or not mounted, behavior matches the host's own |
| **session-channel** | Cross-session message channel (dedicated Redis instance + unix socket): `peers`/`send`/`inbox`/`status`, with messages injected into the target session's next turn (as `[CHANNEL](<source>) <body>`); provides the `sessionChannel` service (aliases, shared KV with last-value + version number, and cross-session delegation: `channel_delegate`/`channel_task`/`channel_task_result` with a task table and automatic or explicit result return) |
| **session-title-cutoff** | Session title provider: keeps the all-prompts trigger but narrows the reference window to human messages after the most recent `git commit` (falls back to the full set when there are no commits or the window is empty); takes over as the sole provider of `ctx.sessionTitle`, so the official all-prompts implementation must be disabled in the profile |
| **preference-analysis** | Preference analysis: observes session events for three structured signals (repeated constraints, correction-weighted restatements, rejected approvals), merges near-identical wordings into a cross-session ledger (the only state source), auto-writes high-confidence preferences into memory-base's project tier and injects them through a single rule-engine consumer; model proposals always land as pending candidates, and every exit (reject / undo / aging at 90 or 180 days) records a suppression key |
| **command-template** | Template system: prompt flows declared as `.md` files (YAML-subset front-matter) and invoked through one slash command (`/playbook <template> [args]`, with `list` / `show` / `reload` subcommands) — dual-source directories (bundled `templates/` + user `~/.dsh/command-templates`, user wins), step types `prompt` (inject into the current session) and `agent` (one-shot subagent with per-run model override), chaining via `{{stepId}}`, `bestOf` + `judge` |
| **script-interpreter** | Model-side script interpreter: `script_run` runs one script in an enabled language (Python first; the bash backend ships but stays off by default). The script text goes to the interpreter through stdin (no temporary script file), every call is a fresh process, non-zero exits are reported as `[exit code: N]` instead of tool errors, long output keeps its tail with the full text spilled to a `0600` file, runs go through `ctx.sandboxPolicy` + `ctx.sandbox` with fail-closed `SANDBOX_UNAVAILABLE` when no enforcing backend exists, and the optional services are read through `ctx.get` (a direct read of an un-injected cordis service throws) |
| **background-daemon** | In-process scheduler whose target is agent-session delivery: selectors `after_seconds` / `at` / `every_seconds` / `daily` / `weekly` (no `cron` yet); two channels — `deliver` (user message via `agent.followup`, then `sessions.flush` as L2 confirmation) and `command` (slash command, re-checked engine-side by `security-guard`); restart catch-up (periodic tasks pick up the latest missed slot, one-off tasks trigger within a 24 h window), a single timer, no retries; `/daemon` subcommands plus the `daemon_task` model tool; records go to memory-base (`daemon_task` / `daemon_run` kinds) with a local JSON fallback |
| **agent-group** | Cross-session group orchestration: groups, members, leader→follower links with levels, instructions and reports; lazy settlement on `check` (success / failure / blocked / timeout / removed), removal pushed down layer by layer, every refusal carries a reason + next step; depends on session-channel (transport) and session-paths (state location) |
| **coagent** | Long-lived agent launcher: creates a terminal through the `herdrUse` service surface, submits `fffdsh` in its interactive shell, claims the new dsh session via session-channel `peers`, and returns `terminal_id` / `session_id`; scope is launch and shutdown only — task dispatch and orchestration stay in session-channel and agent-group; rolls back the terminal on launch failure and keeps `failed` records with a screen digest |
| **tool-consult** | On-demand tool revelation: the model describes what it wants to do, `consult_tools` matches tools by keyword index and returns name plus one-line summary, and reveals the hits to the current session (host `tools.restrict` mask + single active-mask replacement); only 9 core tools stay visible by default; consultation is authorisation, revelation is monotonic within a session (`revealScope: session`) or bounded to one turn (`turn`, with `ttlTurns` / `pin`); calling a masked tool returns an actionable "consult first" message; any failure (no agent scope, `restrict` throws, name mismatch, empty intersection) degrades to "no mask" instead of breaking the session |
Every package's `package.json` carries the `dsh.bundle` integration contract along with a `cordis.patch.yml`; see each package's `README.md` for feature details and `docs/STATUS.md` for development status.

## Directory layout

```
dsh-toolset/
├── TUI/                  # Terminal UI package (src/app state layer, src/renderer render layer, src/app/adapter adapters, demo/ mock)
├── clock-base/           # unified timer surface (clock service: now + schedule / interval, disposed with the caller fiber, plus a hand-driven fake clock)
├── herdr-integration/    # herdr panel bridge
├── herdr-use/            # herdr pane / tab read/write (interactive command driving)
├── task-engine/          # task-tree engine
├── session-paths/        # session-directory encoding (host encoding replicated + sessionPaths service)
├── memory-base/          # knowledge base and persistent memory
├── goal-contract/        # Done-when contract drafting
├── metric-loop/          # metric loop
├── output-compress/      # large-output digest into memory
├── fs-digest/            # file digests (outline / signatures / pruned)
├── hash-edit/            # LINE:HASH anchored editing
├── ast-tools/            # AST search / replace / outline / rules
├── md-logic/            # Markdown logical structure (section tree + blocks + links with line ranges; md_logic tool)
├── md-map/               # doc-level code-map (anchors / references / impact / broken links; md_map tool)
├── security-guard/       # dangerous-command and sensitive-file guard
├── code-map/             # code structure map (symbol / import graph, queries and reports)
├── context-report/       # session context / usage report (sessionContext projection + context_report tool)
├── rule-engine/          # rule-triggered automatic injection (rules / consumer surface + injector)
├── behavior-correction/  # behavior correction (rule-engine guard consumer on tools/pre-execute; default: no herdr in bash)
├── symbol-normalizer/    # symbol normalization (presentation aliasing + turn review; rule-engine consumer)
├── ponytail/             # ponytail mode (decision-ladder injection; rule-engine consumer; on by default)
├── md-table-check/       # reply-body table column check (rule-engine consumer; on by default, report-only)
├── auto-approve/         # approval-chain auto-decision (approval/request answerer; dual audit sinks)
├── background-daemon/    # in-process scheduling for session delivery (/daemon + daemon_task; records in memory-base)
├── session-channel/      # cross-session message channel (dedicated Redis instance + unix socket)
├── session-title-cutoff/ # session title provider (all-prompts trigger unchanged; window = after the latest git commit)
├── command-template/     # template system (slash-command templates + per-template model selection, dual source dirs)
├── script-interpreter/   # model-side script interpreter (script_run: single-run Python; fencing + overflow to file + approval switch)
├── preference-analysis/  # preference analysis (behavior induction + ledger + auto-apply; rule-engine consumer)
├── agent-group/          # group orchestration (groups / members / leader-follower links / instructions and reports)
├── coagent/              # long-lived agent launcher (herdrUse terminal + fffdsh + session claim; launch and shutdown only)
├── tool-consult/         # on-demand tool revelation (keyword index + tools.restrict mask; consult is authorisation)
├── profiles/             # profile config examples (example: manifest + user-layer patch + pnpm trio; see profiles/README.md)
├── scripts/              # install.sh (one-shot install on a new machine); test scheduler
├── docs/                 # status table, backlog, agent composition notes, architecture comparison and host package list
├── archive/              # archived completed task lists and historical research
├── AGENTS.md             # collaboration rules for agents (language / commands / formatting / build and deploy / change workflow)
├── docs/host/DSH-CTX-API.md        # cross-plugin study notes (read-only)
└── package.json          # root scripts delegating check / build / test to all subpackages
```

## Quick start (build and test)

The repository root `package.json` delegates to all subpackages:

```sh
npm run check   # type-check all subpackages (tsc --noEmit)
npm run build   # compile all subpackages to dist/
npm run test    # run all subpackage tests in parallel (scripts/test-parallel.sh)
npm run demo    # build the TUI and run the mock demo (no DSH dependency)
npm run demo -- --smoke   # TUI smoke check (frame assertion SMOKE_PASS)
npm run test:tui          # TUI single-package test shortcut (name regex / file-name filters)
```

Inside a single subpackage you can run its own `npm run check / build / test / demo` directly (the TUI also has `bench` and `smoke:pty`). For command details, parallel scheduling flags and filter usage, see `AGENTS.md`.

## Wiring into a DSH profile

One-shot install on a new machine (install dsh → build all plugins → create a profile mounting 33 packages: TUI + 32 plugins):

```sh
git clone <this repo> && cd dsh-toolset
scripts/install.sh                 # profile name defaults to fff
scripts/install.sh --help          # --profile/--plugins/--dsh-version/--skip-dsh/--skip-build/--force/--sync/--take-over-title/--dry-run/--skip-verify
```

The script is idempotent: existing config files are kept unless `--force` is given, and it writes (plus a `.bak.<timestamp>` backup) only when the content actually differs, so repeated `--sync` runs do not pile up files. It touches only `$DSH_HOME` (default `~/.dsh`) and this repository. `--sync` refreshes the repository plugins to the current selection (unselected repository entries are removed, user-added ones kept) and never rewrites the title-provider part of `cordis.patch.yml`: disabling the official all-prompts provider is an explicit choice (`--sync --take-over-title`), otherwise a detected conflict is only warned. `--sync --force` is rejected (it would overwrite the patch and drop the generated takeover region). The generated region is rebuilt from the patch, so re-running with the flag only fills missing pieces; deleting the lines starting with `# install.sh generated: title-takeover-` opts out of the takeover.

Plugin builds run in parallel (GNU parallel, falling back to `xargs`, then serial): `BUILD_JOBS` overrides the concurrency (default = CPU cores) and `BUILD_RUNNER=parallel|xargs|serial` forces a scheduler. Dependency installs stay serial, and `code-map` / `md-map` are built after `ast-tools` / `md-logic` because they import those packages' builds.

For manual setup, mount each plugin into a DSH profile as a cordis bundle. Example (`~/.dsh/profiles/fff`, see `TUI/README.md` for details):

```jsonc
// <profile>/package.json
{
  "dependencies": { "@dsh-toolset/tui": "link:<package path>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsh-toolset/tui"] } }
}
```

During local development, use `link:` dependencies: build artifacts are visible through the symlink immediately, with no reinstall. The release form is `dsh plugin --profile <p> add <package>`. Inspect the composition tree with `dsh --profile <p> --dump-config`, and start with `dsh --profile <p>`.

`profiles/example/` in this repository is a ready-to-copy three-file profile example (manifest + user-layer patch + pnpm config); it demonstrates both dialects — `- id:` overriding and `- insert:` adding — as well as `!!js` expressions and permission preset table overrides (custom sandbox + approval-bundled presets). For deployment steps and boundaries, see `profiles/README.md`.

### Agent-side composition (no preset)

This project uses the TUI only, and the agent side comes from the profile's global composition (`dsh-base` + this project's bundles + `cordis.patch.yml`). **No agent preset is configured or loaded**: in the official design the TUI is "a single composition surface without a preset", so `/preset` reporting that the agent preset service is unavailable is expected. To change tools, prompts or persona, put it in the profile user patch; for multiple compositions, use multiple profiles. See `docs/host/AGENT-COMPOSITION.md` for the official basis, local verification, and the 0.1.7 version gap.

## Documentation

This is the only index (`AGENTS.md` does not repeat the list); each maintained document opens with three lines stating "what it owns / what it does not own / when it expires".

Two change flows: `docs/WORKFLOW-STANDARD.md` (standard) and `docs/WORKFLOW-FAST.md` (small changes), with the short form in `AGENTS.md`.

**Project-level (`docs/`)**

- `docs/ROADMAP.md` — future development directions and completion criteria (progress, schedule and items live in `docs/BACKLOG.md` §3 milestones).
- `docs/BACKLOG.md` — actionable items: cross-package features and defects (P0/P1/P2) + milestones + plugin roadmap.
- `docs/STATUS.md` — reference document recording what has been implemented (updated by maintainers as needed).
- `docs/ARCHITECTURE-REUSE.md` — reuse audit covering all 31 packages (TUI + 30 plugins; verdicts: 0 reuse / 22 keep / 9 coexist): whether an official equivalent exists, plus the "reuse / keep / coexist" verdict and its reasons.
- `docs/WORKFLOW-STANDARD.md` — content change policy · standard flow (full version).
- `docs/WORKFLOW-FAST.md` — content change policy · fast flow (small changes).
- `docs/implementation/`, `docs/archived/` — tracking documents for cross-package items (in progress / closed).

**Host surface (`docs/host/`, outside the change process — always re-check after a host upgrade)**

The home for official interface study notes and upgrade documents — **not limited to dsh-base**: notes on any official host interface (the ctx API, the contracts of subsystems and subpackages) belong here.

- `docs/host/DSH-CTX-API.md` — host ctx interface study notes (cross-plugin contract, read-only reference).
- `docs/host/HOST-PACKAGES.md` — dictionary of official host packages and services (generated; regenerate after a host upgrade).
- `docs/host/HOST-UPGRADE-0.2.1-rc.2.md` — current upgrade comparison (0.2.0-rc.2 → 0.2.1-rc.2) and implementation status; the previous one is `docs/host/HOST-UPGRADE-0.2.0-rc.2.md` (0.1.7-rc.2 → 0.2.0-rc.2).
- `docs/host/AGENT-COMPOSITION.md` — current agent-side composition and its official basis (the TUI uses profile-wide composition, with no preset).
- `docs/host/AGENT-ARCHITECTURE-ANALOGY.md` — official agent architecture and interface comparison (the design basis for task-engine and memory-base).

**Module-level (`TUI/docs/`, `<package>/docs/`)**

- `TUI/README.md`, `<package>/README.md` — module entry points: usage, configuration, contracts, boundaries.
- `TUI/docs/DESIGN.md`, `<package>/docs/DESIGN.md` — architecture design and mechanism tradeoffs (present for `TUI`, `task-engine`, `memory-base`, `session-channel`, `code-map`, `rule-engine`, `symbol-normalizer`, `output-compress`, `ponytail`, `command-template`, `md-logic`, `md-map`, `preference-analysis`, `agent-group`; lightweight packages keep `README.md` + `docs/BACKLOG.md` only).
- `TUI/docs/SPEC.md` — rendering pipeline spec; `TUI/docs/COMMANDS.md`, `TUI/docs/COMMANDS-SPEC.md` — command inventory and extension spec.
- `TUI/docs/design/` — TUI-internal conventions: `NOTICE-LEVELS.md` (notice levels), `AUDIT-colors.md` (color semantics), `REFACTOR.md` (module split conventions).
- `<module>/docs/BACKLOG.md` — module backlog (one per module where work is pending); `<module>/docs/STATUS.md` — module-level reference document (TUI has one).

**Collaboration and history**

- `AGENTS.md` — agent-facing collaboration rules (language, commands, formatting, build and deployment, change process, short content change policy, structural conventions, Git).
- Root `archive/` — root-level history (completed lists, historical research, old contract snapshots, upgrade documents that have served their purpose); module history goes into `<module>/docs/archived/`.
- No `CHANGELOG.md` is maintained: change records live in `git log` (Conventional Commits) and `docs/host/HOST-UPGRADE-*.md`.
