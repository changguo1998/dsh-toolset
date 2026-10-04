# install.sh `--sync` 的「移除」语义与日志口径（接取条目：`docs/BACKLOG.md`「install.sh `--sync` 的「移除」语义与日志口径」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `scripts/install.sh`（`--sync` 合并段的语义与文案：按当前选择集移除本仓库条目；usage 文案）
- `scripts/test-install.sh`（新增第 8 组用例 + `assert_not_contains` 助手）
- `README.md` / `README.zh.md`（`--sync` 语义一句话，保持逐节同构）
- `docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研（已核）

- 现状（`scripts/install.sh` 的 `--sync` 合并段）：`ours` = 当前选择集；`extras = existing.filter(n => !ours.has(n) && n !== "@deepseek-ai/dsh-base")` —— **本仓库但已不在选择集的条目**与用户自加条目被混在同一桶里保留；依赖侧更直接：只增不删。故「`--sync` 改小选择集」实际不卸载任何本仓库插件，而日志写「已保留的额外 bundle」，易读成「保留了用户自加项」。
- 可判定性：脚本已有 `canonical_pkgs`（本仓库全部插件目录），**能**把「本仓库已移出选择集」与「非本仓库」分开——这是改语义的前提。
- 既有口径（不改）：`--force` 会重渲染 `package.json`，用户自加项按设计丢失；`--sync --force` 组合仍被拒。

## 决策

1. **改语义**（不采用「只改日志」的备选）：`--sync` 按**当前选择集**刷新本仓库条目——`dependencies` 与 `bundles` 里属于 `canonical_pkgs` 但已不在选择集的项**移除**；`@deepseek-ai/dsh-base` 与所有**非本仓库**条目（用户自加依赖 / 额外 bundle）一律保留。理由：flag 名叫 `sync`，选择集是用户唯一能表达的「我要挂哪些」意图，留残留项会让 profile 与选择集长期漂移。
1. **移除清单可见**：合并段把 `REMOVED_BUNDLES` / `REMOVED_DEPS` / `KEPT_EXTRAS` 经 **stderr** 回传（stdout 仍只放 manifest JSON，便于直接落盘），有移除时打一条 `已按当前选择集移除本仓库条目：…`；常规更新日志改为「本仓库 bundle N 个 + dsh-base + 非本仓库额外 M 个」——不再用「已保留的额外 bundle」这种会误读的措辞。
1. **空值安全**：`canonical_pkgs` 里读不到 `package.json` 的目录跳过（不炸脚本）；`min` 缺省下 `$kept_extras` 为空串时日志显示 0。
1. `--dry-run` 路径保持只打印计划（不合并、不写盘）。

## 实现记录（2026-10-04）

- `scripts/install.sh`：合并段重写（node 脚本接收 `--all <canonical_pkgs>` 分隔符参数；`readName()` 容错；移除本仓库游离依赖 / bundle；stderr 回传三行统计）；更新日志与新增移除日志；usage 的 `--sync` 文案改为「按当前选择集刷新…移除已不在选择集的本仓库依赖 / bundle，非本仓库条目保留」。
- `scripts/test-install.sh`：新增 `assert_not_contains` 助手；第 8 组用例（先补回用户自加项→`--sync` 收窄到 `TUI`→断言 ponytail 依赖/bundle 已移除、非本仓库依赖与 bundle 保留、日志含移除口径）。
- `README.md` / `README.zh.md`：脚本段落补一句 `--sync` 的收窄语义（EN/ZH 逐句对应）。

## 测试与证据（2026-10-04）

- `sh scripts/test-install.sh`：**81 项全通过**（既有 77 + 新增 4；`bash -n` 语法检查通过）。
- 反向验证：见收尾记录。

## 子代理审阅（决策后 + 收尾前合并一轮，2026-10-04）

只读复核（含集合判定小实验；未跑完整 `test-install.sh`，主会话已跑 81 项全通过）。结论「可提交」，三条建议已同批修：

1. **[重要] 失败路径吞掉 node 报错**：`merged="$(node … 2>"$merge_err")"` 失败时直接 `rm` + `die`，原实现的 node 报错会打到终端，现在只剩一行「合并更新失败」。→ `die` 前先 `cat "$merge_err" >&2`（保留排障信息）。
1. **[次要] `--all` 用 `canonical_pkgs` 会漏掉「带 `dsh.bundle` 但未列入清单」的仓库目录**（那类目录可被 `--plugins` 选中装进去，却识别不出是本仓库条目 → 永不被移除）。→ 改用脚本已算出的 `$discovered`（仓库内全部 `dsh.bundle` 目录，未列入清单的会被 warn）。
1. **[次要] 新用例编号撞号且未核对移除名单**：原写成「# 8）」与既有第 8 组重复、且插在「11）接线一致性」段中间。→ 移到 11）之前并改编号「# 10c）」（10b 已被占用）；断言从「日志含移除口径」升级为**列明移除名单**（`bundle [@dsh-toolset/ponytail]`）。

已核无问题：四组集合判定自洽（`@deepseek-ai/dsh-base` / 用户自加依赖 / 用户自加 bundle / 选择集内条目都实测保留，重复项折叠）；`--sync --force` 仍被拒；「内容未变不写不备份」路径未变；`$canonical_pkgs` 无引号词分割即 argv 列表符合预期；`sed` 空值路径安全；README 双档与 `usage()` 口径一致；`bash -n` 通过；diff 仅清单内文件。未采纳（记为已知边界）：`merge_err` 无 `trap`（SIGINT 时可能残留一个 `/tmp` 临时文件，下次运行不读它）；`--dry-run` 不预览移除清单（与决策 ④ 一致）。

## 收尾

- 条目从 `docs/BACKLOG.md` 移除（表内其余条目重编号）。
- 本追踪文档移入 `docs/archived/`；本次变更合并为一次提交（`scripts/install.sh` + `scripts/test-install.sh` + README 双档 + BACKLOG + 归档文档），提交见 git 历史。
- 复跑记录：`sh scripts/test-install.sh` **81 项全通过**（含新增 / 强化的 4 项）、`bash -n` ✓、根 `npm run check` / `npm run build` ✓（无代码路径变化）。
