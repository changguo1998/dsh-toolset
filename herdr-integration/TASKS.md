# herdr-integration 开发任务安排

> 来源：`docs/DEVELOPMENT-BACKLOG.md` #36（P1）；分支 `feat/herdr-integration`（基线 c1ad2ae）。
> 定位：**热身插件**——最小、零依赖，用来打通 dsh-toolset 新插件脚手架（`package.json` 的 `dsh.bundle` + `cordis.patch.yml`、构建部署、profile 挂载），为后续所有插件铺路。

## 目标

dsh 与 herdr 面板集成：agent 状态经 unix socket 上报；blocked 事件桥（含 ask-user blocked → herdr blocked）。

## 任务分解

- [ ] 脚手架：以 `TUI/` 包为模板建包（`package.json` + `dsh.bundle` + `cordis.patch.yml` + `tsconfig.json`）
- [ ] 协议：`HERDR_ENV` / `HERDR_SOCKET_PATH` / `HERDR_PANE_ID` 环境变量握手（对照 pi 原生扩展 `~/.pi/agent/extensions/herdr-agent-state.ts`、`herdr-ask-user-question.ts`，仅协议仿写、代码重写）
- [ ] 状态上报：unix socket 客户端，会话/运行状态变化时上报
- [ ] blocked 事件桥：ask-user 阻塞 → herdr blocked 事件
- [ ] 构建部署：`npm run build`；profile `link:` 依赖挂载验证（勿用 `file:`）
- [ ] 人工确认：实际接入 herdr 面板验证

## 复用（不新建）

无底座；协议仿 pi 原生（unix socket + 环境变量握手）。

## 约束

- **所有改动仅限本目录（`herdr-integration/`）内；不得修改仓库根目录任何既有文件**（含根级配置/文档）；需要跨目录变更时，回 `migrate-pi-plugins` 分支处理。
- 契约对齐 `DSH-CTX-API.md`（dsh 0.1.2-rc.1）。
- 变更流程：改代码 → `npm run build` → 人工确认（实际接入验证）→ 才允许提交；Conventional Commits 中文。

## 验收

对照 BACKLOG #36：状态上报与 blocked 桥在 herdr 面板可见，行为与 pi 原生扩展一致。
