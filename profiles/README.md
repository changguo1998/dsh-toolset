# profiles

随仓库分发的 DSH **profile 配置示例**：`example/` 是可直接复制的 profile 三件套骨架，演示本项目插件如何挂进 profile，以及用户层如何覆盖宿主 / 插件配置（含权限预设表）。

本目录是 **profile**（进程装配与插件挂载层，装到 `~/.dsh/profiles/`）：本项目只用 TUI，agent 面就由这里的 profile 全局组合提供，**不使用 agent preset**（说明与依据见 `../docs/AGENT-COMPOSITION.md`）。

## 内容

| 文件 | 作用 |
|------|------|
| `example/package.json` | profile 清单：`dsh.profile.bundles` 列出要加载的 bundle 层，`dependencies` 用 `link:` 指向本仓库包 |
| `example/cordis.patch.yml` | 用户层 patch：`- id:` 覆盖既有条目、`- insert:` 新增条目；含权限预设表覆盖（自定义 `full-ask` 预设）与 `!!js` 表达式示例 |
| `example/pnpm-workspace.yaml` | profile 内 pnpm 行为（`nodeLinker: hoisted`），与宿主 `initProfile` 生成的默认内容一致 |

## 用法

一键安装（推荐，含 dsh、全部插件构建与 profile 挂载）：

```sh
scripts/install.sh                 # profile 名默认 fff
scripts/install.sh --profile dev   # 换 profile 名；--plugins 可只选哪些插件
scripts/install.sh --help          # 全部选项
```

profile 侧脚本写下的都是**副本**（`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`），只有 `package.json` 的 `link:` 依赖指向仓库里的插件包（插件代码，本地开发期靠它实时生效）；想让插件也不依赖仓库路径，用 `dsh plugin --profile <p> add <包名或 tarball>` 换成快照式安装。

手工复制（等价于脚本的 profile 步骤）：

```sh
# 1) 复制示例到宿主 profile 目录（目录名 = `dsh --profile <名字>` 的名字）
cp -r profiles/example ~/.dsh/profiles/myprofile

# 2) 把 package.json 里的 link: 占位路径改成本仓库真实路径
#    "link:/path/to/dsh-toolset/TUI" → "link:$PWD/TUI"，其余同理。
#    勿改成 file:：pnpm v11 不跟踪目录内容变化，源码改动后 profile 会报 ERR_MODULE_NOT_FOUND。

# 3) 装依赖：link: 指向本仓库包时可跳过；含第三方包时必须装
cd ~/.dsh/profiles/myprofile && pnpm install

# 4) 核对组合树后启动
dsh --profile myprofile --dump-config
dsh --profile myprofile
```

## 边界

- 只放配置骨架，**不含凭据、令牌或私有端点**：模型 provider 名、访问凭据与端点都属 `~/.dsh/settings.yaml`，本目录不涉及；示例里的 `link:` 路径一律用 `/path/to/...` 占位，需自行替换。
- 用户层 patch 的 `config` 是**整键替换**（`dsh-app-boot` 的 `composeEntries` → `cordis-plugin-include` 的 `applyEntryPatches` 按顶层键赋值）：覆盖 `permission` 这类自带默认表的条目时，未重述的表项会回落到插件 schema 默认值，故示例把三项内置预设全量重述后再追加自定义项。
- 示例按宿主 `0.1.5-rc.3` 的条目 id 编写（`permission` / `tui` / `knowledge-base` / `compaction-basic` / `schedule`）；宿主升级后若 id 变化，`dsh --profile <p> --dump-config` 与启动日志里的 patch 告警是最快的核对手段。
- 示例不含 profile 根的 `cordis.yml`：它是宿主在**每次启动时重写**的空条目桩（只作 loader 的 anchor，手改无效），配置一律写在 `cordis.patch.yml`。同理 `node_modules/`、`.dsh-module-fallback/` 与 `$DSH_HOME/profiles/node_modules` 也由宿主每次启动自行维护。
