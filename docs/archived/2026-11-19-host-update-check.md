# 检查宿主更新（接取条目：docs/BACKLOG.md「检查宿主更新」）

> 2026-11-19 开工。本文件是本次任务唯一的追踪文档与文档改动位置; 计划外的文件不改。

## 计划改动文件清单

- `docs/BACKLOG.md`: 登记条目并标记「进行中」(已完成)
- `docs/implementation/2026-11-19-host-update-check.md`: 本追踪文档
- 检查产物 (`docs/host/HOST-UPGRADE-*.md` 对照 / 新版本增量文档): 待检查后定
- `docs/host/HOST-PACKAGES.md` / `docs/host/DSH-CTX-API.md` 等宿主面知识: 若升级则回写 (关闭后)

## 现状

- 本仓当前实装 `dsh` 0.2.2-rc.3 (2026-11-16 升级, 见 `docs/archived/2026-11-16-start-activation-upgrade.md` 与 `docs/host/HOST-UPGRADE-0.2.2-rc.3.md`)。
- 用户 2026-11-19 提示: 宿主已发布新版本。

## 检查结果（2026-11-19, 源码 clone tag 口径）

### 新版本确认

- 本地源码 clone (`~/GithubRepos/deepseek-harness`) 已有 tag `dsh-v0.2.2-rc.4`（2026-11-17 21:30 +0800）与 `dsh-v0.2.2-rc.5`（2026-11-18 17:45 +0800）。
- npm dist-tags 在线查询被沙箱拒绝（缓存目录只读且不可升级权限）, 以源码 tag 为依据。

### 包目录（源码 383 个含 package.json 的目录）

- `dsh-v0.2.2-rc.3` 与 `dsh-v0.2.2-rc.5` 的 packages 递归清单**完全一致（零增删）**（对比临时文件 `tmp/hostcheck/pkgs-full.*`）。

### 提交范围（rc.3..rc.5, 非合并提交）

- `feat(llm-deepseek)`: DeepSeek 内容安全审查 `safetyCheck` 开关（默认始终请求）;
- `fix(llm-deepseek)`: refusal 不请求 safety review 的处理（`CONTENT_REFUSED` 错误 + 计费 usage 先报再抛）;
- `feat(web-search-deepseek 等)`: 搜索 provider 按模型请求路由选择（DeepSeek 模型路由走 legacy Messages 搜索 `deepseek-official`, 其余路由走 `deepseek-search-api`）; base 组合中 `web` 行的 `searchProvider: deepseek-search-api` 配置删除;
- `web-search-deepseek` snippet 语义: 优先用 `web_search_result` 自带 `snippet`, 无则回落 citation excerpt;
- `experimental/liveshare`: 仅实验包（Electron Host tunnel 启动方式与 owner credential 时钟）;
- `tool-cordis` api-catalog: 服务面描述文本随 web 语义更新（生成物, 无行为变更）;
- 客户端 `ui-settings-web-search`: Web UI 设置卡文案。
- 其余全为各包 package.json 版本号 bump。

### 接口面判定（工具面 / 事件 / 服务面）

- 工具面: 无新增 / 删除 / 改名（对比 rc.3 的 `wait_agent` / `office_*` / `user_terminal_*` 等, rc.4 / rc.5 不携带新工具）。
- 事件面: 无新增词汇。
- 服务面: `ctx.web` 的**选择语义**变更（`WebSearchRequest` 新增可选 `llmProvider` 字段; 未配置时按模型请求路由选 provider）, 属 host 侧行为; `ctx.web` 的既有接口 (registerSearchProvider / registerFetchProvider / search / fetch) 不变。
- 其余本仓消费面（`sessions` / `subagents` / `tools` / `goal` / `workflow` / `approval` / `permissionPresets` / `fs` / `sandbox` 等）: 仅有 package.json 版本 bump, 无接口变更。

### 本仓影响判定

- 本仓 41 包（TUI + 40 插件）**无代码依赖上述两条变更路径**:
  - web 面: 本仓不调用 `ctx.web.search/fetch`, 也没有模型面 `web_search` 工具的自实现; profile 未覆盖 `searchProvider` 配置（`profiles/example/cordis.patch.yml` 只注释提及 web-search-deepseek 的账号路由, 无该配置行）→ 删除 base 的 `searchProvider` 对 fff profile 无配置冲突;
  - llm-deepseek 面: safety check / refusal 是 host 端 LLM 适配器行为, 本仓 task-engine 等消费 `tokenUsage` 投影与 `stopReason` 属既有口径, rc.5 在 refusal 时先报 usage 再抛错误, 与本仓「usage → 权威信号」口径（`docs/archived/2026-10-02-task-engine-usage-metric.md`）兼容（refusal 前仍上报 usage）。
- 结论: **rc.3 → rc.5 对本仓无代码改动需求**。是否升级为纯宿主版本推进（npm 侧 `latest` 通道是否已到 rc.5 需安装时确认, 在线查询本次被沙箱拦截未验证）。

## 进度

- [x] 登记条目 (BACKLOG「进行中」)
- [x] 确认新版本号（rc.4 / rc.5, 源码 tag 口径）
- [x] 增量面对照（rc.3..rc.5: 包零增删, 接口面无结构性变更）
- [x] 本仓影响判定（无代码改动需求）
- [x] 用户裁定升级 rc.5 (2026-11-19, 选项 1)
- [x] 抬版执行: install.sh / 根 package.json / tool-surface / 四个 smoke / README 双侧 / BACKLOG 基线 / HOST-PACKAGES 注记 / 新建 HOST-UPGRADE-0.2.2-rc.5.md
- [x] 验证: install.sh 语法 OK, check:docs 通过 (125 篇 0 错), 全仓 check 41 包全绿
- [x] 锁文件重生成到 rc.5 (根 + tool-surface; 物化完成, 离线 install 均 up-to-date)
- [x] peer 警告定位与处置 (官方 vendored 组合既有状态, 非 rc.5 引入, 见「偏差」)
- [x] 用户执行 install.sh --force 实装 rc.5 (2026-11-19) 并回填备份配置; 补 HOST-UPGRADE-0.2.2-rc.5.md §5 安装树实测
- [x] 关闭条目 / 归档追踪文档

## 偏差

- npm dist-tags 在线查询被沙箱拦截 (缓存目录只读), 以源码 clone tag 为准 (rc.4 / rc.5 均在本地, 已确认存在)。
- 锁文件 (根 / tool-surface) 随本任务重生成到 rc.5 (用户已实装 rc.5 后执行; 根用 `pnpm install --lockfile-only` + 物化, tool-surface 用 `--no-frozen-lockfile --ignore-workspace`)。
- peer 警告 (`@deepseek-ai/cordis-plugin-group@1.0.5` / `@opentelemetry/api@1.10.0` 等): 首次 install 时的 pnpm 提示, 根因是**官方 vendored 组合的既有状态** (rc.3 锁文件即同款: cordis-plugin-group 1.0.5 的 peer 声明 `cordis ~4.0.5` / `loader ~1.0.6`, 与 dsh 使用的 4.1.0 / 1.1.0 不匹配), **非 rc.5 引入**; 物化完成后 `pnpm install` 不再重现 (Already up to date), `peers check` 恒报为官方组合的固有信息, 不影响运行。
- pnpm 在 `--no-frozen-lockfile` install 时自动写入 `minimumReleaseAgeExclude` (供应链发布年龄豁免) 到 workspace yaml: 属工具自动产物, 已还原 / 删除, 不作为本任务产出。
- 根 CLI 的 `pnpm peers check` 在该沙箱环境触发 home store SQLite 只读错误: 沙箱环境限制, 与本仓无关 (用户真机无此路径)。

## 收尾

- 2026-11-19: 用户执行 `scripts/install.sh --force` 实装 rc.5（全局 `dsh --version` = `0.2.2-rc.5`）, 用备份配置回填 fff / fff-test; 安装树 337 包、dump 875 行 / 152 个 `- id:`（官方 110 / 本仓 42）、官方活跃 101（与 rc.3 差异 = hmr 由条件式改无条件 disabled, 多 1 条; 详见 `HOST-UPGRADE-0.2.2-rc.5.md` §5）。ffa patch 的 `ponytail` 陈旧条目告警由用户在 profile 侧清理（本仓无残留）。
- 追踪文档关闭, 移入 `docs/archived/2026-11-19-host-update-check.md`。
- BACKLOG: 条目「检查宿主更新」标完成并从 §2 清理移除, §1 已完成索引补一行。
- 残留: `docs/STATUS.md` 宿主基线由用户择时更新。
