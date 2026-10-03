# install.sh 标题 provider 守卫脱节（接取条目：`docs/BACKLOG.md`「`scripts/install.sh --sync` 的标题 provider 守卫与实际 patch 结构脱节，会静默改写用户 patch」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

修掉「`--sync` 静默改写用户 patch」的三条：① 自动禁用官方标题 provider 的启发式分不清「宿主挂载行」与「用户自插行」（fff 实例：用户自己的 `- insert:` 行被自家追加的 `disabled: true` 关成死行）；② 幂等标记与被保护片段同块 → 清理片段即破坏幂等；③ manifest 合并把新依赖追加在末尾而非字母序。

## 调研

- 守卫现状（`scripts/install.sh:421-461`）：`--sync` → 旧标记（`session-title-cutoff 接管标题 provider`）命中即跳过；否则**非注释行 grep** `dsh-session-title-all-prompts-llm` 命中 → 追加 `- id: … disabled: true` + （awk 取 provider/model）`session-title-cutoff` 路由块，marker 就写在追加块的注释里（`:434`）。
- marker 位置与幂等耦合：`:434` 的注释行既是被保护块的表头又是 marker（`grep -q "session-title-cutoff 接管标题 provider"`，`:425`）。
- manifest 合并（`:352-389`）：node 内联脚本 `manifest.dependencies[pkg.name] = "link:…"` 直接追加 → 新键落在末尾；`render_manifest`（`:334-351`）按 `$final` 顺序输出依赖键 → 两条路径键序不同。
- 测试：`scripts/test-install.sh` 7)（`:119-133`）直接断言「`--sync` 自动追加禁用 + 路由」——与新语义冲突，须改；假 `dsh` 已就绪（`:21-28`），harness 用 `PATH` + 临时 `DSH_HOME`。
- 文档口径：`profiles/example/cordis.patch.yml:94` 写「`--sync` 会自动完成这两步」；根 `README.md:95` / `README.zh.md:95` 列全部选项、`:98` 讲幂等。
- 越界项（不改）：fff profile 侧死行清理属 fff 仓库（条目原文：需用户另行裁定）；`--sync --force` 覆盖组合、awk 条目边界、两段 marker 拆开属**下一条**「守卫残余」。

## 决策（待审阅）

1. **接管改显式开关 `--take-over-title`**（取条目期望①的「显式开关」方案；不取 `--dump-default-config` 判据——那要求安装期调用宿主 CLI 且判的是基础层，用户自插行仍会漏判）：`--sync` 不再凭文本 grep 自动追加；命中非注释行提及 all-prompts 时只 `warn`（指引 `--sync --take-over-title` 或手工 `disabled: true`）；带开关才追加（payload 与旧版相同：禁用块 + 复制 provider/model 路由，仅当两者都取到）。
1. **marker 移出被保护片段**：新标记写**文件头**独立行（`# install.sh title-takeover marker: …`），与追加块解耦（清理块不破坏幂等）；判定顺序 = 新标记 → **旧标记迁移**（发现旧标记但无新标记：只补文件头标记、不重复追加 payload，log 说明）→ 开关 → warn / 跳过。文件头写入用同目录临时文件 + `mv`（先 `backup`）。
1. **manifest 键序**：合并路径对 `dependencies` 键排序（node `Object.keys().sort()`，与 pnpm 的键序一致）；`render_manifest` 同步按包名排序（`LC_ALL=C sort`，与 node 默认序在包名集合上一致）——两条路径键序一致，避免首装 → `--sync` 的无谓 diff；bundles 仍按 `$final` 顺序（挂载顺序语义不变）。
1. 文档：`--help` 用法行 + 根 `README.md` / `README.zh.md` 选项列表与幂等段 + `profiles/example/cordis.patch.yml` 注释口径（中英同步）。
1. 不做：fff 侧清理、`--sync --force` 组合、awk 条目边界、两段 marker 拆开（下一条「守卫残余」）；AGENTS.md 的选项列表本就是子集（缺 `--force` / `--sync` / `--skip-verify`），维持子集口径不改。

## 规划

- 计划改动文件清单（**只改这些**）：`docs/BACKLOG.md`（状态）、本追踪文档、`scripts/install.sh`、`scripts/test-install.sh`、`profiles/example/cordis.patch.yml`（注释）、`README.md` / `README.zh.md`（选项列表与幂等段）。
- 验证：`sh scripts/test-install.sh`；撤修复必红（撤显式开关 → 「无开关不写盘」用例红）；`sh -n scripts/install.sh`；根 `npm run check`（脚本改动不影响 TS，但按流程跑一遍）。
- 明确不做：不动其它包；不顺手改相邻代码。

## 实现记录（2026-10-04）

- 子代理只读审阅（决策后、实现前）：通过；修订（含三条新证据）——① **官方层从不挂 `all-prompts`**（`dsh-base` 只挂 `session-title` / `session-title-llm`；全仓与 shipped `PROFILE_TEMPLATES` 零出现）⇒ 文本启发式在当前基线上的唯一可达触发就是用户自插行，自动禁用分支**误报率 100%**；② **`--dump-default-config` 不是只读判据**（会 `initProfile` / `removeLinkProjections` 物化 profile、且在 `pnpm install` 前 bundle 行判不出来）⇒ 舍弃该方案，取显式开关；③ 冲突不是报错而是**静默降级**（宿主二次注册抛错被 cutoff 侧 try/catch 吞掉）⇒ 不带开关时必须 warn 且给出两条出路；④ 开关**必须与 `--sync` 同用**（单独给 → `die`），且仍以「patch 里有活跃行」为前置（否则追加出未命中条目）；⑤ marker 语义定为 **latch**（删 marker = 放弃接管，可带开关重放），marker 文本不含旧串 / 不含官方 id（避免与启发式、旧标记判定互相污染）；⑥ 迁移（发现旧标记）**只在带开关时**补文件头 marker——普通 `--sync` 对 patch 100% 不改字节；⑦ 写 marker 从「临时文件 + `mv`」改为**就地重写**（`cat tmp > file`）：profile 里已有软链文件（`~/.dsh/profiles/fff/package.json`），`mv` 会替换链接本身并可能放宽 0600 权限；临时文件用完即删（沿用测试的 `*.tmp.*` 残留断言）；⑧ 一次写入**只 `backup` 一次**（同秒 `.bak` 会互相覆盖）；⑨ 排序**两路同改**（`render_manifest` 与 `--sync` 合并都用 node 默认排序；只改一路会让「首装 → --sync 不新增备份」用例变红）；⑩ marker 在但禁用行缺失 → 只 warn、不自动重写（自愈属「守卫残余」）；⑪ warn 带 `<patch>:<行号>`（awk 取非注释首行号）。
- 代码：`scripts/install.sh`（`--take-over-title` 选项 + 与 `--sync` 互斥校验、守卫段重写、`render_manifest` 排序、合并排序）；`scripts/test-install.sh`（新增 `assert_same_file` / `assert_count_eq` / `assert_active_count_eq`，重写第 7 例为 7a-7g 独立 profile 组，更新备份总数断言）。
- 未做（留给下一条「守卫残余」）：`--sync --force` 覆盖组合、awk 条目边界、两段 marker 拆开 / 路由重试、payload id 硬编码、marker↔payload 自愈——已追加进 BACKLOG 第 2 条。
- 附带修正：`session-title-cutoff/README.md` 的手工接入指引路径 `docs/implementation/…` 已归档（实际在 `docs/archived/`）→ 改正（一行，未单开条目）。

## 测试与证据

- `sh -n scripts/install.sh` / `sh -n scripts/test-install.sh`：语法通过；`sh scripts/test-install.sh`：**65 项通过**（原 49 项）。
- 反向验证（撤修复必红，逐项）：
  - 撤「显式开关门控」（恢复命中即自动追加）→ 7a「不带 --take-over-title 不改写 patch」必红；
  - 撤「文件头 marker 写入」→ 7b「文件头 marker 恰 1 行」必红（实测 0 次）；
  - 撤「两路排序」→ 7g「manifest 依赖键序为字母序」必红；
  - 另：旧标记迁移分支删掉时 7e 必红（迁移不重复追加 payload 的承重点）。
- 真机（fff）未跑：fff 侧死行属 fff 仓库（条目原文：需用户另行裁定），本仓只做「不再静默改写」；`--help` 已人工核对。

## 收尾

- 回写：`README.md` / `README.zh.md`（选项列表 + 幂等段补「--sync 不改写标题 provider 配置」）、`profiles/example/cordis.patch.yml` 注释口径、`session-title-cutoff/cordis.patch.yml` 头注释、`session-title-cutoff/README.md` 接入前提段。
- 新发现问题另立条目：已并入 `docs/BACKLOG.md` 第 2 条「守卫残余」（④⑤⑥）。
- 本文件移入 `docs/archived/`；`docs/BACKLOG.md` 清理所接条目（仅留未完成项，重新编号）。
- 临时产物：`tmp/ti*.out` 已删、`tmp/check*.log` 已删；无残留。
