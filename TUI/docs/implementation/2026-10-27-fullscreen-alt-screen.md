# 全屏（备用屏）模式：启动切备用屏、退出还原

状态：待提交　　开启：2026-10-27
接取条目：`TUI/docs/BACKLOG.md`「全屏（备用屏）模式：启动切备用屏、退出还原」。
本文件是本任务唯一的过程记录与文档变更落点。

## 背景

现状渲染器只在**普通屏幕缓冲区**里绝对定位逐行重绘（`screen.ts` 的 `render` 用
`ESC[<行>;1H` + 先擦后写，全程不发 CRLF），终端自己的回滚缓冲仍在。于是 PgUp/PgDn 是否到达
应用取决于终端 / 复用器（herdr、tmux 之类会先解释成翻自己的 scrollback）。

pi-agent 的全屏模式即备用屏：`ESC[?1049h` 进入、`ESC[?1049l` 退出；备用屏没有终端回滚，
翻页键因此只归应用。

## 实现

`TUI/src/renderer/index.ts`：

- 新增常量 `ALT_SCREEN_ON = "\x1b[?1049h"` / `ALT_SCREEN_OFF = "\x1b[?1049l"`。
- 启动（`opts.rawMode !== false`，即真终端）时先写 `ALT_SCREEN_ON`，再开 bracketed paste。
- 新增幂等开关 `altScreenOn` + `altOff()`（与 `pasteOff` 同款）；`restore()`（退出钩子 /
  `beforeExit`）与 `close()` 都调用它，保证异常退出也还原原屏幕。
- **不写回当前帧内容**（用户 2026-10-27 裁定）：退出后回到启动前的屏幕内容。

## 测试

新增 `TUI/tests/fullscreen-alt-screen.test.ts`：启动写一次 `1049h` 且先于 bracketed paste；
`close({ exit: false })` 写一次 `1049l`，且退出报文里不含帧内容（证明没有写回）。

## 证据

- `tsc --noEmit` 通过；TUI 全量 **1806 例全绿**（原 1805 + 新增 1）。

## 收尾

（待关闭时填写。）
