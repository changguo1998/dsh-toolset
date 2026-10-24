# 安装脚本生成的 profile 与当前 fff 的通用配置对齐（接取条目：`docs/BACKLOG.md`「安装脚本生成的 profile 与当前 fff 的通用配置对齐」）

状态：进行中（实现与验证完成，待关闭）　　开启：2026-10-24
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`scripts/install.sh` 生成的新 profile 与当前 `~/.dsh/profiles/fff` 在**非个人项**上一致：
浅色主题、goal 回合上限、模块热重载（仓库根监听 + 忽略文档）、ponytail 默认停挂；同时核对
插件挂载集合与宿主版本口径。

## 调研

- **挂载集合本来一致**：`canonical_pkgs`（33 个目录，含 TUI）= 仓库声明 `dsh.bundle` 的 33 个包
  = fff `dsh.profile.bundles` 的 33 个包 + `@deepseek-ai/dsh-base`，且顺序相同；profile 依赖
  34 条（多一条树外官方 `session-title-all-prompts-llm`）。
- **示例资产与 fff 的差异**：资产有 `permission` 预设表 / `schedule` / `invariants` / `theme: dark`；
  fff 有 `goal` 上限、`rule-engine` 规则块、标题接管、`llm-pi-ai` 私有 provider、`agent-default-model`、
  `ponytail` 停挂，且缺 `title-takeover` sentinel。个人 provider / 规则块不镜像（用户裁定只对齐通用项）。
- **`hmr.root` 的解析口径（关键）**：宿主 `boot()` 把 `ctx.baseUrl` 设为
  `dirname(<profile>/cordis.yml)`（`dsh-app-boot/lib/index.js` 的 `boot()`），`dsh-hmr` 的
  `baseDir = fileURLToPath(new URL(config.base || ".", ctx.baseUrl))`。因此：
  - 只写 `root: ['.']` → 监听 **profile 目录**，而 link: 包都在 `profile/node_modules` 下，
    默认 `ignored` 的 `**/node_modules` 会在遍历到该目录时剪枝 → 看不到仓库 `dist`；
  - 只写绝对 `root`（base 缺省）→ chokidar 传绝对路径，`ignored` 用
    `relative(profileDir, path)` 得到带 `../..` 前缀的路径，picomatch 对 `**/node_modules`
    等模式**一律不命中**（实测），等于默认忽略全失效；
  - 正确写法：`base` = 仓库绝对路径 + `root: ['.']`，此时 baseDir = 仓库，路径相对化为
    `TUI/...`，默认 `ignored` 与新增的文档忽略都生效。
- **文档是否触发重载**：`dsh-hmr` 只对 loader 已加载模块（`loadCache` 中的 `dist`）重载；
  `*.md` / `src/*.ts` 变化只发 `hmr/change`。fffdsh 的「跳过 md」是启动前重建哈希口径
  （`find src ! -name '*.md'`），与本机制不同；这里额外把 md/docs 放进 `ignored` 以减少文件事件。
- **宿主版本**：脚本与 `docs/STATUS.md` / `HOST-PACKAGES` 写 `0.2.1-rc.2`，本机 `dsh --version`
  实为 `0.2.0-rc.2`。用户裁定以文档（0.2.1）为目标版本，本次不动版本号，只记录需升级 dsh。

## 决策

1. 通用项写进 `profiles/example/cordis.patch.yml`（install.sh 复制该资产）：`theme: light`、
   `goal.defaultMaxGoalRounds: 999`、`ponytail disabled: true`。
2. `hmr` 不写在资产里（root 依赖安装机器的仓库路径），由 install.sh 生成 begin/end 标记的
   生成区：`base: '<repo_root>'`、`root: ['.']`、`ignored` 重述默认四项 + `**/*.md` + `**/docs/**`。
3. 生成区维护规则：仅首次写入资产 / `--sync` / `--force` 时维护；`--force` 时若差异仅在生成区
   则视为内容未变（不备份、不覆盖）；检测到标记之外的手写 `- id: hmr` 时不写并提示。

## 计划改动文件清单

- `scripts/install.sh`（hmr 生成区：渲染 / 幂等更新 / 手写检测 / `--force` 等价比较）
- `profiles/example/cordis.patch.yml`（通用项三处 + 模块热重载说明）
- `profiles/README.md`（示例条目 id 与 hmr 生成区口径）
- `scripts/test-install.sh`（生成区内容、幂等、手写保留的断言）
- 本文件
- `docs/BACKLOG.md`（条目登记与关闭）
- `docs/STATUS.md`（用户择时更新，流程内不改）

## 验证

- `sh scripts/test-install.sh`：98 项全过（含 5 条生成区内容断言 + 手写 hmr 保留断言）。
- 临时 `DSH_HOME` 跑 `install.sh --skip-dsh --skip-build --skip-verify --plugins TUI`，生成 patch
  可被 js-yaml 解析（11 个顶层条目）；`hmr` 条目为
  `{"base":"/home/guochang/Projects/dsh-toolset","root":["."],"ignored":[...,"**/*.md","**/docs/**"]}`。
- picomatch 实测：相对仓库路径下 `TUI/node_modules`、`README.md`、`TUI/docs/DESIGN.md`、
  `.git` 命中忽略，`TUI/dist/index.js` 仍被监听。

## 未做 / 后续

- 当前 fff 的 patch 未同步（本会话沙箱对 `~/.dsh` 只读）：需在宿主侧跑
  `scripts/install.sh --sync`（或手工加同样的 hmr 生成区）才生效。
- 示例资产的 `permission` 预设表 / `schedule` / `invariants` 与 fff 不同，属「另行决定」项，本次未动。
- fff 的 `rule-engine` 规则块、`llm-pi-ai` provider、`agent-default-model`、标题路由均为个人配置，
  不镜像；宿主版本按文档口径留给升级 dsh。
