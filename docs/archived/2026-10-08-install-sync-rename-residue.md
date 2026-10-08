# install.sh --sync 改名残留修复（接取条目：`docs/BACKLOG.md`「`install.sh --sync` 包改名残留」）

状态：关闭　　开启：2026-10-08　　关闭：2026-10-08
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

修 `scripts/install.sh --sync` 的合并式更新：包改名后，旧包名（依赖值仍 `link:` 指向本仓库）
不再被误判为「用户自加依赖」而永久残留——`dependencies` 与 `dsh.profile.bundles` 两处都按
「不在当前选择集即移除」处理。

## 调研

- **现象**（2026-10-08 真机）：`knowledge-base` 改名 `memory-base` 后，本机
  `~/.dsh/profiles/fff/package.json` 里 `@dsh-toolset/knowledge-base` 仍留在 `dependencies`
  （值指向已不存在的仓库路径）与 `dsh.profile.bundles`；`dsh --profile fff --dump-config` 报
  `skipping profile bundle "@dsh-toolset/knowledge-base": cannot resolve profile bundle`，
  而 install.sh 收尾自检只记「注意」、退出码仍 0。手工清掉这两条后告警消失（本机已修）。
- **根因**（`scripts/install.sh` 内联合并脚本）：`repoNames = allDirs.map(readName)` 只含**当前
  仓库目录**的包名；`removedDeps` / `removedBundles` 的判据都是
  `repoNames.has(name) && !ours.has(name)`。改名后旧名不在 `repoNames` 里，于是落进
  `extras`（`!ours.has(name) && !repoNames.has(name)`）被当作「用户自加」保留。
  即代码注释里「仓库内全部插件名」这条前提在改名场景下不成立。
- **既有覆盖**：`scripts/test-install.sh` §5 只验「用户自加依赖 / bundle 保留」，没有
  「本仓条目被改名后应移除」的用例。

## 决策

- **判据扩展**（选定）：把「依赖值形如 `link:<repoRoot>/…` 的既有条目」并入本仓条目集合
  `linkedRepo`，令 `isRepoEntry(name) = repoNames.has(name) || linkedRepo.has(name)`，
  三处判据（`removedDeps` / `removedBundles` / `extras`）统一改用 `isRepoEntry`。
  - 理由：改名后唯一没变的是「依赖值仍指向本仓库」；仅凭名字无法区分「改名残留」与
    「用户自加」。依赖与 bundle 同名时（本仓惯例），由依赖侧识别即可覆盖 bundle 侧。
  - 顺带把脚本里声明但未使用的 `prefix` 参数用起来（`link:` 前缀由调用方传入）。
- **备选（否）**：按 npm scope（`@dsh-toolset/`）判定 → 会误删用户自加的同 scope bundle；
  按名字黑名单 → 不可维护。
- 不改 `--force` 路径、不改 patch 写入与标题接管逻辑。

## 规划

计划改动文件清单：

| 文件 | 改动性质 |
| --- | --- |
| `scripts/install.sh` | 合并脚本：新增 `link:` 目标判定，三处判据改用 `isRepoEntry` |
| `scripts/test-install.sh` | 新增用例：改名残留（依赖 + bundle 用同一旧名）被移除、当前名照常挂载 |
| `docs/BACKLOG.md` | 条目状态（开工标〔进行中〕；收尾移除）+ 追加途中发现的既有红灯条目 |
| 本文件 | 唯一文档落点（关闭后移入 `docs/archived/`） |

**明确不做**：

- 不改本机 profile 目录（已手工修好，属环境操作、不入库）；
- 不改官方包、其它脚本、patch 写入与标题接管逻辑；
- 不追加上位抽象（不做「通用清理器」）。

## 实现记录

- 2026-10-08 决策落定 → 提交文档（`bc49e6d`：BACKLOG 条目 + 本文件）。
- 2026-10-08 **实现**（`scripts/install.sh` 合并脚本，4 处改动）：
  - 新增 `linkedRepo`（依赖值形如 `link:<repoRoot>/…` 的既有条目）与
    `isRepoEntry(name) = repoNames.has(name) || linkedRepo.has(name)`；插在
    `manifest.dependencies ??= {}` 之后、写入新依赖之前，故读到的是**既有**条目。
  - `removedDeps` / `removedBundles` / `extras` 三处判据统一改用 `isRepoEntry`。
  - 顺带用起原先声明未使用的 `prefix` 参数（`link:` 前缀来自调用方）。
  - 替换经一次性 node 脚本执行（每个待替换片段断言「命中恰好 1 次」），脚本用后即删。
- 2026-10-08 **用例**（`scripts/test-install.sh` 新增 §5b，独立 profile `trename`）：
  造「依赖与 bundle 同为旧名、依赖值仍指向本仓库」的改名残留，断言残留被移除
  （`assert_not_contains`：成功静默）、当前名照常挂载、同轮真·用户自加 bundle 仍保留
  （守住 `extras` 判据未被放宽）。
- 2026-10-08 **验证**：`npm run check` / `npm run build` / `npm run test` 均 exit 0，
  21 包全绿（本次改动只碰 shell 脚本，TS 面无变更；仍按要求三项跑齐）。

## 测试与证据

- **正向**（修复在位）：`sh scripts/test-install.sh` —— 本用例三条断言全过（两条打印
  「通过：当前名照常挂载」/「通过：真·用户自加 bundle 仍保留」，第三条成功静默）；
  套件唯一失败是**既有红灯**（见下），与本改动无关。
- **反向**（`git stash push -- scripts/install.sh` 后重跑）：本用例变红——
  `失败：改名残留（依赖 + bundle）被移除（不应包含：@dsh-toolset/ponytail-old；…/profiles/trename/package.json）`
  → 用例确实卡住这次修复；`git stash pop` 恢复后重跑回到「只余既有红灯」。
- **真机**：本机 `~/.dsh/profiles/fff` 已按同口径手工修好（patch 4 行 + 清单 2 条），
  `dsh --profile fff --dump-config` 无 `skipping` 告警、`- id: memory-base` 正常挂载。
- **既有红灯（本轮实测发现，非本任务引入）**：`profiles/example/cordis.patch.yml` 自
  `1e17b50`（卸载账号登录链）起含 2 条活跃 `disabled: true`，而 §7 断言期望 1 → 实得 3 而失败；
  且 `fail()` 立即 `exit 1`，套件在**第 17 项**中止，其后约 32 项检查从未执行。该脚本未被任何
  npm 脚本引用（只手动跑），故红灯长期未被发现。已按流程追加 BACKLOG 条目（置于 §2 首位）。
- **残留检查**：临时 node 脚本与临时日志已清；`tmp/` 下其余文件为本任务之前既有。

## 收尾

- **回写文档**：`docs/BACKLOG.md` —— 追加「`test-install.sh` 既有红灯」条目（§2 首位，交其他
  agent）；本条目完成并从 §2 清理移除，余下条目按当前顺序重编号，§2「当前可开工顺序」注记同步重写。
- **提交链**：文档 `bc49e6d`（条目 + 本文件）→ 代码与用例 `813b3fc` → 关闭提交（本文件归档 +
  `docs/BACKLOG.md` 变更），关闭提交为本次变更的**最后一次提交**。
- **遗留项**：① 既有红灯条目（本任务范围外，未修）；② 本机 `~/.dsh/profiles/fff` 的手工修复与
  两份 `.bak` 属环境操作、不入库；③ 旧库 `~/.dsh/knowledge-base`（582 MB）已按用户裁定删除。
- **归档**：本文件由 `docs/implementation/` 移入 `docs/archived/`（`git mv`）。
