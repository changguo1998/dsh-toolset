# 新包根级接线：coagent（接取条目：`docs/BACKLOG.md` §2「6. 共享文档与根级接线」）

状态：进行中（2026-10-23；仓库内 5 处已改，profile 那一步待用户执行）　　开启：2026-10-23

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

## 未做

- **profile 挂载**：`~/.dsh/profiles/fff` 需执行 `scripts/install.sh --profile fff`（幂等，只补缺失项）才会加载 `coagent`；该目录在工作区外，本次未改。
- 真机验证 #12 至 #14（`coagent spawn` / `close` / 服务面共享）等 profile 挂载后重启 dsh 再做，清单见 `docs/implementation/2026-10-23-real-machine-verification.md`。

## 验证

- `npm run check`：通过（含 `npm --prefix coagent run check`）。
- `npm run test`：全包 OK，其中 `coagent 31 pass / 0 fail`。
