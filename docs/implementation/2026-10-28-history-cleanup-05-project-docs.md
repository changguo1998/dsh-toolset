# 整理历史代码和文档: 阶段 5 项目文档与收尾 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 进行中　　开启: 2026-11-01　　关闭:
本文件记录阶段 5 的项目级文档、归档符号归一与最终门禁; 关闭动作 (移追踪文档、清 BACKLOG、最后一笔提交) 待用户确认后执行.

## 目标

把项目级文档的事实与索引校到当前状态: 根 `README.md` / `README.zh.md` 的审计快照、宿主索引、DESIGN 名单、术语表入口与命令; `docs/ROADMAP.md` / `docs/ARCHITECTURE-REUSE.md` 的包数与审计口径; `docs/GLOSSARY.md` 终稿; 宿主升级文档的导航链接; 8 个归档文件的正文符号归一; 最后跑全量门禁.

## 现状

- 根 `README.md` / `README.zh.md`: 宿主复核仍写 `rc.2`, 当前升级文档仍指向 `rc.2`; 命令块用 `npm`; 复用审计写「覆盖全部 31 个包」; DESIGN 名单 14 个, 缺 `coagent`; Documentation 未列 `docs/GLOSSARY.md`.
- `docs/ROADMAP.md:10`: 写「TUI + 28 个插件包」, 与 34 个包不符.
- `docs/ARCHITECTURE-REUSE.md`: 当前口径写「31 个包 = TUI + 30 插件」, 未说明 3 包未审.
- `docs/GLOSSARY.md`: 三张表与 `docs/GLOSSARY.md` 的「评审 → 审阅」「返回体 → 回执」「落点」分写已齐, 阶段 4 模板已按此改; 本轮只复核, 预计不改.
- `docs/host/HOST-UPGRADE-0.2.1-rc.2.md:106`: 导航链接仍指 `docs/implementation/2026-10-19-dsh-update-check.md`, 实际已在 `docs/archived/`.
- 8 个归档文件仍有 53 处禁用变体在正文 (43 行); 另 12 处在围栏代码块内, 按规范保留.
- `docs/BACKLOG.md` 与总追踪的 `npm` 命令需同步; `docs/STATUS.md` 与 `docs/host` 的宿主结论不动.

## 实现规划

### 执行顺序

1. 根 `README.md` / `README.zh.md` 两侧同改: 宿主复核加 `rc.3` 并指向 `HOST-UPGRADE-0.2.1-rc.3.md`; 当前升级索引改 `rc.3`、上一份 `rc.2`; 命令块 `npm` 改 `pnpm`; 复用审计改「31 包快照 (2026-10-22; `coagent` / `tool-consult` / `escalation-hint` 3 包未审; 总表 31 行)」; DESIGN 名单补 `coagent`; Documentation 加 `docs/GLOSSARY.md`.
2. `docs/ROADMAP.md`: 包数改「34 个包 (TUI 与 33 个插件)」.
3. `docs/ARCHITECTURE-REUSE.md`: 当前口径改 34 个包、审计 31 包快照与 3 包未审; 总表 31 行与历史记录保留.
4. 复核 `docs/GLOSSARY.md`: 三张表、`AGENTS.md` 入口与阶段 4 实际术语一致; 有差异才改, 记偏差.
5. 改 `docs/host/HOST-UPGRADE-0.2.1-rc.2.md:106` 链接到 `docs/archived/`.
6. 8 个归档文件的正文符号归一 (仅正文, 围栏与行内代码不动), 单独一笔, 便于整笔回退.
7. `docs/BACKLOG.md` 与总追踪的 `npm` 命令改 `pnpm`; 历史性对照说明按语境保留.
8. 门禁: `pnpm run check` / `build` / `test` / `test:coverage`, `TUI` `pnpm run demo -- --smoke`, `DSH_PROFILE=fff-test pnpm -C TUI run smoke:pty`; 全量后复扫 README 六节 / DESIGN 四节 / 断链 / 符号变体.

### 统一口径

- 根 README 两侧逐节同构, 改一侧必须同步另一侧.
- 包数写「34 个包 = TUI 与 33 个插件」; 审计写「31 包快照 (2026-10-22; 3 包未审)」, 不把 31 说成全部.
- 命令: 可执行命令写 `pnpm`; 指 npm 仓库 / npm 包 / `npm install -g` 的说明性文字保留.
- 归档只做正文符号归一, 不改写内容、不修断链、不改文件名.
- 不改 `docs/STATUS.md` / `docs/host` 的宿主结论与包数快照.

### 文件清单

| 组 | 文件 | 动作 |
| --- | --- | --- |
| 根文档 | `README.md` / `README.zh.md` | 宿主索引、审计、DESIGN、GLOSSARY、命令 |
| 项目事实 | `docs/ROADMAP.md` / `docs/ARCHITECTURE-REUSE.md` | 包数与审计口径 |
| 术语 | `docs/GLOSSARY.md` | 复核, 预计不改 |
| 宿主链接 | `docs/host/HOST-UPGRADE-0.2.1-rc.2.md` | 导航链接改 `archived` |
| 归档符号 | 8 个归档文件 | 正文 53 处禁用变体归一 |
| 命令 | `docs/BACKLOG.md` / 本文件 / 总追踪 | `npm` 命令改 `pnpm` |
| 记录 | 本文件 / 总追踪 | 实现记录、偏差、证据 |

### 提交批次

1. `docs: 同步项目级文档事实与术语索引` (根 README / ROADMAP / ARCHITECTURE-REUSE / 宿主链接 / BACKLOG / 总追踪).
2. `docs: 归一归档文档正文符号` (8 个归档文件, 单独一笔).
3. 记录与关闭提交待用户确认 (本轮不做收尾).

### 验证与门禁

- `format` 全部改动文件, 复跑无 diff.
- 根 README 两侧同构抽查: 宿主索引、审计、DESIGN、GLOSSARY、命令五处一致.
- 全量: `pnpm run check` / `build` / `test` / `test:coverage` 退出 0; TUI `demo -- --smoke` 与 `smoke:pty` 通过.
- 复扫: 34 份 README 六节、15 份 DESIGN 四节; 非归档断链 0; 正文符号变体 0.

### 明确不做

- 不移追踪文档、不清 `docs/BACKLOG.md` `#1`、不写最终关闭提交.
- 不改 `docs/STATUS.md` / `docs/host` 的宿主结论与包数快照.
- 不改归档内容、断链、文件名与结构.
- 不发布、不改版本号、不 push.

## 实现记录

- 项目级事实 (提交 `59d5c3fd`): 根 `README.md` / `README.zh.md` 两侧同步 — 宿主复核补 `rc.3` 并指向 `HOST-UPGRADE-0.2.1-rc.3.md`, 当前升级索引改 `rc.3` / 上一份 `rc.2`, 命令块 `npm` 改 `pnpm`, 复用审计改「31 包快照 (2026-10-22; 3 包未审)」, DESIGN 名单补 `coagent`, Documentation 加 `docs/GLOSSARY.md`; 英文侧另修 `32 in-process plugins` → `33`.
- 同一提交: `docs/ROADMAP.md` 包数改「34 个包 (TUI 与 33 个插件)」; `docs/ARCHITECTURE-REUSE.md` 当前口径改 34 个包、审计 31 行与 3 包未审; `docs/host/HOST-UPGRADE-0.2.1-rc.2.md` 导航链接改 `docs/archived/2026-10-19-dsh-update-check.md`; `docs/BACKLOG.md` 与总追踪的 `npm` 命令改 `pnpm` (历史性 npm 说明按语境保留).
- `docs/GLOSSARY.md` 复核后无 diff: 三张表、`评审 → 审阅`、`返回体 → 回执`、`落点` 分写与阶段 4 实际术语一致.
- 归档符号 (提交 `459f70ab`, 2026-11-02 补正): 首轮替换 53 处 / 43 行, 其中 15 处在行内代码内越界; 按审计 E-01 还原后为 7 个文件 38 处 / 37 行, 覆盖 `✔` / `✅` / `✖` / `⚠` / `➡` / `⬅` 等; 围栏与行内代码保留原变体.
- 门禁: `pnpm run check` / `build` / `test` / `test:coverage` 全部退出 0; TUI `demo -- --smoke` 退出 0 (42 条 `SMOKE_PASS`); `DSH_PROFILE=fff-test` 的 `smoke:pty` 退出 0 (`SMOKE OK`).
- 2026-11-02 审计 P0 补正: 还原 2 份归档文档的 15 处行内代码替换 (`TUI/docs/archived/2026-10-01-lazy-width-table.md`、`md-table-check/docs/archived/2026-10-16-test-coverage-and-tsconfig.md`); 按 `docs/GLOSSARY.md` 补齐术语 (落点 / 回归 / 收口 / 过程记录 / 符号规则 / 工具集 / 评审 / 影子覆盖事件 / 插件包, 含 `WORKFLOW-STANDARD.md:11` 的模块定义句); 34 份包 `README.md` 的测试节补齐 `test:integration` / `test:coverage` (25 份有改动). 明细见 `docs/implementation/2026-11-01-history-cleanup-audit.md`「补正记录」.

## 偏差

- 规划写归档「39 处正文」; 首轮按代码区感知替换 53 处 / 43 行, 但其中 15 处在行内代码内越界 (审计 E-01). 2026-11-02 还原这 15 处, 终态 7 个文件 38 处 / 37 行, 与规划值接近; 剩余差异是扫描口径.
- 归档文件只做符号替换, 未跑 `format` (避免 mdformat 重写历史表格); 首轮误改的行内代码已还原, 终态围栏与行内代码零改动.
- 英文根 README 的 `32 in-process plugins` 与中文侧 `33 个插件` 不一致, 属计划外事实修正, 随 `59d5c3fd` 一并改.
- 总追踪 `npm --prefix` 的 4 处当前事实描述 (3.1 / 3.3 / 4.x 对照表) 一并改 `pnpm -C`; 行业对照里的 npm workspaces 说明保留.
- 关闭动作 (移追踪文档、清 `BACKLOG #1`、最后一笔提交) 未执行, 等用户确认.

## 测试与证据

- `pnpm run check` / `build` / `test` / `test:coverage`: 退出 0; 覆盖率合计行 86.6%, 分支 80.0%.
- TUI `demo -- --smoke`: 退出 0, 42 条 `SMOKE_PASS`; `smoke:pty` (`fff-test`, key 任意): 退出 0, `SMOKE_OK` + `SMOKE OK`.
- 标题扫描: 34 份 README 六节、15 份 DESIGN 四节, 均 0 例外.
- 非归档断链: 8 条命中全部为行内代码示例 (`<source>` / `来源` / `url` / `href` / `a.md`), 实际缺失 0.
- 动过的文档正文符号变体 (代码区之外): 0; 归档行内代码保留原变体.
- 术语: 落点 / 回归 / 收口 / 过程记录 / 符号规则 / 工具集 / 评审 / 影子覆盖事件 / 插件包 在现行文档 0 命中; 仅 `AGENTS.md:13` 的规则句、`herdr-integration/README.md:43` 的「夺回归属」、`preference-analysis/README.md:103` 的「验收口径」为词内命中, 保留.
- 包 README 测试节: 34/34 含 `test:integration` 与 `test:coverage`.
- `format`: 8 份非归档文档退出 0, 复跑无 diff; 归档 7 份按手工替换, 未跑 format.
- 提交链: `59d5c3fd` (项目级文档), `459f70ab` (归档符号), `191ffa2a` (本文件记录), `4c2d0144` (根 README 括号修正); 本文件与总追踪待关闭提交.
