# install.sh --sync 改名残留修复（接取条目：`docs/BACKLOG.md`「`install.sh --sync` 包改名残留」）

状态：规划　　开启：2026-10-08　　关闭：—
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
| `docs/BACKLOG.md` | 条目状态（开工标〔进行中〕；收尾移除） |
| 本文件 | 唯一文档落点（关闭后移入 `docs/archived/`） |

**明确不做**：

- 不改本机 profile 目录（已手工修好，属环境操作、不入库）；
- 不改官方包、其它脚本、patch 写入与标题接管逻辑；
- 不追加上位抽象（不做「通用清理器」）。

## 实现记录

（待实现）

## 测试与证据

（待补：`sh scripts/test-install.sh`）

## 收尾

（待关闭）
