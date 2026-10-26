# 宿主升级复核：dsh 0.2.1-rc.3 相对 0.2.1-rc.2 的接口变更

状态：完成　　开启：2026-10-27
接取条目：`docs/BACKLOG.md`「宿主升级复核：dsh 0.2.1-rc.3 相对 rc.2 的接口变更」。
本文件是本任务唯一的过程记录与文档变更落点。

## 目标

1. 逐项列出 `dsh-v0.2.1-rc.2..dsh-v0.2.1-rc.3` 的接口面变更（ctx 服务 / 事件 / patch DSL /
   插件加载契约 / 配置 schema / 工具面）。
2. 对本仓 34 个包判定影响（无影响 / 需适配 / 阻断）。
3. 需要时在 `docs/host/` 增补升级记录，并给出后续适配条目。

## 计划改动文件清单

调研阶段只读，不改任何源码。

- `docs/BACKLOG.md`：本条条目（已加）。
- `docs/implementation/2026-10-27-host-upgrade-0.2.1-rc.3.md`：本文件（过程记录）。
- 若发现需适配：另立条目，不在本任务内改代码。
- 收尾：`docs/host/` 视需要新增 `HOST-UPGRADE-0.2.1-rc.3.md`；`docs/host/DSH-CTX-API.md` 按结论增补。

## 调研方法

- 在 `/home/guochang/GithubRepos/deepseek-harness` 对比两个 tag：`git diff --stat` 先看面，
  再按目录取关键文件。
- 关注面：`packages/*/src` 的 ctx 服务注册与接口、事件类型定义（runtime-types）、
  patch/组合（dsh-app-boot / cordis-plugin-include）、工具与审批契约、profile 启动流程。
- 对照本仓 `docs/host/DSH-CTX-API.md`（rc.2 基线）逐条核对。

## 调研记录

对比方式：`git diff dsh-v0.2.1-rc.2..dsh-v0.2.1-rc.3`（6 个提交，640 文件，+5682 / −1021）。
按目录归类后，真正改源码的只有 `packages/llm`（27 文件）、`packages/extensions`
（3 文件，均为生成目录）、`packages/api`（1 文件，注释）、`apps/web` 与 `packages/client`
（web UI）；其余包的 `+/-` 相等 = 只有 `package.json` 版本号。

### 1. 版本面

- 全仓包版本 `0.2.1-rc.2` → `0.2.1-rc.3`（含 `@deepseek-ai/dsh` 自身与全部 `dsh-*`）。
- `packages/bundle/base/package.json` 只有版本号变化：**dsh-base 的 patch 未变**。

### 2. 宿主接口面（ctx 服务 / 事件 / patch DSL / 启动契约 / 配置 schema）

- `packages/core`、`packages/host`、`packages/session`、`packages/boot`、`packages/interaction`、
  `packages/compaction`：**非 `package.json` 变更 0 个**。
- 全量 diff 里新增的 `ctx.provide(...)` 全部落在 web 客户端（`pluginNavigation`、
  `productAnalytics`、`uiWorkspace`、`conversation`、`locale`、`sessions`），且多在测试夹具里；
  宿主侧（进程内插件面）无新增服务。
- 事件名、patch DSL（`- id:` / `- insert:`）、profile 启动流程、`--dump-config` 行为无变更。

### 3. LLM 路由：改跟官方 `/models` 列表（唯一有行为含义的变更）

- `llm-deepseek`（协议层）：新增 `isBuiltInCatalog()`、`listing-config.ts`，新模块
  `listed-catalog` / `listing-cache` / `listing`，模型目录改为按官方 `/models` 拉取并缓存。
- 新增配置键（可选，有默认值）：`modelsTimeoutMs`（默认 5000）、`modelsMaxAgeMs`（默认 600000）。
- `llm-deepseek-api-key`：`Config` 增加上述 listing 字段；仅当 `models` 等于内置目录且端点
  是官方 origin 时才跟随列表（`listing?` 字段）。
- `llm-deepseek-account`：重构到共享 listing（配置面收敛）。
- 其它 provider（`llm-pi-ai` 等）不在本次变更内。

### 4. 其它（与插件面无关）

- `packages/bundle/web-app/cordis.patch.yml`：新增一行 `entry-customization`
  （`@deepseek-ai/dsh-client-ui-entry-customization`），web 专用。
- `packages/client/*`：web UI 导航入口定制、菜单图标、埋点（182 文件）。
- `packages/extensions/*`：`tool-cordis` 的 `api-catalog.ts` 与 `cordis-client-runner` 的
  `slot-catalog.ts` 为生成物（新增 `AnalyticsPreset` 等类型、`ProductEventMap` 字段）。
- `apps/web`、`snapshots/`、`tsconfig*`、`vitest.config.ts`、`pnpm-lock.yaml`。

## 真机生效验证（2026-10-27）

用户执行全局安装后实测：

- `dsh --version` = `0.2.1-rc.3`；安装树内全部 `dsh-*` 均为 rc.3（其余非 rc.3 的是
  `cordis` / `schemastery` 等第三方依赖，版本号本就独立）。
- 安装树计数：**306 个包，其中 `dsh-*` 295**（rc.2 为 306 / 294；新增 web 专用
  `dsh-client-ui-entry-customization`）。
- rc.3 新增实现在安装树可见：`dsh-llm-deepseek/lib/index.js` 与
  `dsh-llm-deepseek-api-key/lib/index.js` 均含 listing 新键 `modelsMaxAgeMs`。
- 健康检查：`dsh --profile fff --dump-config` 退出 0、832 行、**stderr 为空**
  （无 patch 告警、无激活失败）。
- `docs/host/HOST-PACKAGES.md` 的包计数已按 rc.3 实测更新；§1 的「已挂载 100 个」仍是
  2026-10-21 rc.2 按 §0 判定细则的结果，rc.3 升级后未按细则复算（已在文中标注）。

## 结论与影响判定

| 面 | rc.3 变化 | 对本仓 34 个包的影响 |
| --- | --- | --- |
| ctx 服务 / 事件 / patch DSL / 启动契约 | 无 | 无（不需要改代码） |
| dsh-base bundle patch | 无（仅版本号） | 无 |
| 配置 schema（我们挂载的官方行） | 无 | 无 |
| LLM 官方路由模型目录 | 改为跟 `/models` 列表（新可选键） | 仅行为面：模型选择器里 DeepSeek 官方路由的模型集合由服务端决定；若 `agent-default-model` 钉了不在列表里的模型，需要跟着改 |
| web 客户端（导航 / 图标 / 埋点） | 大变 | 无（本仓不挂 web 栈） |
| 生成物目录（api-catalog / slot-catalog） | 跟随类型变化 | 无（`cordis` 工具面自用，本仓不消费） |

**结论：rc.3 没有破坏性接口变更**，本仓无代码适配项；需要做的是**版本口径同步**（另立条目做）：

1. `scripts/install.sh` 默认版本与 `--help` 文案：`0.2.1-rc.2` → `0.2.1-rc.3`。
2. `scripts/test-install.sh` 的假 `dsh` 版本串与版本检查断言（4 处 `0.2.1-rc.2`）。
3. 宿主联调 smoke 的版本门槛（4 个包）：`goal-contract` / `metric-loop` /
   `output-compress` / `security-guard` 的 `REQUIRED_VERSION`。
4. 文档基线：`docs/host/HOST-PACKAGES.md`、`docs/ARCHITECTURE-REUSE.md`、
   `docs/host/DSH-CTX-API.md` 的基线标注；并按惯例新增 `docs/host/HOST-UPGRADE-0.2.1-rc.3.md`。
5. 用户 profile：`~/.dsh/profiles/fff/package.json` 现无官方树外依赖（pin 无处可改）；
   `llm-deepseek` 行由 dsh-base 提供，升级宿主即生效。

## 收尾

- 提交：本次（口径同步 + 宿主面文档 + 追踪文档）。
- 真机：rc.3 已生效并通过 `--dump-config` 健康检查；本仓无代码适配项。
