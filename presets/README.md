# presets

随仓库分发的 DSH agent preset 资产：克隆本项目即可获得，不依赖个人配置仓库（如 `~/fff`）。

## 内容

- `presets/fff/preset.yml` — preset 元信息（名称与描述）。
- `presets/fff/agent.cordis.yml` — agent 面组合，内容与官方 `standard` preset 一致，仅身份元信息不同（来源见文件头注释）。

该 preset 覆盖官方编码 Agent 全套能力：文件编辑、Shell、文件与网页检索、Skills、目标与计划模式、压缩（compaction）、子代理与工作流。

本项目 11 个插件（task-engine / goal-contract / metric-loop / hash-edit / fs-digest / ast-tools / security-guard / output-compress / knowledge-base / herdr-integration / code-map）与 TUI 提供的工具，由 profile 的 bundles 与 `cordis.patch.yml` 全局注册；preset 只承载官方 agent 面组合，二者正交叠加，preset 无需也不应重复声明项目工具。

## 配置与部署

安装方式为「真实目录 + 两个文件软链接」：仓库内修改 preset 后无需再同步副本。

```sh
# 1) 建真实目录并软链接两个文件（preset id = 目录名 fff）
mkdir -p ~/.dsh/.agent-presets/fff
ln -sfn "$PWD/presets/fff/agent.cordis.yml" ~/.dsh/.agent-presets/fff/agent.cordis.yml
ln -sfn "$PWD/presets/fff/preset.yml"       ~/.dsh/.agent-presets/fff/preset.yml

# 2) 设为默认 preset（也可在 TUI 用 /preset 选择；仅影响之后新建的会话）
#    在 ~/.dsh/settings.yaml 写入（已有该段则改 default 一行）：
#      agent-presets:
#        default: fff
sed -i '/^agent-presets:/,/^[^[:space:]]/ s/^\([[:space:]]*default:\).*/\1 fff/' ~/.dsh/settings.yaml

# 3) 重启
dsh --profile fff
```

验证：`/preset` 应列出 `fff` 并带默认标记；新会话工具集 = 官方 standard 全套 + 全部项目插件工具。

## 边界与限制

- 不要对 preset 目录本身建软链接：宿主发现 preset 时会跳过符号链接目录；只允许软链接目录内的文件（`readFile` / `stat` 跟随链接，重载按 mtime + size stamp 生效）。
- 不要对本目录的 `agent.cordis.yml` 运行仓库统一的 `format`：该文件含 `!!js` 标签，yq 会剥离标签并丢注释；保持与官方同格式。
- 上游对齐：与官方 `standard` 保持同步或 fork 自改，改 `presets/fff/` 即直接作用于已软链接安装的 `~/.dsh/.agent-presets/fff/`（下次会话挂载按 stamp 自动重载）。
- 来源：`@deepseek-ai/dsh-agent-presets`（MIT）随宿主安装的 `standard` preset。
