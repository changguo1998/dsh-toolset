# step 0 的假头 + 回放路径的 step 头丢时间戳 / 重复（接取条目：`TUI/docs/BACKLOG.md` 第 21 条）

状态：关闭　　开启：2026-10-11　　关闭：2026-10-11

## 目标与验收

回放演示式缓冲行时回合区**没有** `#0` 头；有内容的 step 头带时间戳；同一步号不重复出头。

## 根因链（条目原文 + 本轮核对）

① `state.ts` 的 `step` 落行点对 `step: 0`（宿主在首个 `step/start` 前的占位）也写一条 `⇆N #0` 头行；
② 回放从该行反解出 `step-start` → step 0 被当成「已声明」→ pane 层画出 `#0` 假头；
③ 条目说「回放构造的 step-start 不带 `time`」——**核对后已过时**：落行点已把 `time` 交给
`appendToolLine`，`replay.ts` 也已用 `line.time` 传 `step-start` ✓（故本条只做 ①②，③ 用用例钉住）。

## 实现（3 处）

| 改动 | 位置 |
| --- | --- |
| `step: 0` 不落头行（直接返回原 state） | `state.ts`（`case "step"` 的 `phase === "start"` 分支） |
| `stepOf` 把解析出的 `0` 视为「未声明」 | `replay.ts`（`stepOf`） |
| 回放**丢弃**历史缓冲里的 `#0` 占位头行（否则它会作为普通行上屏） | `replay.ts`（行循环内，`kind === "tool"` 且文本含 `#0 `） |

## 测试与证据

`tests/layout4.test.ts` 新增〈BACKLOG #21：回放不留 #0 假头 / 有内容的 step 头带时间戳 / 同号不重复〉：

- 帧里**不出现** `#0` ✓
- step 2 节 `time === STEP_TIME`（回放确实从缓冲行取到时间）✓
- step 2 只出一个节（不重复出头）✓

全量 `npm test` **1454 / 1454 通过**；`npm run check` 干净；`npm run build` 通过。

## 收尾

- 实现与用例随本提交落地；BACKLOG 移除该条；本文件归档到 `TUI/docs/archived/`。
- 遗留：无（`#0` 行只可能来自历史缓冲；新写入路径已不再产生）。
