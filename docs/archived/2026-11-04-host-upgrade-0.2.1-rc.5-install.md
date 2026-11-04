# 本机宿主升级到 0.2.1-rc.5 并重建安装树口径（接取条目: docs/BACKLOG.md「本机宿主升级到 `0.2.1-rc.5` 并重建安装树口径」）

状态: 关闭　　开启: 2026-11-04　　关闭: 2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改。

## 目标

1. 本机全局 `dsh` 从 `0.2.1-rc.3` 升到 `0.2.1-rc.5`, 用 `scripts/install.sh --profile fff --sync` 重装主 profile (含伴随 `fff-test`)。
2. 复测安装树口径: 随包分发包计数、`dsh-*` 计数、fff 活跃挂载行数、`--dump-config` 自检, 按新树重生成 `docs/host/HOST-PACKAGES.md`。
3. 把仓库内全部 `0.2.1-rc.3` 引用抬到 `0.2.1-rc.5`。

## 调研

现状盘点 (`grep -rn "0.2.1-rc.3"` 于 `*.sh` / `*.md` / `*.json` / `*.yml`, 排除 `docs/archived/` 与历史对照文档):

| 位置 | 处数 | 性质 |
| --- | --- | --- |
| `scripts/install.sh` | 3 | 头注释、`dsh_version_default`、`--help` 文本 |
| `scripts/test-install.sh` | 7 | 假 `dsh` 版本串与版本一致性断言 (含树外插件 pin 用例) |
| `package.json` | 1 | 根 `devDependencies` 的 `@deepseek-ai/dsh` |
| `pnpm-lock.yaml` | 全量 | 依赖图全部为 rc.3 解析结果 |
| `{goal-contract,metric-loop,output-compress,security-guard}/smoke/smoke.mjs` | 各 1 | `REQUIRED_VERSION` |
| `goal-contract` / `metric-loop` / `security-guard` 的 `README.md` | 各 1 | smoke 前置说明 |
| `e2e/README.md` | 1 | 根 devDep 钉版本说明 |
| `TUI/docs/COMMANDS.md` | 1 | 命令清单随包口径 |
| `docs/ARCHITECTURE-REUSE.md` | 2 | 复用审计基线 |
| `docs/STATUS.md` | 1 | 宿主基线行 |
| `docs/host/HOST-PACKAGES.md` | 标题与口径 | 版本口径 + 待重生成的计数 |

上一轮同类改动 (rc.2 → rc.3) 的做法见 `docs/host/HOST-UPGRADE-0.2.1-rc.3.md` §3, 本次沿用。

环境事实: 全局 `npm` 前缀 `/home/guochang/.local/share/fnm/node-versions/v24.16.0/installation`(用户可写, 无需 sudo); npm `~/.npm` 与 pnpm store `~/.local/share/pnpm/store/v11` 均在会话工作区之外, 需沙箱升级权限。

## 决策

1. 范围: a 只抬 `install.sh` → b 抬脚本 + smoke 门槛 → c 全量口径（含 devDep 与锁文件、全部文档基线）。**选定 c**（用户 2026-11-04 裁定「全量口径」）。
2. 本机安装树: a 不动 → b 一并升级并重生成计数。**选定 b**（用户裁定「一并升级安装树」）。
3. 根 devDep: a 保持 rc.3 → b 抬到 rc.5 并 `pnpm install` 重写锁文件。**选定 b**（用户裁定「抬 devDep 并重装」）。
4. alpha 线: a 另立条目复核 → b 不复核, 删除该条目。**选定 b**（用户 2026-11-04 裁定）。
5. `STATUS.md`: `WORKFLOW-STANDARD.md` §4.6 规定由用户择时更新; 本次用户明确要求「所有版本升级到 rc.5」, 视为对该文件的更新授权, 只改宿主基线行。
6. 沙箱: `npm i -g`、`pnpm install`、`install.sh --sync` 需写工作区外路径, 逐条走 `sandbox_permissions: danger-full-access` 一次性升级并说明理由。

## 规划

任务拆分:

1. 追踪文档 + BACKLOG (删 alpha 条目、本条标进行中)。
2. 仓库内 rc.3 → rc.5 引用全量替换 (脚本 / smoke / README / 文档基线)。
3. `pnpm install` 重写锁文件 → `pnpm run check` 验证类型面。
4. 全局安装 `dsh@0.2.1-rc.5` → `scripts/install.sh --profile fff --sync` → `--dump-config` 自检。
5. 复算安装树计数并重生成 `HOST-PACKAGES.md` 的版本口径与计数。
6. 验证: `scripts/test-install.sh`、`pnpm run check:docs`、`pnpm run check`、`pnpm test`(按需)、`pnpm run test:e2e`(按需)。

计划改动文件清单:

- `docs/BACKLOG.md` — 删 alpha 条目; 本条标〔进行中〕并补范围。
- `docs/implementation/2026-11-04-host-upgrade-0.2.1-rc.5-install.md` — 本追踪文档。
- `scripts/install.sh`、`scripts/test-install.sh` — 默认版本与假版本串。
- `package.json`、`pnpm-lock.yaml` — 根 devDep 与锁文件。
- `goal-contract/smoke/smoke.mjs`、`metric-loop/smoke/smoke.mjs`、`output-compress/smoke/smoke.mjs`、`security-guard/smoke/smoke.mjs` — `REQUIRED_VERSION`。
- `goal-contract/README.md`、`metric-loop/README.md`、`output-compress/README.md`(若有)、`security-guard/README.md` — smoke 前置说明。
- `e2e/README.md`、`TUI/docs/COMMANDS.md` — 版本口径。
- `docs/ARCHITECTURE-REUSE.md`、`docs/STATUS.md` — 基线行。
- `docs/host/HOST-PACKAGES.md` — 版本口径与重生成计数。
- `docs/host/HOST-UPGRADE-0.2.1-rc.5.md` — 「未做 / 待办」一节改口 (安装树已升级)。

明确不做:

- 不复核 `0.2.2-alpha` 线 (用户裁定)。
- 不改历史对照文档 (`HOST-UPGRADE-0.2.1-rc.2.md` / `-rc.3.md` / 存档追踪文档) 与 BACKLOG 历史关闭注记里的 rc.3 字样。
- 不动任何插件源码逻辑 (接口面零变更, 见 `docs/host/HOST-UPGRADE-0.2.1-rc.5.md`)。
- 不升级 `session-title-all-prompts-llm` 之外的树外插件 (无其它树外插件)。
- **追加 (执行中新增)**: `pnpm-workspace.yaml` —— `pnpm install` 时由 pnpm 11 自动生成 (含 `allowBuilds` 占位符), 需纳入版本控制, 否则 `pnpm install` 退出 1、`pnpm run` 的前置依赖检查连带失败。

## 实现记录

- 16:20 仓库内 `0.2.1-rc.3` → `0.2.1-rc.5` 全量替换 (14 个文件, 逐文件替换数: install.sh 3、test-install.sh 7、package.json 1、4 个 smoke 各 2-3、4 个 README 各 1、e2e/README 1、COMMANDS 1、ARCHITECTURE-REUSE 3、STATUS 2), 脚本为一次性 node 精确替换, 替换后逐条 diff 复核 (全部为版本串与据此派生的文案, 无逻辑改动)。
- 16:25 `pnpm install`: 默认 store(`~/.local/share/pnpm/store`)与 npm 缓存(`~/.npm`)在工作区外, 沙箱拒绝; 改用仓库本地 `.pnpm-store` / `.pnpm-cache` (均已在 `.gitignore`) 成功。首次因 `ERR_PNPM_IGNORED_BUILDS` 退出 1, 用户裁定把 `allowBuilds` 5 项全设 true。
- 16:30 `pnpm run check` 仍失败: pnpm 11 把配置源从 `package.json` 的 `pnpm` 字段挪到新建的 `pnpm-workspace.yaml`, 于是 `verifyDepsBeforeRun: false` 失效、前置检查触发嵌套 install 并因 sqlite 打不开工作区外 store 索引而失败。把 `verifyDepsBeforeRun: false` 写进 `pnpm-workspace.yaml` 后恢复; `pnpm run check` 退出 0。
- 16:35 沙箱拒绝 `npm install -g @deepseek-ai/dsh@0.2.1-rc.5` 的一次性升级请求(用户答复拒绝, 两次), 全局安装与 profile 重装交用户执行; 见「偏差」。
- 16:40 文档侧: `docs/STATUS.md` 宿主基线行改写; `docs/host/HOST-PACKAGES.md` 标题与版本口径改为 rc.5; `docs/host/HOST-UPGRADE-0.2.1-rc.5.md` §6 补「追加」条、§7 改为待用户执行的命令与复测清单。
- 16:45 途中发现的既存缺陷登记为新 BACKLOG 条目 (`scripts/test-install.sh` 的 check/build 链一致性检查仍按 `--prefix` 提取, 根 `package.json` 早已改用 `-C`)。
- 16:52 用户执行 `npm install -g @deepseek-ai/dsh@0.2.1-rc.5` 与 `scripts/install.sh --profile fff --sync` 后复测: `dsh --version` = `0.2.1-rc.5`, 安装树 `@deepseek-ai` 下 306 个包 / `dsh-*` 295 个 (与 rc.2 / rc.3 一致), 全局 `dsh-base` = rc.5, profile `dsh.profile.bundles` 35 个 (dsh-base + 34)。
- 16:55 挂载面复测: `dsh --profile fff --dump-config` 直连 `~/.dsh` 会写 profile 目录(沙箱只读), 改用 `DSH_HOME=tmp/dshhome` 的 profile 副本(复制 json / patch 并软链 `node_modules`)取得 848 行 dump: 142 个 `- id:` 行、无条件 `disabled: true` 6 条、条件式 `disabled: !!js` 5 条、`@dsh-toolset/*` 34 条 → 官方活跃包 100 个。
- 17:00 按复测数字回写 `docs/STATUS.md` 与 `docs/host/HOST-PACKAGES.md`, 并更新 `docs/host/HOST-UPGRADE-0.2.1-rc.5.md` §7 为「已完成」。

## 偏差

- **安装树升级由用户执行**: `npm install -g @deepseek-ai/dsh@0.2.1-rc.5` 与 `scripts/install.sh --profile fff --sync` 需写工作区外路径, 两次沙箱升级请求均被拒绝, 按规则不再绕行, 改为请用户执行 (2026-11-04 16:52 完成)。因此本节列出的复测都在命令执行之后补做, 不是执行中断言的「本次直接安装」。
- `--dump-config` 未在 `~/.dsh` 上直跑 (EROFS), 用 `DSH_HOME=tmp/dshhome` 的 profile 副本取得等价输出; 副本的 `node_modules` 是软链, 只读使用, 不影响 profile 本身。
- §1 的 100 个名字项与 dump 的官方活跃包 100 个同量, 但集合并非逐项一一对应 (dump 的 `cordis-plugin-timer` 行未列入 §1; §1 的 `tool-subagent-control/list-agents` 在 dump 里是子路径行), 本次未逐行重写 §1 (接口与包集合均未变, 重写属无收益改动); 已记在此备查。
- 计划里写的 `output-compress/README.md`(若有) 实际无 rc.3 字样, 未改。
- 新增未计划文件 `pnpm-workspace.yaml`(见规划追加条) 与 `pnpm-lock.yaml` 的 2987 / 2981 行重写 (devDep 抬版带来的依赖图整体变化), 均属必要产物。

## 测试与证据

- `pnpm run check`: 退出 0 (34 包 `tsc --noEmit` 全过, 对 rc.5 类型面)。
- `pnpm test`: 退出 0, 全部包 `pass` / `fail 0`(日志 `tmp/test.log`)。
- `pnpm run test:e2e`: 退出 0, 33 条真宿主用例全过 (rc.5 `dsh-base` 装配, 5.8 s)。
- `pnpm run check:docs`: `✓ check:docs 通过: 111 篇现行 Markdown / 901 个 .ts, 规则 0 项, 错误 0 / 警告 0`。
- `sh scripts/test-install.sh`: 退出 1, **唯一失败项**为既存缺陷「canonical_pkgs 与根 check/build 链一致」(见新登记条目), 其余全部通过; 该失败与本次改动无关 (HEAD 上同样失败)。
- 升级复测: `dsh --version` = `0.2.1-rc.5`; 安装树 306 / 295; `dsh-base` = rc.5; profile `bundles` = 35。
- 挂载复测: `--dump-config` 848 行 / 142 行 id / 官方活跃包 100 个 (明细见「实现记录」16:55 条)。
- 未做: 4 个包 smoke 的真跑 (需模型凭据与真机会话, 门槛已抬到 rc.5 可在升级后正常通过)。

## 收尾

- 回写文档: `docs/STATUS.md` 宿主基线行 (升级完成 + 复测数字); `docs/host/HOST-PACKAGES.md` 版本口径与 rc.5 挂载复测; `docs/host/HOST-UPGRADE-0.2.1-rc.5.md` §6 追加 / §7 改为已完成; `TUI/docs/COMMANDS.md` / `e2e/README.md` / `docs/ARCHITECTURE-REUSE.md` / 4 个包 README 与 4 个 smoke 门槛 / `scripts/install.sh` / `scripts/test-install.sh` / `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`。
- BACKLOG: 所接取条目已标完成并移出 §2 (关闭注记保留); 途中发现的一条按顺序重编为 `#1`(`scripts/test-install.sh` 的 check/build 链一致性检查)。
- 归档: 本文件已移入 `docs/archived/2026-11-04-host-upgrade-0.2.1-rc.5-install.md`。
- 清理: `tmp/check*.log` / `tmp/test.log` / `tmp/e2e.log` / `tmp/test-install.log` / `tmp/dump-rc5.*` / `tmp/dshhome` / `tmp/pnpm-store` / `tmp/npm-cache` 删除; `.pnpm-store` / `.pnpm-cache` 已在 `.gitignore`, 保留 (重新 `pnpm install` 会复用)。
- 遗留: 唯一未做项是 4 个包 smoke 的真跑 (需模型凭据)。
