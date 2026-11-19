# HOST-UPGRADE: 0.2.2-rc.3 → 0.2.2-rc.5 对照记录

> 职责: 记录 `dsh-v0.2.2-rc.3 → dsh-v0.2.2-rc.5` 的接口面增量与本仓影响判定
> 不负责: 包清单全量 (见 `HOST-PACKAGES.md`)、ctx 接口逐条研读 (见 `DSH-CTX-API.md`)
> 过期条件: 出现下一版宿主 (0.2.2-rc.5 以后、或 0.2.3 线 tag) 时由新对照文档接替; `HOST-PACKAGES.md` 与 §5「待补」在实装升级后刷新

## 0. 版本与来源

- 对比源: 官方 clone `~/GithubRepos/deepseek-harness`, tag `dsh-v0.2.2-rc.3..dsh-v0.2.2-rc.5`。核对时间 2026-11-19。
- tag 与提交: `dsh-v0.2.2-rc.4` = `3f321d32bf` (2026-11-17 21:30 +0800)、`dsh-v0.2.2-rc.5` = `9c2670d3bc` (2026-11-18 17:45 +0800)。
- 发布通道: npm dist-tags 在线查询本次被沙箱拦截未验证 (rc.3 对照口径为 `latest = 0.2.2-rc.1` / `next = 0.2.2-rc.3`); 以源码 tag 为准。
- 本机状态: 安装树 `@deepseek-ai/dsh` 版本 `0.2.2-rc.3`（2026-11-16 实装; 本任务编排用户执行 install.sh 升 rc.5, 实测数字见 §5）。
- 增量规模: rc.3 → rc.5 提交集中于 web / llm-deepseek / liveshare 三个域, 其余为全仓版本号 bump。
- 升级指南: rc.4 / rc.5 各新增一个 `docs/upgrade-guide/` 目录——`v0.2.2-rc.4/web-search-deepseek-model-default` (web 搜索默认模型路由) 与 `v0.2.2-rc.3/deepseek-refusal-code` (DeepSeek 拒绝响应错误码)。

## 1. 增量总览 (按面)

| 面 | 变更 | 影响本仓 |
| --- | --- | --- |
| 包 | **零增删** (383 = 383, 含 package.json 的目录全量对比一致) | 无 |
| 事件 | 无新增词汇 | 无 |
| 工具面 | 无新增 / 删除 / 改名 (rc.3 的 `wait_agent` / `office_*` / `user_terminal_*` 集在 rc.4 / rc.5 不变) | 无 |
| 服务面 | `ctx.web` 选择语义变更: `WebSearchRequest` 新增可选 `llmProvider` 字段; 未配置 id 时按模型请求路由选 provider (DeepSeek 模型路由走 legacy Messages 搜索 `deepseek-official`, 其余走 `deepseek-search-api`) | 无 (本仓不消费 `ctx.web` 搜索路径) |
| bundle 默认值 | base `web` 行删除 `searchProvider: deepseek-search-api` 固定配置 (改为运行时路由选择) | 无 (profile 未覆盖该配置) |
| llm 适配器 | `llm-deepseek` 内容安全审查 `safetyCheck` 开关 (默认始终请求); refusal 终止先报计费 usage 再抛 `CONTENT_REFUSED` | 无 (refusal 前仍上报 usage, 与本仓 usage 口径兼容) |
| web 搜索 | `web_search_result` snippet 优先取自带 `snippet`, 无则回落 citation excerpt; provider 描述文案更新 | 无 |
| 客户端 / web | `ui-settings-web-search` 设置卡文案; `tool-cordis` api-catalog 生成物随 web 语义刷新 | 无 (TUI 走自有渲染层) |
| liveshare | 实验包 (Electron Host tunnel 启动方式与 owner credential 时钟) | 无 (本仓不挂实验包) |

## 2. 本仓影响判定

- 本仓 41 包（TUI + 40 插件）**无代码改动需求**:
  - web 面: 本仓不调用 `ctx.web.search / fetch`, 无模型面 `web_search` 工具自实现; `profiles/example/cordis.patch.yml` 未覆盖 `searchProvider` 配置 → base 删除该行无配置冲突。
  - llm-deepseek 面: safety check / refusal 是宿主端 LLM 适配器行为; refusal 时先报 usage 再抛错误, 与本仓「usage → 权威信号」口径 (`docs/archived/2026-10-02-task-engine-usage-metric.md`) 兼容。
  - 事件面 / 工具面 / 子代理 / 会话 / 投影: rc.4 / rc.5 无变更 (全仓版本号 bump)。
- 影响清单 (按处理优先级): **空**。无需改动项。

## 3. 无影响面 (逐项已核)

全部 41 包 (TUI + 40 插件): 不消费本次变更的接口面 (web 搜索路由、llm 安全审查为宿主侧行为, 本仓无消费点)。

## 4. 本仓抬版内容 (2026-11-19)

- `scripts/install.sh`: 默认版本 `0.2.2-rc.3` → `0.2.2-rc.5` (3 处: 头注释 / `dsh_version_default` / `--help` 文案)。
- 根 `package.json` devDep `@deepseek-ai/dsh` → `0.2.2-rc.5`。
- `tool-surface/package.json` 依赖 `@deepseek-ai/dsh-tools` → `0.2.2-rc.5` (+ README 说明)。
- 四个 smoke: `metric-loop` / `goal-contract` / `output-compress` / `security-guard` 的 `REQUIRED_VERSION` 与头部注释 → `0.2.2-rc.5`。
- README 指针与文档: 根 `README.md` / `README.zh.md` 的对照指针 → 本文; `e2e/README.md` / `goal-contract/README.md` / `metric-loop/README.md` 的 smoke 宿主要求 → `0.2.2-rc.5`; `docs/BACKLOG.md` 头部基线声明 → `0.2.2-rc.5`。
- pnpm-lock.yaml (根 / tool-surface): 待用户实装安装后重生成 (宿主导, 方法见 §5 注记)。

## 5. 安装树实测（2026-11-19, 用户执行 install.sh 实装后补写）

> 前置: rc.3 → rc.5 无代码改动, 不设升级前置; 直接可装。2026-11-19 用户以 `--force` 重装 fff / fff-test 并回填备份配置完成实装。

1. 全局 `dsh --version` = `0.2.2-rc.5`。
2. 安装树数字与 `--dump-config` 实测（与 rc.3 口径逐项对照）:
   - 安装树 `@deepseek-ai/dsh/node_modules/@deepseek-ai` 下 **337** 个包（rc.3 亦 337; rc.5 包零增删, 与源码 tag 口径一致）。
   - `dsh --profile fff --dump-config`: **875** 行、**152** 个 `- id:` 行——官方（`@deepseek-ai/*`）**110** 条（其中 `dsh-*` 109 + `cordis-plugin-timer` 1）、本仓（`@dsh-toolset/*`）**42** 条; 无条件 `disabled: true` **9** 条（tool-plugin-manager / hmr / session-title-llm / deepseek-account / fs-observation-policy / plan-mode / tool-executor-ptc / llm-deepseek-account / session-title-all-prompts-llm; 与 rc.3 相比多 `hmr` 一条——install.sh 生成的 hmr-root 区现为无条件 disabled）、条件式 `disabled: !!js` **8** 条 → 官方活跃项 **101** 条（rc.3 为 102）。
   - 组合树健康检查: 官方新老行与本仓 42 包全部在位; 唯一遗留告警为 fff / fff-test patch 里的 `ponytail` 陈旧条目（`patch: entry "ponytail" not found`, 用户按 plan 预留于 user profile 侧清理, 与本仓无关）。
3. 类型面: 根与 tool-surface 锁文件已重生成到 rc.5 并物化, `pnpm run check` 全绿（**41 包**, 含 tool-surface 对 `dsh-tools@0.2.2-rc.5` 的类型核验）; 离线 `pnpm install` 均 up-to-date。
4. `HOST-PACKAGES.md` 头部注记已加 rc.5 增量行（安装树计数待下次升宿主时全面刷新）。
5. 真机验收: 无代码面变更; 四 smoke 的 `REQUIRED_VERSION = 0.2.2-rc.5` 版本门禁已抬高, 待用户跑 smoke 确认。

## 6. 依据

- `git -C ~/GithubRepos/deepseek-harness log --oneline --no-merges dsh-v0.2.2-rc.3..dsh-v0.2.2-rc.5` 取提交清单; `git log -1 --format='%ci %d' <tag>` 取 tag 时间。
- `git ls-tree -r --name-only <tag> | grep package.json` 全量对比 (383 = 383, 零增删)。
- `git diff --name-only <rc.3> <rc.5>` 过滤 package.json / 文档后隔离实质代码变更 (web / llm-deepseek / liveshare / tool-cordis / client-ui-web-search)。
- 服务面: `git diff <rc.3> <rc.5> -- packages/extensions/tool-cordis/src/api-catalog.ts` 反映 `ctx.web` 描述变化; `packages/web/web-search-deepseek/src/{provider,types}.ts`。
- 追踪文档: `docs/implementation/2026-11-19-host-update-check.md` (关闭后归档)。
