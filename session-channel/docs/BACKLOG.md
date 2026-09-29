# session-channel 待办

> 职责：session-channel 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与边界（见 `session-channel/README.md` 与 `session-channel/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**；与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 过期条件：无

## 1. 缺陷

### D4. 发送方标识恒为空（接收侧看不到「来自谁」）

- **现象**：接收方看到的注入是 `[CHANNEL] <正文>`，没有发送方会话标识（2026-09-29 真机实测：自检消息 `[CHANNEL] 别名寻址自检（to=docs）`；邮箱流里 `from` 字段亦为空串）。
- **根因**：工具层调用 `service.send({ …, from: "" })`（`src/index.ts` 的 `send` 分支）——未把调用方会话传给 `from`；宿主 `execute(args, exec)` 已提供 `exec.agent.session.id`（本次 F1 已用同一来源解析「当前会话」，可直接复用）。
- **影响**：多会话互发时无法判断消息来源（「谁发的」丢失）；仅 `to` 单向信息。
- **修法**：工具层把 `from` 置为调用方会话 id（缺省 `""` 时由服务端在注入文案里降级为无来源提示）；必要时在 `buildInjectionMessage` 里对空 `from` 明示「未知来源」。
- **验收**：非 agent 调用方仍可用（`from` 空不影响）；agent 调用方发出的消息，接收侧注入与邮箱流均带发送方会话 id。
- **状态**：待接取（2026-09-29 F1 真机验证时发现）。优先级 P2。
