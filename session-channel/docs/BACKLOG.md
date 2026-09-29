# session-channel 待办

> 职责：session-channel 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与边界（见 `session-channel/README.md` 与 `session-channel/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**；与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `session-channel/tests/`（如 D4 已修复提交），不在此重复。

## 1. 缺陷

### D5. 服务面与公开方法不对齐（防「加在类上、漏在服务面」）

- **背景**：`apply()` 里 `provide("sessionChannel", {…})` 是**手工列举**的方法子集，与类上的公开方法容易脱节——2026-09-29 真机即因此踩坑：别名三件套加进了类，却漏进服务面，TUI 调用 `aliasList()` 直接抛 `TypeError`（被消费侧 catch 吞掉，表现为「状态栏没有别名段」，排查两轮才定位）。
- **修法（择一或组合）**：
  1. **测试守卫**：断言服务面键集合 = 期望清单（现已有「必须含 aliasSet/aliasList/aliasClear」的局部断言，可扩展为完整键集合比对，新增/删除方法时强制同步）；
  1. **构造即对齐**：服务面改为从类实例**显式 pick**（如 `pick(service, ["peers","send","inbox","aliasSet","aliasList","aliasClear","status"])`），键清单集中一处，diff 时可见；
  1. 文档：`DESIGN.md` §7 列出服务面方法清单，作为契约对照。
- **验收**：新增公开方法而忘记进服务面时，`npm --prefix session-channel run test` **失败**并指出缺哪个键。
- **状态**：待接取（2026-09-29 #48 真机排查中发现）。优先级 P3。

### D6. 注入正文不显示发送方（视觉层缺来源，D4 的遗留面）

- **现象**：接收方实际看到的注入正文仍是 `[CHANNEL] <正文>`，没有发送方标识——D4 已把 `from` 回填（邮箱流 `from`、注入 `source.summary = session-channel 来自 <id>` 均正确），但宿主/TUI 未把 `source` 元数据渲染进可见文本（D4 真机验证时自测消息实测：可见正文无来源）。
- **影响**：多会话互发时接收方在正文里仍分不清「谁发的」，只能另查邮箱流；D4 只解决了数据层，视觉层缺来源仍成立。
- **修法（择一）**：① 在 `buildInjectionMessage` 把来源并入正文，如 `[CHANNEL] 来自 <from 或 未知会话>：<正文>`（**用户可见文本变化，属契约/体验变更，宜走标准流程**）；② 若宿主支持 source 渲染，改展示层而非正文；③ 维持现状，仅以邮箱流为准（不推荐，D4 现象未真正消除）。
- **验收**：接收方在注入正文即可辨识来源；`from` 为空时显式「未知会话」；前缀 `[CHANNEL] ` 与既有消费方（正则/文案依赖）不受损。
- **状态**：进行中（2026-09-29 接取，追踪文档 `implementation/2026-09-29-injection-origin-label.md`）。优先级 P2。
