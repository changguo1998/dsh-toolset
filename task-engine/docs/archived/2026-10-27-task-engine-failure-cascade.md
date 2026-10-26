# task-engine：子帧失败向上传播（修「节点失败后整棵树卡死」）

状态：完成　　开启：2026-10-27
接取条目：`task-engine/docs/BACKLOG.md`「子帧 failed 后整棵树卡死」。
本文件是本任务唯一的过程记录与文档变更落点。

## 现象与根因

用户实测: 某个节点 fail 之后整棵任务树卡死, 不能再建新节点。

代码定位（全部在 `task-engine/src`）:

1. `plan/frame-failed` 是终态, 只有**当前轮根**处于终态时才允许再 decompose 开新一轮
   (`engine.ts:348-355`); 非根终态帧一律「不可再拆」。
2. 父帧只在**全部子帧 done** 时被 join 结算 (`tryJoinParent`, `engine.ts:854-857`),
   子帧 failed 不算 done → 父帧永远停在 pending。
3. 已展开过的父帧再 decompose 直接被拒 (`engine.ts:386-392`)。
4. 就绪池因此为空 (`nextReady`, `engine.ts:281-291`)。

合起来: 根既不终态（不能开新一轮）、又不能再展开（不能补节点）、池子也空 → 模型无路可走。

## 方案（用户 2026-10-27 选定方案 1: 失败向上传播）

帧重试耗尽转 failed 时, 沿 `parentId` 链把仍在进行中的祖先一并转 failed, 各自走一次终态钩子
（回收 worktree 等）, 根进入终态后自动获得「开新一轮」出口。

## 计划改动文件清单

- `task-engine/src/engine.ts`
- `task-engine/tests/engine.test.ts`
- `task-engine/docs/DESIGN.md` / `README.md`
- `task-engine/docs/BACKLOG.md` 与本文件

## 实现

- `src/engine.ts`: `rejectFrame` 的终态分支抽成 `failFrame(frameId)` —— `markFailed` 落单帧
  （先取终态注记回收 worktree, 再记 `plan/frame-failed` 并重算）, 随后沿 `parentId` 链对仍在
  进行中的祖先逐个 `markFailed`, 遇 `done` / `failed` 即停。
- `tests/engine.test.ts`: 新增用例「子帧失败向上传播」—— 两个叶子, c1 的机械验收恒失败、
  重试耗尽转 failed, 断言根随之一并 failed, 并对已终态的根再 decompose 能开新一轮 (`root-2`)。
- `docs/DESIGN.md` / `README.md`: 补失败向上传播口径（原来只写了「failed 是逃生口」,
  没说清根如何才会进 failed）。

## 验证

- `npm run check`（tsc --noEmit）通过。
- `npm test`: **151 例全绿**（engine.test.ts 42 例, 含新增回归用例）。
- 未做真机验证: 需要在真实会话里让某个子任务失败, 观察根是否转 failed 且能继续 decompose。

## 收尾

- 提交见 git 历史；条目从 BACKLOG 移出。
