# HOST-UPGRADE：0.2.1-rc.2 → 0.2.1-rc.3 对照记录

> 职责：记录 `dsh-v0.2.1-rc.2 → dsh-v0.2.1-rc.3` 的接口面增量与本仓影响判定
> 不负责：包清单（见 `HOST-PACKAGES.md`）、ctx 接口逐条研读（见 `DSH-CTX-API.md`）
> 过期条件：出现下一版宿主（rc.4 / 0.2.2）时由新对照文档接替

## 0. 版本与来源

- 对比源：官方 clone `~/GithubRepos/deepseek-harness`，tag `dsh-v0.2.1-rc.2..dsh-v0.2.1-rc.3`
  （6 个提交，640 文件，+5682 / −1021；头提交 `1f81c047fc`「Merge PR #6999 release-dsh-0.2.1-rc.3」）。
- 版本号：全仓包 `0.2.1-rc.2` → `0.2.1-rc.3`（含 `@deepseek-ai/dsh` 自身）。
- 本机状态：**安装树仍是 rc.2**；本次只做口径对齐与接口复核，未升级本机、未重装 profile。

## 1. 增量总览（按面）

| 面 | 变更 | 影响本仓 |
| --- | --- | --- |
| 进程内 ctx 服务 / 事件 / patch DSL / 启动契约 | 无（`packages/core` / `host` / `session` / `boot` / `interaction` / `compaction` 非 manifest 变更 0 个；新增 `ctx.provide` 全在 web 客户端与测试夹具） | 无 |
| `bundle/base`（dsh-base）patch | 无（仅版本号） | 无 |
| 官方插件配置 schema（我们挂载的行） | 无 | 无 |
| LLM 路由 | `llm-deepseek` 改为跟随官方 `/models` 列表；`llm-deepseek-api-key` / `-account` 同步 | 仅行为面（模型集合由服务端决定） |
| web 客户端 | 导航入口定制（新包 `@deepseek-ai/dsh-client-ui-entry-customization`，`web-app` patch 新增 `entry-customization` 行）、菜单图标、埋点 | 无（本仓不挂 web 栈） |
| 生成物 | `tool-cordis` 的 `api-catalog.ts`、`cordis-client-runner` 的 `slot-catalog.ts` | 无 |
| 工程配置 | `tsconfig*.json`、`vitest.config.ts`、`pnpm-lock.yaml`、`snapshots/web` | 无 |

包目录数：342 → 343（唯一新增是 web 专用的 `dsh-client-ui-entry-customization`）。

## 2. LLM 路由细节（唯一有行为含义的变更）

- `packages/llm/llm-deepseek`：新增 `isBuiltInCatalog()`、`listing-config.ts`、`listed-catalog.ts`、
  `listing-cache.ts`、`listing.ts`；模型目录改为按官方 `/models` 拉取并缓存。
- 新增可选配置键（有默认值）：`modelsTimeoutMs`（默认 5000，亦为首次使用等待上限）、
  `modelsMaxAgeMs`（默认 600000，过期后下次访问后台刷新；失败同样按该间隔重试）。
- `llm-deepseek-api-key`：`Config` 增加 listing 字段；仅当 `models` 等于内置目录且端点为官方
  origin 时 `ResolvedDeepSeekOptions.listing` 才存在（自定义 `models` 或自建端点不跟随列表）。
- `llm-deepseek-account`：配置面重构到共享 listing。
- 其它 provider（`llm-pi-ai` 等）无关。

对本仓的影响：`fff` 的 `llm-deepseek` 行来自 dsh-base（`id: llm-deepseek` →
`@deepseek-ai/dsh-llm-deepseek-api-key`），升级宿主即生效；TUI 的模型选择器读宿主目录，
**不需要改代码**，但可选的模型集合会随服务端变化。若 `agent-default-model` 钉了列表里不存在的
模型，升级后需要跟着改。

## 3. 本仓已做的口径对齐（2026-10-27）

- `scripts/install.sh`：`dsh_version_default` 与 `--help` / 头注释 → `0.2.1-rc.3`。
- `scripts/test-install.sh`：假 `dsh` 版本串与版本检查断言（含树外官方插件 pin 用例）→ rc.3。
- 宿主联调 smoke 的 `REQUIRED_VERSION`：`goal-contract` / `metric-loop` / `output-compress` /
  `security-guard` → rc.3（同名 README 的「需 dsh …」同步）。
- `TUI/docs/COMMANDS.md`：命令清单标注改为 rc.3（`bundle/base` patch 未变，命令集合不变）。
- `docs/STATUS.md` 基线行、`docs/ARCHITECTURE-REUSE.md` 基线口径、`docs/host/HOST-PACKAGES.md`
  标题与来源说明、`docs/host/DSH-CTX-API.md` 的 rc.3 复核注记。

## 4. 未做 / 待办

- 本机 `dsh` 仍为 rc.2：升级宿主（全局安装 + 重装 profile）后需复测安装树包计数与 fff 活跃
  挂载行数，并重生成 `HOST-PACKAGES.md` 的计数部分。
- 本仓代码无需适配（接口面无变更）。

## 5. 依据

- `git diff dsh-v0.2.1-rc.2..dsh-v0.2.1-rc.3`（含 `--name-status` 与逐包非 manifest 过滤）
- `packages/llm/llm-deepseek/src/{config,listing-config,listed-catalog}.ts`、
  `packages/llm/llm-deepseek-api-key/src/{config,index}.ts`
- `packages/bundle/base/package.json`、`packages/bundle/web-app/cordis.patch.yml`
- 过程记录：`docs/archived/2026-10-27-host-upgrade-0.2.1-rc.3.md`
