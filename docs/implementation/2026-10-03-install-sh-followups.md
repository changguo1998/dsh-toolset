# install.sh 四条待办（接取条目：`docs/BACKLOG.md`「`scripts/install.sh` 的 `backup()` 会在 profile 目录无限堆积 `.bak.<epoch>`」「install.sh 缺「profile 树外加装官方插件版本 vs 宿主版本」检查」「install.sh 收尾缺 `--dump-config` 实测自检」「install.sh 头注释「顺序与根 package.json 一致」口径不实」）

状态：实现　　开启：2026-10-03　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

用户指令（2026-10-03）：四条依次完成、每条完成后提交一次；决策后、实现前先交子代理只读审阅；实现只在本会话做，不派发子代理实现。

## 目标

把 install.sh 的四条待办依次落地并验证，每条完成即提交；过程保持「条目 → 调研 → 决策 → 审阅 → 实现 → 证据」可追溯。

## 调研

### 「备份堆积」

- 现状：`scripts/install.sh` 的 `backup()`（88-96 行）以 `cp -p "$1" "$1.bak.$(date +%s)"` 落备份；调用点四处：`--sync` 清单合并（287）、清单写入 / `--force`（318）、资产复制 pnpm-workspace.yaml / cordis.patch.yml（330）、patch 追加禁用片段（343）。
- 根因：四条路径都是「先备份、再写」，即使新内容与现有文件一致也会写回并备份。`--sync` 的清单合并是确定性变换（同输入同输出），内容未变时照样「备份 + 重写」→ 每次 `--sync` 都新增 `.bak.<epoch>`（fff profile 实测 5 份 `package.json.bak.*` + 1 份 `cordis.patch.yml.bak.*`）。
- 分路径：287 为主源（`--sync` 重跑必触发）；318 / 330 在 `--force` 重跑同内容时同样堆积；343 受幂等标记保护（标记在则整段跳过），只在确实追加时触发，不是堆积源。
- 边界：备份就地命名 `.bak.<epoch>`；同轮同一文件不会重复备份（分支互斥）；脚本契约是只写 `$DSH_HOME` 与仓库。
- 复现（2026-10-03，临时 `DSH_HOME` + PATH 前置假 pnpm，`--skip-dsh --skip-build --plugins TUI`）：首次安装 0 份 `.bak`；`--sync` 连跑两次 → 1 份、2 份；再 `--force` → 5 份（`package.json.bak.*` ×3、`cordis.patch.yml.bak.*` ×1、`pnpm-workspace.yaml.bak.*` ×1）。

### 其余三条

- 预备（2026-10-03，只读）：fff manifest 的树外 pin 形如 `"@deepseek-ai/dsh-session-title-all-prompts-llm": "0.2.0-rc.2"`（精确版本号，非范围）；本仓插件均为 `link:` 且包名 `@dsh-toolset/*`。其余细节待各条目开工时补。

## 决策

### 「备份堆积」

- 选项：① 内容未变则跳过备份与写入（先比对）；② 备份收进 `$pdir/.backups/` 并只保留最近 N 份。
- 选定：①，覆盖三处写入点（`--sync` 合并、清单写入、资产复制）；343 保持原样（仅在实际追加时触发）。
- 理由：（a）直接满足条目验收「连续跑两次 `--sync` 不再新增 `.bak`」；（b）改动最小，不改变备份的位置与命名（就地 `.bak.<epoch>`，用户按现状查看/清理），无需迁移历史文件、不引入保留策略；（c）不触碰无关面。
- 实现形态：新内容先写同目录临时文件（`<file>.tmp.$$`）→ `cmp -s` 比对 → 一致：删临时文件 + 记「内容未变，跳过备份与写入」；不一致：`backup` 后 `mv` 覆盖（保持先备份再替换）。清单合并的 node 段改为「读原文件、写临时文件」（合并逻辑不变）；清单写入路径先渲染到临时文件、先做 JSON 校验、再比对/替换；资产复制前 `cmp -s "$profile_asset_dir/$asset" "$target"`。
- 文档：脚本头「幂等」注释与 `--force` usage 行改口径；双语 README「安装」节补一句「备份仅发生在内容有变化时」。
- 验证：新增 `scripts/test-install.sh`（临时 DSH_HOME + PATH 前置假 pnpm，仓库外零落盘），断言：① 首次安装 0 份 `.bak`；② `--sync` 连跑两次仍 0 份；③ 改动插件选择后 `--sync` 产生 1 份且再跑不增；④ `--force` 同内容重跑不新增。
- 审阅（子代理，2026-10-03，前台紧凑版）：结论 **需修改（方向正确）**。核对结论：全新安装清单与 merge 输出逐字节相同（故「首次安装 → `--sync`×2 → 0 份」成立；手工改过的旧 profile 首次 sync 可能产 1 份）；四条 backup 触发条件 —— 287「`--sync` 且清单存在，无条件」/ 318「`--force` 且非 `--sync`」/ 330「仅 `--force` 重跑」/ 343「首次追加、marker 后跳过」。
- 采纳的意见：① 不用临时文件 —— 清单两处改「命令替换比对」（`merged="$(node …)"` / `rendered="$(render_manifest)"` 再与 `$(cat)` 比较；POSIX、dry-run 天然不落盘、无残留清理问题）；② `cmp -s` 只写在 `if` 条件里（`set -eu` 下裸跑返回 1 会中止）；③ 清单写入前先校验渲染结果（修掉原「先备份后校验」顺序）；④ dry-run 分支保持只打印；⑤ 测试补强：正向断言（内容确实更新 + 用户自加依赖/bundle 保留）、标题 provider 追加场景（首轮 1 份 / 次轮 0 份 / marker 一次）、`--force` 内容有变仍备份、`--dry-run` 不落盘、无 `.tmp.*` 残留；计数限定到具体文件模式。
- 转出（本条目范围外，记入「新发现」并登记 BACKLOG）：`--sync --force` 的 patch 覆盖缺口；awk 取值越界与 marker 过宽；`--sync` 不卸载本仓库插件的语义/日志口径。
- 顺带修正（审阅标记、同属「安装」节）：双语 README 的包数 19 → 21；`--help` 摘要补 `--sync/--skip-dsh/--skip-build`。

## 规划

- 顺序（依 BACKLOG 表内先后）：备份堆积 → 树外版本检查 → dump-config 自检 → 头注释口径（条目一律按标题引用，编号仅供阅读）。
- 每条流程：调研 → 决策 → 子代理审阅（只读）→ 本会话实现 → 验证 → 提交。
- 计划改动文件清单：
  - `scripts/install.sh`（四条的主落点）
  - `scripts/test-install.sh`（新增：install.sh 回归测试，随条目增量扩展）
  - 根 `README.md` / `README.zh.md`（「安装」节）
  - `docs/BACKLOG.md`（四条：开工标「进行中」→ 完成后清理）
  - 本追踪文档
- 明确不做：不改 `profiles/example/*`（标题守卫另属条目）；不重构 install.sh 无关段落；不新增 CI；不碰用户侧 `~/.dsh`（fff profile 属仓库外）。

## 实现记录

- 2026-10-03（「备份堆积」）：
  - `scripts/install.sh`：头注释、`--force` usage、`backup()` 注释改口径（内容未变不写、不备份）；`--sync` 合并段与清单写入段统一为「先算内容（命令替换）→ 与现状比对 → 不同才 `backup` + 写入」；资产复制段加 `cmp -s` 跳过（dry-run 语义一致）；清单 JSON 校验从「写后」提前到「写前」（校验渲染结果）。
  - 新增 `scripts/test-install.sh`：17 项断言（PATH 前置假 pnpm + 临时 `DSH_HOME`，仓库外零落盘）。
  - 根 `README.md` / `README.zh.md` 安装节：备份口径改写、包数 19 → 21、`--help` 摘要补 `--skip-dsh/--skip-build/--sync`。
  - `docs/BACKLOG.md`：本条目标「完成（2026-10-03）」；审阅转出条目见「新发现」。

## 测试与证据

- `sh -n scripts/install.sh`、`sh -n scripts/test-install.sh`：语法 OK。
- `sh scripts/test-install.sh`：**17/17 通过**（首次安装 0 备份；`--sync`×2 0 新增；`--force` 同内容 0 新增；`--dry-run` 不改目录；内容有变 → 1 份且再跑不增；`--force` 有变 → 1 份；标题守卫追加 → 1 份且 marker/片段只一次；备份总数 3 份；无 `.tmp.*` 残留）。
- 修复前基线（同思想的手工复现，2026-10-03）：首次 0 → `--sync`×2 → 1、2 份 → `--force` → 5 份；修复后「首次 + `--sync`×2」保持 0 份，对照成立。
- `shellcheck scripts/install.sh scripts/test-install.sh`：仅 info 级（SC2016 单引号内含 JS、SC2086 故意的分词），属设计如此。
- `shfmt -i 4 -ci -s -sr -d`（`format` 命令对 .sh 的实际参数）：新增代码零差异；仓库既有 shell 脚本同样未统一走 shfmt，未做无关格式化。
- 未跑 `npm run check / build / test`：本次不涉及 TS / 包面改动（仅 shell 与文档），无从覆盖。

## 新发现（已登记 BACKLOG）

- 「备份堆积」审阅转出：`--sync --force` 覆盖用户 patch 后标题守卫片段丢失不补回；awk 取值越界；marker 过宽 → 项目级 BACKLOG「install.sh 标题 provider 守卫残余（`--sync --force` 组合 / awk 取值 / marker 过宽）」。
- 「备份堆积」审阅转出：`--sync` 不卸载本仓库插件（extras 保留、依赖不删），日志「已保留的额外 bundle」口径易误导 → 项目级 BACKLOG「install.sh `--sync` 的「移除」语义与日志口径」。

## 收尾

（关闭前补齐）
