# 新包根级接线：coagent（接取条目：`docs/BACKLOG.md` §2「6. 共享文档与根级接线」）

状态：已完成（2026-10-24；仓库 5 处接线 + profile 挂载均已完成，`~/.dsh/profiles/fff` 现挂 34 个 bundle = dsh-base + 33 包，`coagent` 与 `tool-consult` 都在；真机项 #12–#14 已验）　　开启：2026-10-23　　关闭：2026-10-24

## 目标

把新包 `coagent` 接进根级构建与文档，使 `npm run check / build / test` 与 `scripts/install.sh` 覆盖它、README 双侧与 `AGENTS.md` 有它的一行；profile 挂载由 `scripts/install.sh` 完成（写入 `~/.dsh`，属工作区外）。

## 已做

| 处 | 改动 |
| --- | --- |
| 根 `package.json` | `check` / `build` 链尾追加 `npm --prefix coagent run check` / `run build`（`test` 走 `scripts/test-parallel.sh`，改在那里） |
| `scripts/test-parallel.sh` | `default_pkgs` 追加 `coagent` |
| `scripts/install.sh` | `canonical_pkgs` 追加 `coagent` |
| `AGENTS.md` | 包计数 30 → 31、委托链、`coagent/` 包描述、`DESIGN.md` 口径清单加 `coagent`、profile 挂载数 31 → 32；同时把 `herdr-use` 与 `behavior-correction` 两行描述改到新工具面 |
| 根 `README.md` / `README.zh.md` | 包计数 30 / 31 → 31 / 32、功能表加 `coagent` 行、目录树加 `coagent/` 行；同步把 `herdr-use` 与 `behavior-correction` 两行改到新工具面 |
| `coagent/package-lock.json` | 新增（`npm install` 生成，供新环境复现依赖） |

## profile 挂载（2026-10-23 已做）

在 herdr 终端（沙箱外）执行，`~/.dsh/profiles/fff` 现在已挂载 `coagent`：

1. `scripts/install.sh --profile fff --sync --skip-build` —— 关键在 `--sync`：已有 `package.json` 时该脚本默认**保留**不覆盖，只有 `--sync` 才按当前选择集合并刷新（输出「已更新 package.json（本仓库 bundle 32 个 + dsh-base）」）。
2. 随后 `pnpm install`（脚本内的 install 步已在 `--sync` 同一次运行里完成），`node_modules/@dsh-toolset/coagent -> ../../../Projects/dsh-toolset/coagent`，`dsh.profile.bundles` 变成 33 项（dsh-base + 32 个包）。

## 后续挂载（2026-10-24 完成）

- `tool-consult` 同日挂上：同一套 `--sync` 流程，`dsh.profile.bundles` 由 33 项变 34 项（dsh-base + 33 个包）。
- 真机验证 #12 至 #14（`coagent spawn` / `close` / 服务面共享）已在重启后跑完并通过，见 `docs/implementation/2026-10-23-real-machine-verification.md`。

## 验证

- `npm run check`：通过（含 `npm --prefix coagent run check`）。
- `npm run test`：全包 OK，其中 `coagent 31 pass / 0 fail`。

## 收尾（2026-10-24 归档）

- 接线完成：根 `package.json` 四链、`AGENTS.md` 包清单与描述、根 README 双侧、`scripts/{install,test-parallel}.sh` 枚举、`profiles/example` 与用户 profile 全部到位；`~/.dsh/profiles/fff` 现为 dsh-base + 33 个包（34 个 bundle）。
- 真机：#12 至 #14 通过（`coagent` spawn / close / 服务面同源），证据在真机验证清单。
- 关闭依据：条目 6 的接线清单五项全部落地，profile 侧不再有待执行步骤。
