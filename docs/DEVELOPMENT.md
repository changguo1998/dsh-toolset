# 开发与部署手册（agent 查用）

> 职责：agent 开发查用——命令全量、`test:tui` 过滤、单包子包命令、新机器一键安装、agent 面组合口径、构建 → 部署到 profile 的完整流程
> 不负责：每次会话必读的行为规范（语言 / 符号 / 术语 / 格式化 / 变更流程 / 内容变更规范）见根 `AGENTS.md`；包清单与职责见 `docs/PACKAGES.md`；面向人的快速开始与 profile 接入见根 `README.md`
> 过期条件：命令或脚本接口变化时随仓库维护

## 命令全量

仓库根 `package.json` 委托全部子包:

```sh
pnpm run check   # 全部子包类型检查（tsc --noEmit；与 test 同款并行调度）
pnpm run build   # 全部子包编译到 dist/（并行；code-map / md-map 排在第二批）
pnpm run test    # 全部子包测试并行运行（scripts/test-parallel.sh：GNU parallel 为主、xargs 兜底，node --test）
pnpm run demo    # TUI 构建并运行 mock demo（无 DSH 依赖）
pnpm run demo -- --smoke   # TUI 冒烟检查（帧断言 SMOKE_PASS）
pnpm run test:tui          # TUI 单包测试（开发迭代常用，避免全包并行）
pnpm run check:docs        # 文档与注释标准检查（dev/standard/；改动文档后跑，--strict 警告也算失败）
```

`test:tui` 支持过滤：`-- <正则>` 按测试名跨文件过滤、`-- <文件>.test.ts` 只跑指定文件、两者可组合。实现为 `TUI/scripts/test.sh`——node `--test-name-pattern` 必须放在文件参数之前，而 `pnpm run x -- <arg>` 只追加到末尾，故由包装脚本把名字正则安插到正确位置。

单个子包内直接运行各自的 `pnpm run check / build / test / demo`（TUI 另有 `pnpm run bench` 排版性能基准、`pnpm run smoke:pty` 真机冒烟）。

## 一键安装（新机器）

装 dsh → 构建全部插件 → 建 profile 挂载 42 个包（TUI + 41 个插件）:

```sh
scripts/install.sh          # profile 名默认 fff；幂等，--force 才覆盖
scripts/install.sh --help   # 全部选项见 README.md「接入 DSH profile 使用」
```

本项目只用 TUI：agent 面走 profile 全局组合，**不配置 agent preset**（依据见 `docs/host/AGENT-COMPOSITION.md`），改组合落 profile 用户 patch。

## 构建 → 部署到 profile（本地迭代）

`scripts/install.sh` 一次生成**两个** profile（`--profile fff` 即可，无需额外参数）:

| profile | 依赖协议 | 生效方式 | 用途 |
| --- | --- | --- | --- |
| `fff`（主） | `file:` 快照 | 改仓库不影响；需重跑 `scripts/install.sh --profile fff --sync` 刷新 | 正在跑的会话 / 验收 |
| `fff-test` | `link:` 符号链接 | 改完 `pnpm run build` 即生效 | 新窗口实时开发 |

1. `pnpm run build` 编译到 `dist/`（产物性改动后按 AGENTS.md「变更流程」同步构建）。
2. 开发迭代走 `fff-test`：`dsh --profile fff-test`，改代码 → `pnpm run build` → 重启即看到新行为。
3. 想让它进主 profile：`scripts/install.sh --profile fff --sync`——脚本会删掉 pnpm 的「已是最新」标记重新装、并在装完后断开 pnpm 建的硬链接（`file:` 目录依赖默认硬链接，原地改写会串到 profile；脚本逐包复制一份替换，使主 profile 与仓库彻底解耦）。只重跑 `pnpm install` 不刷新快照（pnpm 不跟踪目录内容变化，已实测）。
4. 两个 profile 除依赖协议外内容一致（`dsh.profile.bundles` / `cordis.patch.yml` / `pnpm-workspace.yaml` 由脚本按主 profile 成品复制）；`--no-test-profile` 可只装主 profile，`--profile-test <名>` 改伴随名，`--mode link` 让主 profile 也用软链接。
