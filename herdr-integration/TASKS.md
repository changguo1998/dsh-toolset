# herdr-integration 后续任务安排

> 系列：`DEVELOPMENT-BACKLOG.md` #36。
> 状态：代码已合入 main；原 TASKS.md 未回填，真实完成度需复核。以下均为待办。

## 待办：部署与复核

- [ ] 复核真实完成度（git 记录不足以证明已验证）
- [ ] profile 挂载验证（`link:` 依赖，勿用 `file:`）
- [ ] 端到端人工接入 herdr 面板复核（`scripts/verify-herdr.mjs`：状态上报 + blocked 桥）

## 待办：接口对齐（DSH-CTX-API 0.1.2-rc.1）

- [ ] 补充 turn/end blocked（blocked reason）作为 blocked 桥信号源（现仅 ask-user 阻塞）

## 验收

herdr 面板可见状态上报与 blocked 事件，行为与 pi 原生扩展一致；接口对齐后 `npm run check` / `test` 全绿。
