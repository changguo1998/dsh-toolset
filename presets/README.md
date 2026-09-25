# presets

随仓库分发的 DSH agent preset 资产：克隆本项目即可获得，不依赖个人配置仓库。仓库内的资产目录名固定为 `example`（通用资产名）；**安装后的 preset id 由安装目录名决定**（`scripts/install.sh --preset <名字>`，默认 `fff`）。

## 内容

- `presets/example/preset.yml` — preset 元信息（显示标签与描述）。
- `presets/example/agent.cordis.yml` — agent 面组合，内容与官方 `standard` preset 一致，仅身份元信息不同（来源见文件头注释）。

该 preset 覆盖官方编码 Agent 全套能力：文件编辑、Shell、文件与网页检索、Skills、目标与计划模式、压缩（compaction）、子代理与工作流。

本项目 12 个插件（task-engine / goal-contract / metric-loop / hash-edit / fs-digest / ast-tools / security-guard / output-compress / knowledge-base / herdr-integration / code-map / context-report）与 TUI 提供的工具，由 profile 的 bundles 与 `cordis.patch.yml` 全局注册；preset 只承载官方 agent 面组合，二者正交叠加，preset 无需也不应重复声明项目工具。

## 配置与部署

一键安装（含 dsh、插件构建、profile 与 preset 配置）：

```sh
scripts/install.sh                      # profile 与 preset 名都用默认值 fff
scripts/install.sh --preset myagent     # 换 preset 安装名（id = 安装目录名）
scripts/install.sh --preset-link        # 改软链接模式（见下）
scripts/install.sh --help               # 全部选项
```

两种安装形态（脚本默认前者，两者的 preset 目录本身都必须是**真实目录**）：

| 形态 | 做法 | 取舍 |
|------|------|------|
| 真实副本（默认） | `cp` 两份文件到 `~/.dsh/.agent-presets/<id>/` | 本机配置**不依赖仓库路径**：仓库改名/移动/删除都不影响已装 preset；代价是仓库内改动不再自动生效，需重跑脚本（或再 cp 一次） |
| 软链接（`--preset-link`） | `ln -sfn` 指向 `presets/example/` | 仓库内改 preset 立即生效（下次会话按 stamp 重载）；代价是本机配置依赖仓库路径，仓库改名会让链接悬空 |

手工安装与副本模式等价（把 `cp` 换成 `ln -sfn` 即软链接模式）：

```sh
# 1) 建真实目录并复制两份文件（preset id = 目录名，这里取 fff）
mkdir -p ~/.dsh/.agent-presets/fff
cp "$PWD/presets/example/agent.cordis.yml" ~/.dsh/.agent-presets/fff/agent.cordis.yml
cp "$PWD/presets/example/preset.yml"       ~/.dsh/.agent-presets/fff/preset.yml

# 2) 设为默认 preset（也可在 TUI 用 /preset 选择；仅影响之后新建的会话）
#    在 ~/.dsh/settings.yaml 写入（已有该段则改 default 一行）：
#      agent-presets:
#        default: fff
sed -i '/^agent-presets:/,/^[^[:space:]]/ s/^\([[:space:]]*default:\).*/\1 fff/' ~/.dsh/settings.yaml

# 3) 重启
dsh --profile fff
```

验证：`/preset` 应列出 `fff`（标签取自 `preset.yml` 的 `name`）并带默认标记；新会话工具集 = 官方 standard 全套 + 全部项目插件工具。

## 边界与限制

- 不要对 preset 目录本身建软链接：宿主发现 preset 时会跳过符号链接目录；目录内的**文件**可以软链接（`readFile` / `stat` 跟随链接，重载按 mtime + size stamp 生效），但那样本机配置就依赖仓库路径了——默认用副本。
- 不要对本目录的 `agent.cordis.yml` 运行仓库统一的 `format`：该文件含 `!!js` 标签，yq 会剥离标签并丢注释；保持与官方同格式。
- 上游对齐：与官方 `standard` 保持同步或 fork 自改。软链接模式下改 `presets/example/` 立即作用于已装 preset；副本模式下需重跑 `scripts/install.sh`（或手工 cp）才生效。
- 来源：`@deepseek-ai/dsh-agent-presets`（MIT）随宿主安装的 `standard` preset。
