# agent 面组合与 preset 现状（TUI 走 profile 全局组合）

> 职责：agent 面组合现状与官方依据（TUI 走 profile 全局组合、不配 preset）
> 不负责：TUI 命令与渲染实现（见 `TUI/docs/`）
> 过期条件：宿主组合 / preset 机制变化时复核

> 结论一句话：**本项目只用 TUI，agent 面由 profile 的全局组合（`dsh-base` + 本项目 bundles + `cordis.patch.yml`）提供，不配置、不加载 agent preset。**
> 核对时间 2026-09-25；官方仓库 `~/GithubRepos/deepseek-harness` `master` `477b4f4205`（= tag `dsh-v0.1.7-rc.2`）；本项目运行基线 `dsh 0.1.5-rc.3`。

## 1. 官方设计：TUI 是"没有 preset 的单组合面"

- `packages/client/ui-user-questions/README.md:50`（同 `src/index.ts:7`）：`ask_user_question` 行属于需要它的各 preset，"**and to the TUI composition, which has no presets**"。
- `packages/bundle/web-app/cordis.patch.yml:431`：base 保留那些 agent 面工具行是 "for the TUI, which is single-session and composes its agent process-wide"；Web 面才禁用它们并改由每会话 preset 装配。
- `packages/bundle/headless/src/index.ts:334`：同类单组合面 "composes no preset roster, so the model-facing rows sit in the [agent plane]"，并拒绝恢复在 preset 下跑过的会话（同文件 212-218 行）。
- 实测各 bundle 引用 preset registry 的次数：`web-app` 6 次；`base` / `headless` / `sdk-app` / `sdk-minimal` / `acp-app` 均为 0。
- 官方自带 TUI 包（`packages/ui/tui`，`1119c537d0` 加入）已在 `10bb9cbf4a`（2026-08-04，"cleanup: remove TUI package and legacy dsh entrypoints"）删除；其 README 自述只拥有交互呈现——"Agent lifecycle, persistence, and the model-facing `ask_user_question` tool remain separate composition entries"，配置面没有 preset 概念（`sessionId` 默认 `main`，单会话身份）。

## 2. 本机验证（2026-09-25）

- `dsh --profile fff --dump-config` 无 `agent-presets` 行；对照 `dsh --profile web --dump-config` 有该行（`default: standard`）。
- 新会话首轮工具目录（会话日志 `request/header`）= base 官方 agent 面 + 本项目插件工具共 37 个；缺 preset 独有工具（如官方 `standard` 的 `present`），也缺自定义 preset 里的工具（如 liangshen 的 `skill_search`/`skill_load`）。
- 系统提示为宿主默认 persona（composed tree 里 `personaPrefix: ''`），不是 preset 内 persona 行的前缀/后缀。
- 因此目录式 preset 配置（`$DSH_HOME/.agent-presets/<id>/` 与 `settings.yaml` 的 `agent-presets.default`）在本 profile 下是空配置：该 settings 命名空间没有 provider。TUI 的 `/preset` 提示「agent 预设服务不可用」是 fail-safe 正常路径（装配证据见 `../TUI/docs/DESIGN.md`）。

## 3. 落点：要改 agent 面就改 profile

- 改工具 / 提示 / 人格：`~/.dsh/profiles/<p>/cordis.patch.yml` 的用户 patch（本项目已用它覆盖 `compaction-basic.thresholdRatio`、替换会话标题 provider）。
- 需要多套组合：用多个 profile（`dsh --profile <p>`，`dsh --from-default-profile <模板>` 派生），或 `--patch` 叠加临时层。
- TUI 的 `/preset` 命令保留（宿主没挂 registry 时只提示不可用，零副作用），本项目不为其挂 preset roster。
- 配置面同理：0.1.7 起 settings 的命名空间 = **profile 插件条目 id**，写入落 profile 的 `cordis.patch.yml`（`$DSH_HOME/settings.yaml` 只作一次性导入，随后改名 `.imported`）；provider / 凭据 / 插件配置都按「条目 id」定位，细节见 `docs/host/HOST-UPGRADE-0.1.7-rc.2.md` §3.6。

## 4. 版本断层（升级前必读）

preset 机制在官方 `0.1.7-alpha.1` 被重写（commit `d1e22a7e24`，"feat(preset): declare Agent compositions in profile YAML"）：

- `dsh-v0.1.5-rc.3`（本项目当前基线）是**目录式** roster：`@deepseek-ai/dsh-agent-presets` 扫 `$DSH_HOME/.agent-presets`，默认值取自 `settings.agent-presets.default`。
- `dsh-v0.1.7-rc.2` 只剩 `agent-preset-registry` / `agent-preset` / `persona`：preset 改为 profile YAML 里的 `@deepseek-ai/dsh-agent-preset` 声明行（web-app 以 `presets/<id>.patch.yml` 分发），用户默认值是 registry 条目的 `selectedDefault`，编辑结果写回 `$DSH_HOME/profiles/<p>/cordis.patch.yml`；目录机制连同其 package 已删除（旧决策归档于官方 `.agents/notes/archived/architecture/2026-08-03-per-session-agent-presets.*`）。
- 结论不变：TUI 仍然不用 preset。仅当将来确实需要"同一 TUI 进程内不同会话用不同组合"时，才按 web-app 模式自建（挂 registry、声明 preset 行、禁用 base 的 agent 面行）；评估项见 `BACKLOG.md` #37。
- 同一断层还包含配置后端更换：`packages/settings/settings-file` 整包删除、settings 命名空间改 profile 条目 id；`agent-presets` 段不在迁移映射表内（旧段直接丢弃），对本项目无影响。

## 5. 清理记录

2026-09-25 起，本项目与部署不再保留 preset 配置：

- `Projects/dsh-toolset/`：删除 `presets/`（资产与安装说明）；`scripts/install.sh` 移除 `--preset` / `--preset-link` 选项与 preset 安装步骤，不再写 preset 目录或 settings 段。
- `~/.dsh/`（live）：删除 `.agent-presets/`；`settings.yaml` 移除 `agent-presets` 段。
- `~/fff/config/dsh/`（配置基线）：删除 `agent-presets/`；`settings.yaml` 移除 `agent-presets` 段。
