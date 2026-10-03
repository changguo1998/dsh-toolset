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

### 「树外版本检查」

- 现状：第 2 步确定/安装 dsh 版本后，脚本不检查既有 profile 里的树外官方插件 pin；第 4 步只按 `--sync`/`--force` 处理清单与资产。fff 实测曾出现「profile pin 已 0.2.0-rc.2、宿主仍 0.1.7-rc.2」，脚本无任何提示。
- 数据结构（只读实测）：fff manifest 的 pin 形如 `"@deepseek-ai/dsh-session-title-all-prompts-llm": "0.2.0-rc.2"`（精确版本号，非范围）；本仓插件均为 `@dsh-toolset/*` + `link:`。
- 版本取值：不 `--skip-dsh` → 目标版本 `$dsh_version_default`（第 2 步刚确保）；`--skip-dsh` → 实际宿主 `dsh --version` 输出（本机实测为裸版本号 `0.2.0-rc.2`；取不到则跳过并告警）。
- 触发时机：manifest 存在时每次运行都查（读前先 `-f` 判在），新建 profile 场景自然跳过；检查只读，dry-run 同样执行。

### 「收尾自检」

- 现状：脚本收尾只提示用户自己跑 `dsh --profile <name> --dump-config`；「引用了未安装/不存在条目 id」等 patch 告警要等手动跑或启动才暴露。
- 探针（2026-10-03，本机实测）：
  - `dsh --profile <name> --dump-config` 由 `prepareProfile` **物化 `cordis.yml` 到 profile 目录**（并非纯只读；仍在 `$DSH_HOME` 内，符合脚本契约）；`DSH_HOME` 被 dsh 尊重（临时 home 夹具实测可组合）。
  - 「不存在条目 id」形态：**退出码仍为 0**，但 stderr 非空（`dsh: [<patch 路径>] patch: entry "…" not found`）→ 判定必须同时看 rc 与 stderr（主要靠 stderr）。
  - 无告警形态：rc=0、stderr 为空（stdout 为组合树，11 KB 级）。
  - 备注：本机对真实 `~/.dsh` 的写入被沙箱（EROFS）拦下，真机验证改用临时 `DSH_HOME` 夹具。

### 「头注释口径」

- 现状：`scripts/install.sh` 第 25 行注释称插件处理顺序「与根 package.json 的 check/build 顺序一致」；实测**集合**一致（21 个）但**顺序**不同（`md-logic` / `md-map` 在脚本里紧跟 `ast-tools`，在根 `package.json` 里靠后）——顺序不影响功能，注释误导读者。
- 双向覆盖现状：正向（`*/package.json` 发现的新 bundle 未列入 `canonical_pkgs` → warn）已有；反向（`canonical_pkgs` 里的目录不存在）只在被选中时由选择循环 `die`（`--plugins all` 会中招，消息却是「--plugins 里的 …」）。
- 根 `package.json` check 链顺序（实测）：`TUI … command-template` **`md-logic` `md-map`** `ponytail`；`scripts/test-parallel.sh` 的 `default_pkgs` 与 `canonical_pkgs` **逐字相同**（含顺序）——这是「顺序」可写的真实锚点。

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

### 「树外版本检查」

- 落点：第 2 步之后、第 3 步之前，独立小段（无步骤编号；输出位置在 `2/5` 与 `3/5` 之间）。
- 判定：node 读 manifest 的 `dependencies`，取 `@deepseek-ai/dsh-*`（天然排除 `@dsh-toolset/*`；再排除 `link:` / `file:` 值）；pin 去掉前导 `^`/`~` 后与宿主版本串比较，不等即列为不一致（profile pin 实测为精确版本；其他范围语法保守报出、由人工确认）。
- 输出：无候选 → 「无树外官方插件依赖，跳过」；全部一致 → 一行 log（带宿主版本）；不一致 → 逐条 `warn`（`名字：spec（期望 版本）`）+ 精确提示（改 pin 后在 profile 目录重跑 `pnpm install`，带 `cd` 命令）；manifest 解析失败 → warn 跳过（不 `die`，保持非 `--sync` 运行对既有 profile 的容错）。
- 只读、无新增开关；dry-run 执行。
- 测试：`scripts/test-install.sh` 增「一致 / 不一致 / 无此类依赖」三态 + 前导 `^` 兼容；宿主版本用 PATH 前置的假 `dsh` 固定输出（走 `--skip-dsh` 分支）。
- 审阅（子代理，2026-10-03）：结论 **需修改（方向正确，无严重问题）**。采纳：① 仅 `^?~?<semver>` 形态参与串比，其余（`>=` / 别名 / `workspace:` / git 等）单列「非精确版本，无法自动判定」，不给「改 pin」的强建议；② 一并扫 `devDependencies`；③ `--skip-dsh` 且 PATH 无 dsh → 静默跳过（第 2 步已告警），dsh 在但输出为空 → 显式 warn 后跳过；④ 测试换独立 `--profile vercheck` 夹具，补解析失败 / `link:` 排除 / 多条目 / `~` 前缀 / 取不到版本；⑤ 解析失败不 `die`。
- 未采纳（审阅可选/边界项）：并查 `node_modules` 实际已装版本（超出本条目范围，留作后续可选）；`--force` 仍照常检查（告警显示现状、供用户知情）；多 profile 不扩查（脚本本为单 profile 契约）。

### 「收尾自检」

- 落点：`5/5 完成` 段内、打印安装结果之前；`--dry-run` 只打印将执行的命令、不真跑。
- 执行：`DSH_HOME="$dsh_home" dsh --profile "$profile_name" --dump-config`，stderr 捕获、stdout 丢弃；**rc 与 stderr 双判**（实测「不存在条目 id」时 rc=0 但 stderr 非空）。
- 输出：通过 → log「收尾自检通过…无告警」；不通过 → warn（含退出码）+ 缩进打印 stderr + 排查提示；**不改变脚本退出码**（不 `die`）。
- 跳过路径：`--skip-verify`（新增开关）→ log 跳过；无 dsh → log 跳过；dry-run → `[dry-run]` 打印。
- 说明：自检会由 dsh 自身物化 `cordis.yml`（在 profile 目录内）；usage、双语 README 的 `--help` 摘要、收尾「提示」段同步补 `--skip-verify` 与自检说明。
- 测试：`scripts/test-install.sh` 增场景 10（假 dsh 分流 `--version` / `--dump-config`）：通过 / stderr 告警 / rc≠0 / `--skip-verify` / `--dry-run`。
- 审阅（子代理，2026-10-03）：结论 **需修改（方向、落点、双判思路都对；无严重问题）**。采纳：① `if dump_err="$(…)"; then rc=0; else rc=$?; fi` 写法（裸赋值在 `set -e` 下会当场中止、破坏「退出码保持 0」）；② stderr 一律 `printf` + 缩进 + 前 20 行截断 + 「共 N 行」注（`echo` 会吃转义、`printf "$err"` 会吃 `%`）；③ 文案去掉「健康检查」口吻、注明「不实例化插件」，并修掉旧「退出码非零」提示（探针证伪：rc 恒 0）；④ `< /dev/null` 防交互挂起；⑤ 测试补多行 stderr（含 `%` 与反斜杠）、截断、`--skip-verify`、`--dry-run`。
- 未采纳（审阅边界项）：`timeout` 包装（非 POSIX，macOS 无）；「PATH 无 dsh」独立夹具（沿用等价覆盖并注明局限）。

### 「头注释口径」

- 选 ①（改口径）而非 ②（对齐两份顺序）：顺序不影响功能，对齐属纯装饰性 churn；注释写明真实锚点 —— 「集合与根 `package.json` 的 check/build 链一致，顺序与 `scripts/test-parallel.sh` 的 `default_pkgs` 同序（`scripts/test-install.sh` 有校验）」。
- 顺带补反向校验（条目 ② 提到的「另一半」，约 3 行）：`canonical_pkgs` 里目录不存在 → `warn`（与正向同口径；不 `die`，避免子集选择被历史残留项误伤）；选择循环里给 `all` / 默认场景的 `die` 文案补「请同步 canonical_pkgs」。
- 不做：不动两处清单顺序；不改 `--plugins` 语义；不从 `package.json` 运行时派生清单（审阅提出，判为新增耦合、且会改变 `all` 的失败语义，不值当）。
- 测试：`scripts/test-install.sh` 增场景 11 —— ① `canonical_pkgs` 与 `default_pkgs` **同序**（原样串比较）；② 与根 check/build 链集合一致且 check==build 同序（在 node 内比较，避 sort/locale）；③ `canonical_pkgs` 每个目录存在。提取一律带空值守卫。
- 审阅（子代理，2026-10-03）：结论 **需修改（轻）**。采纳：注释补真实锚点（原「顺序自定」偏含糊）；反向 warn 放正向告警后、措辞对称；测试加提取守卫并在 node 内比较；`die` 文案补充。未采纳：运行时从 check 链派生清单（同上「不做」）。

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

- 2026-10-03（「树外版本检查」）：

  - `scripts/install.sh`：第 2 步后插入独立小段 —— 读 `$dsh_home/profiles/$profile_name/package.json`（存在才查）；node 扫 `dependencies` + `devDependencies` 的 `@deepseek-ai/dsh-*`（排除 `link:`/`file:`），`^~/semver` 参与串比、其余单列；输出 `none` / `ok` / `unknown …` / `mismatch …`；shell 三分类：无候选跳过 / 一致记 log / 不一致逐条 `warn` + `cd … && pnpm install` 提示；解析失败与「版本取不到」warn 后跳过；只读、dry-run 亦执行。
  - `scripts/test-install.sh`：加假 `dsh`（固定输出 `0.2.0-rc.2`）；`install_` 保留最近一次输出（`$lastlog`），`fail` 只打该次输出；新增场景 9（独立 `--profile vercheck` 夹具，7 小项 14 断言）。

- 2026-10-03（「收尾自检」）：

  - `scripts/install.sh`：新增 `--skip-verify`（变量 / 解析 / usage）；`5/5` 段内、打印结果前插入自检块 —— `DSH_HOME=$dsh_home dsh --profile … --dump-config < /dev/null 2>&1 > /dev/null` 捕获 stderr、rc 与 stderr 双判；通过 → log；未通过 → warn（退出码 + stderr 原文缩进、`20q` 截断 + 共 N 行提示）+ 排查提示；不改退出码；`--skip-verify` / 无 dsh / dry-run 三条跳过路径；收尾「提示」段旧文案（「退出码非零」已证伪）改写为自检口径。
  - 双语 README：`--help` 摘要补 `--skip-verify`。
  - `scripts/test-install.sh`：假 dsh 分 `--version` / `--dump-config` 两分支（`fake_dsh_ok` / `fake_dsh_dump`）；新增场景 10（通过 / 多行 stderr 含 `%` 与反斜杠 / rc≠0 / `--skip-verify` / `--dry-run` / 超长截断）。

- 2026-10-03（「头注释口径」）：

  - `scripts/install.sh`：头注释改为「集合与根 `package.json` 的 check/build 链一致、顺序与 `scripts/test-parallel.sh` 的 `default_pkgs` 同序（`scripts/test-install.sh` 有校验）」；发现循环后补反向校验（`canonical_pkgs` 目录不存在 → warn）；选择循环 `die` 文案补「请同步 canonical_pkgs」。
  - `scripts/test-install.sh`：新增场景 11（同序串比较 / node 内集合与 check==build 同序比较 / 每个目录存在；提取带空值守卫）。

## 测试与证据

- `sh -n scripts/install.sh`、`sh -n scripts/test-install.sh`：语法 OK。
- `sh scripts/test-install.sh`：**17/17 通过**（首次安装 0 备份；`--sync`×2 0 新增；`--force` 同内容 0 新增；`--dry-run` 不改目录；内容有变 → 1 份且再跑不增；`--force` 有变 → 1 份；标题守卫追加 → 1 份且 marker/片段只一次；备份总数 3 份；无 `.tmp.*` 残留）。
- 修复前基线（同思想的手工复现，2026-10-03）：首次 0 → `--sync`×2 → 1、2 份 → `--force` → 5 份；修复后「首次 + `--sync`×2」保持 0 份，对照成立。
- `shellcheck scripts/install.sh scripts/test-install.sh`：仅 info 级（SC2016 单引号内含 JS、SC2086 故意的分词），属设计如此。
- `shfmt -i 4 -ci -s -sr -d`（`format` 命令对 .sh 的实际参数）：新增代码零差异；仓库既有 shell 脚本同样未统一走 shfmt，未做无关格式化。
- 未跑 `npm run check / build / test`：本次不涉及 TS / 包面改动（仅 shell 与文档），无从覆盖。
- 2026-10-03（「树外版本检查」）：`sh scripts/test-install.sh` **31/31 通过**；真机 dry-run（`DSH_HOME=~/.dsh … --profile fff --skip-dsh --skip-build --dry-run`，零写入、只读真实 fff profile）输出 `profile 树外官方插件版本与宿主 dsh 一致（0.2.0-rc.2）`；`shellcheck` 仅 info 级（SC2016/SC2086，设计如此）；`shfmt -i 4 -ci -s -sr -d` 新增代码零差异。局限：「PATH 无 dsh」态因本机存在真实 dsh 无法安全模拟，以「dsh 在但输出为空」等价覆盖（同为 `host_version` 空 → 跳过）。
- 2026-10-03（「收尾自检」）：`sh scripts/test-install.sh` **46/46 通过**。真机端到端（临时 `DSH_HOME` + `XDG_DATA_HOME` 重定位 pnpm store——默认全局 store 在外会被沙箱 EROFS 拦下）：① 基线 `[]` patch → `收尾自检通过`（rc=0）；② 覆盖为 `- id: definitely-not-a-real-entry-id` 单文档 → `收尾自检未通过（退出码 0）` + `patch: entry … not found` + 排查提示，install.sh 仍 rc=0。夹具经验：空 patch 文件、以及「`[]` + 追加第二文档」都会让 dsh 解析失败（脚本同样以「未通过 + 解析错误」如实呈现）。
- 2026-10-03（「头注释口径」）：`sh scripts/test-install.sh` **49/49 通过**；`shellcheck -S warning` 无告警；`shfmt -i 4 -ci -s -sr -d` 新增代码零差异（仅 install.sh 一处既有偏差未动）。备注：反向 `warn` 分支本身未单独构造用例（需复制脚本注入残留项，成本不值；由场景 11 的静态一致性断言兜住）。

## 新发现（已登记 BACKLOG）

- 「备份堆积」审阅转出：`--sync --force` 覆盖用户 patch 后标题守卫片段丢失不补回；awk 取值越界；marker 过宽 → 项目级 BACKLOG「install.sh 标题 provider 守卫残余（`--sync --force` 组合 / awk 取值 / marker 过宽）」。
- 「备份堆积」审阅转出：`--sync` 不卸载本仓库插件（extras 保留、依赖不删），日志「已保留的额外 bundle」口径易误导 → 项目级 BACKLOG「install.sh `--sync` 的「移除」语义与日志口径」。

## 收尾

（关闭前补齐）
