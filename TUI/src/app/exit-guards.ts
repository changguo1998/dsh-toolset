// TUI/src/app/exit-guards.ts — 退出守卫与退出/重启/清理的约定常量

import type { AppState } from "./state.ts";
import { isCompacting } from "./state.ts";

/** Ctrl+D 退出守卫（P8 口径）：agent 空闲、**未在压缩上下文**、且输入区为空才退出。
 *  压缩期间视为活跃——此时按 Ctrl+D 不退出（与排队判据同源，见 App.agentBusy）。 */
export function canExitOnCtrlD(state: AppState): boolean {
  return (
    state.agentStatus === "idle" &&
    !isCompacting(state) &&
    state.inputText === ""
  );
}

/** Ctrl+C 双击退出窗口(毫秒)：窗口内第二次 Ctrl+C 退出程序 */
export const CTRL_C_DOUBLE_MS = 750;
/** 退出确认面板的合成问答面板 id（非宿主 ask；`submitQuestion`/`cancelQuestion` 按它分支，
 *  绝不调用 adapter 的 answerQuestion/cancelQuestion）。普通 id 不会与之冲突（宿主 id 为 uuid 类） */
export const EXIT_CONFIRM_PANEL_ID = "exit-confirm";
/** 退出确认面板「重启 dsh」项与启动器的约定退出码（BACKLOG #51）：
 *  TUI 置 `process.exitCode = 75` 后正常收尾退出，启动器看到 75 即重启下一轮
 *  （会话 id 经 `DSH_RESTART_FILE` 交接；语义见 `TUI/docs/DESIGN.md`「退出确认 ·「重启」方案」） */
export const DSH_RESTART_EXIT_CODE = 75;
/** 「重启 dsh（保留会话）」选项文案：`finishExitConfirm` 按它分支，测试与文案同源 */
export const EXIT_CONFIRM_RESTART_LABEL = "重启 dsh（保留会话）";
/** 退出确认面板「清理并退出」项文案：`finishExitConfirm` 按它分支，测试与文案同源 */
export const EXIT_CONFIRM_CLEAN_LABEL = "清理并退出（删除本会话）";
/** `/cleanquit` 的合成确认面板 id 与确认项文案（删除不可逆，显式命令也要二次确认） */
export const CLEAN_QUIT_PANEL_ID = "clean-quit-confirm";
export const CLEAN_QUIT_CONFIRM_LABEL = "清理并退出";
/** `/memory` 用法（管理面子命令；S 层按会话隔离，管理面只处理 project / user）。 */
export const MEMORY_USAGE =
  "usage: /memory [search <query> [--all-projects] | list [project|user] [--kind <k>] | " +
  "remove <tier> <kind> <id> | replace <tier> <kind> <id> <content> | " +
  "add <project|user> --kind <k> <content>]";
/** 退出时清理空会话的最长等待(ms)：防会话服务挂起把退出卡死。
 *  正常清理毫秒级即可完成，超时仅放弃清理并继续退出。 */
export const EXIT_CLEAN_TIMEOUT_MS = 5000;
