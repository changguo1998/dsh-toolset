# 安装脚本双 profile：主走快照安装，伴随 `<名>-test` 走软链接

状态：实现　　开启：2026-10-27
接取条目：`docs/BACKLOG.md`「安装脚本双 profile：主 profile 走快照安装（`file:`），伴随 `<名>-test` 走软链接」。
本文件是本任务唯一的过程记录与文档变更落点。

## 目标

1. `scripts/install.sh` 生成的**主 profile**（默认 `fff`）改为正常安装：依赖值用 `file:`，pnpm 把插件按包内容落成 `node_modules` 下的真实副本（快照），此后改仓库源码不影响已在跑的会话。
2. 同一次运行额外生成**伴随 profile**（默认 `<主名>-test`，即 `fff-test`），依赖值用 `link:`，供新窗口做实时开发。
3. 两个 profile 除依赖协议外完全一致：`dsh.profile.bundles`、`cordis.patch.yml`、`pnpm-workspace.yaml`、其它顶层字段逐字节相同。

## 调研

- 现状：`install.sh:457-488` 的 `render_manifest` 与 `:501-558` 的 `--sync` 合并逻辑都把依赖值写成 `link:${repo_root}/${dir}`；`pnpm install` 在 profile 里建符号链接（实测 `~/.dsh/profiles/fff/node_modules/@dsh-toolset/tui` 是指向 `Projects/dsh-toolset/TUI` 的 symlink），故改仓库 `dist/` 立即影响运行中的会话。
- `file:` 可行性（实测，pnpm 11.7 + `nodeLinker: hoisted`）：依赖落成 `node_modules/@dsh-toolset/<包>` 下的**真实目录**，内容按包 `files` 字段取（`dist` / `bin` / `cordis.patch.yml` / `README.md` / `package.json` / `LICENSE`）；仓库 `dist` 改动后不重跑 install 不生效；重跑 `pnpm install` 会重新打包取新内容。
- 内部 `link:` 依赖（`code-map` → `ast-tools`、`md-map` → `md-logic`）：`file:` 安装后 pnpm 提示「non-existent directory」不建链，但两者同时是 profile 的直接依赖、`hoisted` 下落在顶层，`require.resolve` 从插件 `dist` 向上能找到（实测）。与 `link:` 形态的失败面一致（未同时选中依赖方时同样解析不到）。
- 风险：主 profile 由 `link:` 切到 `file:` 后，改代码必须重跑 `scripts/install.sh --sync`（或 `cd <profile> && pnpm install`）才生效；文档里「改插件后 npm run build 即生效」的口径要改。

## 计划改动文件清单

- `scripts/install.sh`（主改动）：新增 `--mode copy|link`、`--profile-test <名字>`、`--no-test-profile`；依赖值按模式生成；`--sync` 合并判据同时认 `link:` 与 `file:`；主 profile 配好后按主 profile 产物生成伴随 profile（同名资产副本 + `link:` 清单）并 `pnpm install`；收尾自检与结果输出覆盖两个 profile。
- `scripts/test-install.sh`：新增伴随 profile 的断言（两份 profile 的 assets 逐字节相同、bundle 清单相同、依赖键集相同、协议不同；`--no-test-profile` / `--profile-test` / `--mode link` 生效）。
- `docs/BACKLOG.md`：本次条目（已加）。
- `AGENTS.md`「构建 → 部署到 profile（本地迭代）」：改为主 profile 快照 + `-test` 软链接的双口径。
- `README.md` / `README.zh.md`（挂载示例段）、`TUI/README.md`（挂载示例段）、`profiles/README.md`（资产说明与手动安装步骤）：同步双 profile 口径。

## 实现要点

- `--profile fff`（不带其它参数）即生成两个 profile：主 `fff`（`file:` 快照）+ 伴随 `fff-test`（`link:`）。新增开关 `--mode copy|link`（默认 copy）、`--profile-test <名>`、`--no-test-profile`。
- 依赖值按 `dep_proto`（`file` / `link`）生成（`render_manifest` 与 `--sync` 合并路径同源）；`--sync` 的本仓库条目判据同时认 `link:` 与 `file:`，故协议可来回切换且不留旧条目。
- 主 profile 装完后的三件补强（实测驱动）：
  1. **刷新**：pnpm 对 `file:` 目录依赖不跟踪内容变化（`Already up to date` 直接跳过，删包目录也不重建），故 copy 模式安装前删 `node_modules/.modules.yaml` 与 `.pnpm-workspace-state-v1.json` 逼其重建。
  2. **断开硬链接**：pnpm 把 `file:` 目录依赖的文件**硬链接**进 profile（实测 inode 与仓库文件相同、`tsc` 原地写会串味），故 `break_hardlinks()` 逐包 `cp -R` 到临时目录再整体替换（仅当存在 `-links +1` 的文件才做，幂等）。
  3. **形态自检**：copy 模式报警符号链接或仍共享 inode；link 模式报警真实目录。
- 伴随 profile 是派生品：清单按主 profile 最终 `package.json` 深拷贝（`name` 换名、指向本仓库的依赖值改 `link:`，其余字段与依赖原样），`cordis.patch.yml` / `pnpm-workspace.yaml` 直接复制主 profile 成品（`cmp` 相同则跳过），随后 `pnpm install` 并逐个校验是符号链接。主清单缺失/坏掉时只告警跳过伴随 profile，不 die。
- 收尾工作：`verify_profile()` 对两个 profile 各代跑一次 `--dump-config`；结果输出列出两个 profile 与各自生效方式。

## 测试与证据

- `sh -n scripts/install.sh` 语法通过。
- `sh scripts/test-install.sh`：**117 项通过**（原 98 项 + 新增 19 项）。新增覆盖：默认生成伴随 profile、主 `file:` / 伴随 `link:`、两 profile 依赖键集与 `dsh.profile.bundles` 一致、`cordis.patch.yml` 与 `pnpm-workspace.yaml` 逐字节相同、重跑不产生新备份、`--no-test-profile`、`--profile-test` 自定义名、`--mode link`、`--sync` 把 `link:` 切成 `file:`、非法 `--mode` 在写盘前被拒。
- 真机（临时 `DSH_HOME=tmp/e2e/home`，真 pnpm 11.7，`--plugins "clock-base TUI ast-tools code-map md-logic md-map"`）：
  - 主 profile `node_modules/@dsh-toolset/*` 为真实目录、文件 inode 独立（`-links 1`）；伴随 profile 为符号链接指向仓库。
  - 仓库 `ast-tools/dist/src/index.js` 追加一行后：主 profile 不变（0 命中）、伴随 profile 立即命中（1 命中），验证隔离与实时性。
  - 重跑 `--sync` 后主 profile 拿到仓库新内容（刷新路径生效），硬链接数仍为 1。
  - 两 profile 的 `cordis.patch.yml` / `pnpm-workspace.yaml` `cmp` 一致。
- 文档同步：`AGENTS.md`（构建 → 部署段改双 profile 表格）、`README.md` / `README.zh.md`（安装与手工挂载段）、`TUI/README.md`（bundle 挂载段）、`profiles/README.md`（用法与手工步骤）。
- 未做：真实 `~/.dsh/profiles/fff` 未重装（正在跑的会话在用），由用户择时执行 `sh scripts/install.sh --sync` 生效；`format` 与最终 diff 自查见下一次提交前。

## 收尾

（待关闭时填写。）
