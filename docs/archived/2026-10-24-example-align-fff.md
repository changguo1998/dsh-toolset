# 示例 profile 资产对齐当前 fff 的通用配置（接取条目：`docs/BACKLOG.md`「示例 profile 资产对齐当前 fff 的通用配置（去个人化）」）

状态：已关闭　　登记：2026-10-24　　关闭：2026-10-24
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把 `profiles/example/cordis.patch.yml` 对齐到当前 `~/.dsh/profiles/fff` 的**通用挂载形态**，个人配置不写真实值（模型以 `PROVIDER` / `MODEL` 占位）；同步受影响文档与脚本断言。

## 计划改动文件清单

- `profiles/example/cordis.patch.yml`（主改：删 permission / schedule / invariants，补 fff 通用条目，个人项占位，rule-engine 只写 resumed-notice，theme dark）
- `profiles/README.md`（删 permission / schedule 描述，补个人配置占位边界）
- `scripts/install.sh`（收尾提示 `:1007` 去 full-ask）
- `scripts/test-install.sh`（`theme: light` 断言 → `dark`，`:125`）
- `docs/BACKLOG.md`（条目登记与关闭）
- 本文件

## 决策

1. `tui.theme` 对齐 fff 现状改 `dark`（用户 2026-10-24 裁定「颜色主题用 dark」；连带改 test 断言）。
2. `llm-pi-ai` 个人配置保留骨架：provider 名用 `PROVIDER` 占位、端点与 apiKeyEnv 用注释占位、模型只留 1 个 `MODEL` 示例（用户选 b）。
3. `rule-engine` 只写启用的 `resumed-notice` 规则；停用的 `skill-autoload`（`enabled: false`）不写（用户裁定）。
4. `memory-base` 不抄 fff 的 `dbPath`（2026-10-17 改制后已废弃字段），沿用 example 现行的 `project` 配置面。
5. `agent-default-model` / `session-title-all-prompts-llm` / `session-title-cutoff` 的 provider / model 均以 `PROVIDER` / `MODEL` 占位。
6. 会话标题官方行处理：example 保留 `session-title-llm disabled` 与标题接管的注释说明（机制性内容），不写私有 provider / model。

## 调研

- fff 挂载的通用插条（example 缺）：herdr-integration / ast-tools / fs-digest / goal-contract / hash-edit / metric-loop / output-compress / security-guard / code-map / behavior-correction。
- example 独有而 fff 无：`permission` 预设表（`:20-43`）、`schedule`（`:93-96`）、`invariants`（`:167-168`）；其中 `invariants` 的包 `@deepseek-ai/dsh-invariants` 在宿主 0.2.1-rc.2 安装树已不存在（当前 `ls $TREE | grep invariant` 无结果）。
- `scripts/install.sh:1007` 收尾提示「/permission 看权限预设（含 full-ask）」依赖 permission 预设表，需同步。
- `scripts/test-install.sh:125` 断言 `theme: light` 1 处。
- `profiles/README.md:3 / :12 / :48 / :50` 引 permission / schedule 描述。
- fff 的 `memory-base`（`cordis.patch.yml:34`）写 `dbPath: !!js process.env.MEMORY_DB_PATH || dshHomePath(...)`，为 2026-10-17 改制前的单库残留，新配置面只认 `dshHome` / `projectRoot` / `project` / `journalMode`（memory-base/README.md:90-96，`Config` 面）。

## 实现记录

- 2026-10-24 用户裁定（连续确认）：① example 对齐 fff 现状但去个人化；② 个人配置模型用 `PROVIDER` / `MODEL` 占位；③ theme 改 `dark`；④ `llm-pi-ai` 保留骨架占位；⑤ `rule-engine` 只写启用的 `resumed-notice`（停用的 `skill-autoload` 不写）；⑥ 需要提交时直接提交不问。
- 2026-10-24 首版 example 把标题接管写成活跃条目（insert all-prompts + disabled + cutoff route）→ `scripts/test-install.sh` 守卫 7a 失败：id 去重 + 模板自带 disabled 使「追加的活跃行」被判已禁用，提示不出。同时模板内嵌活跃标题 provider 属语义错误（新 profile 以 PROVIDER/MODEL 假值首启）。修正：标题接管的二选一保留为**注释型机制说明**，`session-title-llm disabled` 保持活跃（与 fff 一致且安全）。
- 2026-10-24 `profiles/example/cordis.patch.yml` 重写完成：删 permission / schedule / invariants；补 herdr-integration / ast-tools / fs-digest / goal-contract / hash-edit / metric-loop / output-compress / security-guard / code-map / behavior-correction；`rule-engine` 只留 `resumed-notice`；`agent-default-model` / `llm-pi-ai` 占位骨架；`tui.theme: dark`；`memory-base` 沿用 `project`（不抄 fff 废弃 dbPath）。
- 2026-10-24 同步：`profiles/README.md`（删 permission / schedule 描述、补占位边界）、`scripts/install.sh:1007`（去「含 full-ask」）、`scripts/test-install.sh:125`（theme light → dark）、`docs/archived/2026-10-24-install-profile-parity.md`（决策项 1 收尾）。
- 2026-10-24 验证：`sh scripts/test-install.sh` → **98 项全过**（含 theme dark 断言、守卫 7a 回归）。
- （待关闭时补齐提交号）
