# agent preset 资产

本目录提供随仓库分发的 **agent preset**（DSH `dsh-agent-presets` 格式：`preset.yml` 元信息 + `agent.cordis.yml` 组合）。与个人配置仓库（如 `~/fff`）无关——克隆本项目即可获得，供没有 `~/fff` 的其他安装者直接部署。

## fff（`presets/fff/`）

- **内容**：官方 `standard` preset 的完整 agent 面组合（byte-identical 克隆），仅文件头注释标注来源与用途（详见 `presets/fff/agent.cordis.yml` 头部）。
- **作用**：作为 fff profile（或任意 profile）会话的 agent 组合——提供官方编码 Agent 全套：文件编辑、Shell、文件与网页检索、Skills、目标、计划模式、压缩（compaction 三件套）、子代理与工作流。
- **与本项目插件的关系**：本项目 10 个插件 + TUI 的工具（`task_*` / `goal_*` / `metric_loop` / `fs_digest` / `hash_edit` / `ast-tools` / `guarding` 等）由 profile 的 bundles / `cordis.patch.yml` **全局注册**，preset **无需也不应**重复声明它们——preset 只承载官方 agent 面组合，二者正交叠加。

### 部署（软链接，三步）

本目录即安装源：以**真实目录 + 文件软链接**方式安装，仓库内修改 preset 后无需再同步 live 副本。

> 不要对整个 preset 目录建软链接：DSH 的 preset 发现用 `readdir({withFileTypes:true})` 判 `Dirent.isDirectory()`，符号链接目录返回 `false`，会整个跳过、不列入 roster。仅**目录内的文件**允许软链接（`readFile`/`stat` 均跟随链接，reload 用 mtime+size stamp 也随之生效）。

```sh
# 1) 真实目录 + 两个文件软链接指向本仓库（id = 目录名 fff）
mkdir -p ~/.dsh/.agent-presets/fff
ln -sfn "$PWD/presets/fff/agent.cordis.yml" ~/.dsh/.agent-presets/fff/agent.cordis.yml
ln -sfn "$PWD/presets/fff/preset.yml"       ~/.dsh/.agent-presets/fff/preset.yml

# 2) 设为默认 preset（也可在 TUI 用 /preset 选择；仅影响之后新建的会话）
#    在 ~/.dsh/settings.yaml 的 agent-presets 段写 default: fff：
#      agent-presets:
#        default: fff
#    （若已存在该段，可用锚定段内的 sed 一次改写，不误伤其他命名空间）：
sed -i '/^agent-presets:/,/^[^[:space:]]/ s/^\([[:space:]]*default:\).*/\1 fff/' ~/.dsh/settings.yaml

# 3) 重启
dsh --profile fff
```

验证：`/preset` 应列出 `fff` 并带默认标记；新会话工具集 = 官方 standard 全套 + 全部项目插件工具。

### 维护约定

- 与官方 `standard` 保持对齐（上游 deepseek-harness `/packages/.../presets/standard`）或 fork 自改；改本目录 `presets/fff/` 即直接作用于已软链接安装的 `~/.dsh/.agent-presets/fff/`（下次会话挂载按 stamp 自动重载），无需二次同步。
- **`agent.cordis.yml` 含 `!!js` 标签（如 `process.platform` 门控）**：仓库统一的 `format` 对 YAML 走 yq，会剥离 `!!js` 并丢注释——**不要**对本文件运行 `format`；保持与官方同格式即可。
- 来源：`@deepseek-ai/dsh-agent-presets`（MIT）随宿主安装的 `standard` preset；本克隆仅改身份元信息，组合内容与原版一致。
