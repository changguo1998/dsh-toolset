# 整理历史代码和文档: 阶段 1 标准与工具 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划　　开启: 2026-10-28　　关闭:
本文件是阶段 1 的追踪文档, 记录本阶段文件清单、实现记录、偏差与验证; 总追踪见 `docs/implementation/2026-10-28-history-cleanup.md`, 计划外的文件不改。

## 目标

在 `main` 落地全仓标准与工具, 为阶段 2 至 4 的按包分支提供稳定基座: 统一 pnpm 与包元数据、补测试工具与覆盖率聚合、非 TUI 包入口统一为 `src/index.ts`、规范入口 (`AGENTS.md` / `docs/GLOSSARY.md` / 流程文档) 与包级杂项 (LICENSE / `.gitignore` / tsconfig / patch 注释) 统一. 完成后全量 `pnpm run check` 与 `pnpm run test` 通过.

## 现状

以下为 2026-10-28 实测快照 (来源: 总追踪「调研」节), 本阶段逐项消除:

- 包管理混用: 4 个包已有 `pnpm-lock.yaml` (`TUI` / `code-map` / `md-map` / `task-engine`), 28 个 `package-lock.json` (`task-engine` 两者都有), 3 个包无 lockfile (`behavior-correction` / `command-template` / `session-title-cutoff`); 根 `package.json`、脚本与文档仍写 `npm`.
- 包元数据: 34 个包都缺 `private`; 26 个包缺 `types`; `files` 基本齐全, 但 5 个包的 `LICENSE` 只声明不存在的文件; 5 个包的 `check` 依赖 `tests/tsconfig.json`.
- 入口三种形态: 13 个根 `index.ts` (只做 re-export, `main` 指 `dist/index.js`)、15 个 `src/index.ts`、6 个 `src/main.ts` (`TUI` 为可执行包, 保留).
- tsconfig 13 种 `include` 组合, 13 处仍列根 `index.ts`, 8 处 `exclude` 指向不存在的 `tests/clock.test.ts`; 5 份 `tests/tsconfig.json` 与主配置无差别.
- 测试无覆盖率聚合器, 根缺 `test:integration` / `test:e2e` / `test:coverage` 三条入口.
- `AGENTS.md` 与 `docs/WORKFLOW-STANDARD.md` / `docs/WORKFLOW-FAST.md` 写 `npm` 命令与旧包数口径, 符号规则与术语规则未收口; `docs/GLOSSARY.md` 不存在; `tool-consult` 未列入轻量包名单.
- `agent-group` / `clock-base` 的 `cordis.patch.yml` 缺 `config` 按 id 整行替换与行顺序无语义的注释.

## 规划

阶段 1 在 `main` 直接落地, 不建 worktree 与分支; 四组按依赖顺序串行, 组内按任务编号做. 环境为 pnpm 11.7.0 与 node 24.16.0, `node_modules` 沿用现状, lockfile 只生成不重装. 依赖关系: 组 1 是其余三组的基础; 组 2 只依赖组 1 的脚本写法; 组 3 依赖组 1 的 tsconfig 与 lockfile; 组 4 最后做, 不改代码与包元数据.

### 任务拆分

#### 组 1: pnpm 与元数据

| 任务 | 文件 | 动作 | 验收 |
| --- | --- | --- | --- |
| T1.1 lockfile 统一 | 34 个 `*/pnpm-lock.yaml`; 28 个 `*/package-lock.json` | 27 个有 `package-lock.json` 的包在包目录跑 `pnpm import`, 生成 `pnpm-lock.yaml` 后删旧文件; `task-engine` 已有 `pnpm-lock.yaml`, 只删并存的 `package-lock.json`; 3 个无 lockfile 的包跑 `pnpm install --lockfile-only` 新建; 4 个已有 `pnpm-lock.yaml` 的包在 T1.3 后跑 `pnpm install --lockfile-only` 核对 | 34 份 `pnpm-lock.yaml`, 0 份 `package-lock.json`; `git diff --stat` 只增删 lockfile |
| T1.2 根脚本改 pnpm | 根 `package.json` | `check` / `build` 的 `npm --prefix <包> run` 改 `pnpm -C <包> run`; `demo` 改 `pnpm -C TUI run demo --`; 34 包顺序不动 | `pnpm run check` 全绿; diff 里包顺序与脚本名不变 |
| T1.3 包元数据 | 34 个 `*/package.json` | 补 `private: true` (34 处); 核对 `files` 为 `dist` / `README.md` / `cordis.patch.yml`, 包内有 `LICENSE` 或 `templates` 时一并列出; `scripts` 按四类归并, 删了 `tests/tsconfig.json` 的 5 个包把 `check` 改为 `tsc -p tsconfig.json --noEmit`; `TUI` 保留 `bin` / `tui.config.json` 与现有 `main` / `types`; 其余 `main` / `types` 留到 T3.3 | 34 包 `pnpm -C <包> run check` 绿; `private` 34 处; `files` 与实际文件一一对应 |
| T1.4 tsconfig 同构 | 34 个 `tsconfig.json`; 删 5 个 `tests/tsconfig.json` (`agent-group` / `behavior-correction` / `clock-base` / `escalation-hint` / `session-paths`); 保留 `md-table-check/tests/tsconfig.json` | `include` 固定 `src` 与 `tests`, 有 `demo` / `examples` / `bench` 的加目录, 删根 `index.ts` 与 `tests/*.test.ts` glob; 删 8 处 `tests/clock.test.ts` 的 `exclude`, 保留 `fs-digest` 的 `tests/fixtures` 与 `md-table-check` 的 3 条 | 34 包 check 绿; 5 份 `tests/tsconfig.json` 已删; 无 `exclude` 指向不存在的文件 |
| T1.5 忽略规则收口 | 根 `.gitignore`; 34 个 `*/.gitignore` | 根补 `dist` / `.pnpm-store` / `.pnpm-cache` / `.npm-cache` / `*.db` / `*.db-wal` / `*.db-shm` / `__pycache__/` / `smoke/.tmp`, 删 `TUI/dist/` 单条; 删 34 份包内 `.gitignore` | `git status` 不出现 `dist` / `node_modules`; `git check-ignore` 抽查 `TUI/dist` 与包内 `node_modules` |
| T1.6 部署脚本 | `scripts/install.sh` | 包安装与 build 的 `npm install` / `npm run build` 改 pnpm, 只留 `npm install -g` 与 `npm root -g` 两处; 注释与 `--skip-build` 提示同步 | `sh -n scripts/install.sh`; `grep -n npm` 只剩两处命令与 `have npm` |
| T1.7 许可证 | 5 个 `LICENSE` (`coagent` / `code-map` / `command-template` / `herdr-integration` / `session-channel`); `herdr-integration/package.json` | 复制根 `LICENSE`; `herdr-integration` 的 `files` 补 `LICENSE` | `cmp` 5 份与根一致; `files` 声明与文件一致 |

#### 组 2: 测试工具

| 任务 | 文件 | 动作 | 验收 |
| --- | --- | --- | --- |
| T2.1 覆盖率聚合器 | `dev/coverage/collect.mjs` / `dev/coverage/report.mjs` | `collect.mjs` 用临时目录设 `NODE_V8_COVERAGE` 起测试进程, 收原始 JSON; `report.mjs` 按文件聚合行覆盖与分支覆盖, 输出 JSON 与「文件 / 行 / 分支 / 未覆盖行」表; 只统 `src`, 只用 Node 标准库 | 对 `session-paths` 跑一次能出表; 无新增依赖 |
| T2.2 测试脚本分层 | `scripts/test-parallel.sh` / `TUI/scripts/test.sh` | 并行脚本接层参数 (单元 / 集成), 按层传目录与 glob; 两份脚本注释里的 `npm` 改 `pnpm` | `sh -n` 两份; `pnpm run test` 仍只跑单元层 |
| T2.3 根测试入口 | 根 `package.json` | 新增 `test:integration` (`pnpm -C <包> run --if-present test:integration`)、`test:e2e` (只 TUI)、`test:coverage` (collect + report); 包级三条脚本留阶段 2, 阶段 1 用 `--if-present` 跳过 | `pnpm run test:coverage` 产出报告; `test:integration` 在无包级脚本时退出 0 |

#### 组 3: 入口迁移

| 任务 | 文件 | 动作 | 验收 |
| --- | --- | --- | --- |
| T3.1 13 个根 `index.ts` 包 | `agent-group` / `auto-approve` / `command-template` / `escalation-hint` / `fs-digest` / `md-table-check` / `ponytail` / `preference-analysis` / `rule-engine` / `session-title-cutoff` / `symbol-normalizer` / `task-engine` / `tool-consult`: 根 `index.ts`; 同包 `src/main.ts`; 源码与测试的 import | 删根 `index.ts`; `git mv src/main.ts src/index.ts`; `./main.ts` / `../src/main.ts` / `../index.ts` 改 `./index.ts` / `../src/index.ts`; 不改行为 | 13 包 `check` 绿; 包内无根 `index.ts` 与 `src/main.ts`; 源码 import 无残留 |
| T3.2 5 个 `src/main.ts` 包 | `behavior-correction` / `clock-base` / `hash-edit` / `herdr-integration` / `session-paths`: `src/main.ts`; 源码与测试的 import | `git mv src/main.ts src/index.ts`; import 同 T3.1; `TUI/src/main.ts` 不动 | 5 包 check 绿; 包内无 `src/main.ts` |
| T3.3 `main` / `types` 统一 | 26 个 `*/package.json` (T3.1 与 T3.2 的 18 个, 加 7 个缺 `types` 的 `src/index.ts` 包, 加 `TUI`) | 非 TUI 写 `main` 为 `dist/src/index.js`、`types` 为 `./dist/src/index.d.ts`; `TUI` 保持 `dist/src/main.js`, 补 `./dist/src/main.d.ts`; 已有 `types` 的 8 个包只核对 | 34 包 `main` / `types` 齐全, 指向 `dist/src/` 下的真实产物 |
| T3.4 其余 15 包核对 | 15 个已用 `src/index.ts` 的包 | 核对 `main` / `types` 与 import, 只补 T3.3 列的 `types`; 不改行为 | 源码 import 中无 `src/main.ts`, 只剩 `TUI` |
| T3.5 全量验证 | 18 个迁移包; 根脚本 | 跑 `pnpm run check` / `build` / `test`; 抽查 18 包的 `dist/src/index.js` 与 `dist/src/index.d.ts` | 三条全绿; 产物路径与 `main` / `types` 一致 |

#### 组 4: 规范入口与包级杂项

| 任务 | 文件 | 动作 | 验收 |
| --- | --- | --- | --- |
| T4.1 `AGENTS.md` | `AGENTS.md` | 命令 `npm` 改 `pnpm`; 补 36 个符号白名单与 20 条变体映射; 补术语规则与 `docs/GLOSSARY.md` 链接; `模块 = TUI 与 33 个包` 改 `本仓 34 个包 = TUI 与 33 个插件`; 轻量包名单补 `tool-consult`; 目录清单补 `dev/` 与 `GLOSSARY.md`; 格式化跳过三类文件 | 符号表与术语规则与总追踪 3.9 / 6.6 一致; 无 `npm run check` 残留 (两处 `npm i -g` / `npm root -g` 除外) |
| T4.2 术语表初稿 | `docs/GLOSSARY.md` | 新建; 中文; 开头三行写职责 / 不负责 / 过期条件; 三张表 `场景 → 应当使用` / `需要替换` / `保留`; 不写用量; 阶段 5 校最终版 | 三张表齐全; 与 `AGENTS.md` 的术语规则不冲突 |
| T4.3 流程文档 | `docs/WORKFLOW-STANDARD.md` / `docs/WORKFLOW-FAST.md` | `npm` 命令改 `pnpm`; 包数改 34; 追踪模板命令同改 | 全文无 `npm run`; 模板可直接套用 |
| T4.4 patch 注释 | `agent-group/cordis.patch.yml` / `clock-base/cordis.patch.yml` | 补 `config` 按 id 整行替换而非合并、行顺序不带加载语义的注释 | 注释与宿主 patch 语义一致; YAML 手工改, 不跑 yq |
| T4.5 阶段记录 | 本文件; 总追踪 | 补「实现记录」「测试与证据」; 总追踪记「阶段 1 完成」; 本文件状态改 `关闭` | 记录含每批提交与全量结果 |

### 提交批次

提交点按流程走, 用户已授权直接提交, 不再逐点询问; 不含 `git push`.

| 批次 | 内容 | 前置验证 |
| --- | --- | --- |
| C1 | 组 1: pnpm 与元数据 | 34 包 `check` 绿; lockfile 计数正确 |
| C2 | 组 2: 测试工具 | 覆盖率报告可产出; `check` 绿 |
| C3 | 组 3 第一批: 13 个根 `index.ts` 包 | 13 包 `check` 与 `test` 绿 |
| C4 | 组 3 第二批: 5 个 `src/main.ts` 包 | 5 包 `check` 与 `test` 绿 |
| C5 | 组 4: 规范入口与包级杂项 | `format` 后自查 diff |
| C6 | 阶段记录: 总追踪与阶段文档 | 全量 `check` / `build` / `test` 绿 |

### 验证与门禁

- 每组改动文件先 `format`, 再自查 diff; 组 1 至组 4 每组完成后跑 `pnpm run check`.
- 入口迁移后跑全量 `pnpm run check` / `pnpm run build` / `pnpm run test`, 确认 18 个迁移包产出 `dist/src/index.js`.
- 阶段末再跑一次全量三条命令, 结果写「测试与证据」; `test:coverage` 本阶段只验工具可用, 覆盖率数字留阶段 2.

### 明确不做

- 34 个包的 `test:integration` / `test:coverage` 脚本与用例: 留到阶段 2.
- 包 `README` / `DESIGN` 中的入口路径与命令: 留到阶段 4.
- 根 `README.md` / `README.zh.md` 与 `docs/BACKLOG.md` 的命令、包数、条目状态: 留到阶段 5; `docs/host/` 与 `docs/STATUS.md` 不改.
- 不新增依赖 (覆盖率聚合器只用 Node 标准库), 不引入 `knip` / `check:docs` / 严格编译开关 / CI.
- 不建 worktree 与分支; 不改包名、目录名与归档.

## 实现记录

(待填)

## 偏差

无

## 测试与证据

(待填)

## 收尾

(待填)
