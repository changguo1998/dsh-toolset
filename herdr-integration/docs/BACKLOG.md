# herdr-integration 待办

> 职责：herdr-integration 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、能力面与边界（见 `herdr-integration/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史、`herdr-integration/docs/archived/` 与 `herdr-integration/tests/`，不在此重复。
> 条目结构（2026-10-14 起）：现象 / 现状 → 期望 → 落点 → 验收 → 估时 → 来源·状态·优先级。

## 待办

**#1 核对 herdr 0.9.4 后本包是否需要更新**（2026-10-14 登记）：**现象 / 现状** —— 本机 herdr 已升到 **0.9.4**（protocol 22，channel stable），而仓内最后一次记录 herdr 版本的文档停在 **0.9.3**（`TUI/docs/archived/2026-09-30-question-panel-residue.md:49`）；本包不解析 herdr 版本、无版本感知，所以「升级是否影响集成」目前**没有结论**。本包对 herdr 的依赖面共四类（依据 `herdr-integration/README.md`「能力」「协议」两节）：① 握手环境变量 `HERDR_ENV` / `HERDR_SOCKET_PATH` / `HERDR_PANE_ID`，缺一即静默空转；② unix socket 上换行分隔 JSON 的三个 method——`pane.report_agent_session` / `pane.report_agent` / `pane.release_agent`；③ `seq` 单调递增与「收到响应数据即视为送达」的语义；④ 验证工具面 `herdr api snapshot`（`scripts/verify-herdr.mjs` 靠它核对面板状态）。**2026-10-14 实测（`herdr status`）**：client 0.9.4 / server 0.9.4、`endpoint_compatible: yes`、`private_protocol: 22`（`private_protocol_compatible: yes`）、`restart_needed: no`、`server_binary_stale: no`——上次排查的 client 0.9.3 / server 0.9.1 落后问题已消失（同上归档文档 `:144`）。
**期望** —— 一次调研给出**三选一结论**并写明依据：**(a) 无需改动**（附差异比对结论）；**(b) 需要改动**（逐条列出报文 / 字段 / 握手变量 / CLI 子命令的变化，并给改动面与影响评估）；**(c) 无法判定**（写明缺什么证据）。调研面至少覆盖：① herdr 0.9.3 → 0.9.4 的发布说明 / changelog（重点是协议条目，对照 `herdr status` 的 protocol 22）；② 三个 `pane.*` method 的报文与响应形态是否变（含 `seq` 语义）；③ 握手变量与 `herdr api` / `herdr status` 子命令是否变；④ 是否新增了本包该用上的集成面（例如新的状态或事件 method）——若值得接，另开条目，不在本条内顺手做。**落点** —— 结论先记进本条目（关闭时把结论留在条目里或移入 `herdr-integration/docs/archived/`）；若结论为 (b)，另建追踪文档 `herdr-integration/docs/implementation/<YYYY-MM-DD>-herdr-0.9.4-compat.md` 走标准流程，改动面为 `src/herdr.ts` / `src/main.ts` 与 `README.md` 的协议节。**验收** —— ① 结论有据：命令输出照原样转述或给 changelog 链接，不写「看起来没变」；② 真机在 herdr 面板内跑一轮状态往返（`dsh --profile fff` + `node scripts/verify-herdr.mjs blocked|working|idle|session` + `herdr api snapshot`），面板展示与 `README.md`「能力」表一致；③ 若走了 (b)，补对应单测并跑 `npm run check` + `npm run build` + `npm test`（现 35 例）。**估时** —— 0.5 天以内（主体是读发布说明 + 一次真机回归；真出改动另计）。**优先级** —— P2（本机已在新版上且 `endpoint_compatible: yes`，未见报障，属预防性核对）。**来源** —— 2026-10-14 用户要求（「herdr 最近更新了一版，调研确认 herdr 集成是否需要更新」）。〔待办: 2026-10-14 登记〕
