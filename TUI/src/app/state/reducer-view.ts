// TUI/src/app/state/reducer-view.ts — 纯 reducer 分组：视图、焦点与滚动

import { DIALOGUE_KEEP_REPLIES } from "../layout.ts";
import type { AppState } from "./types.ts";
import { setSystemStatus } from "./updates.ts";
import type { StateAction } from "./actions.ts";

export function reduceView(
  state: AppState,
  action: StateAction,
): AppState | undefined {
  switch (action.type) {
    case "dialogue-scroll":
      // 位移换算在 App（拿到本帧段表与可视高）完成，此处只落位置
      return {
        ...state,
        dialogueTop: action.top,
        followBottom: action.top === null,
        scrollOffset: action.top === null ? 0 : Math.max(0, action.offset),
      };
    case "scroll-to-bottom":
      // 回到最新：跟随底部并复位渐进窗口（窗口内容随之上滚时再按需扩窗）
      return {
        ...state,
        followBottom: true,
        scrollOffset: 0,
        dialogueTop: null,
        activityTop: null,
        windowGroups: DIALOGUE_KEEP_REPLIES,
      };
    case "window-grow":
      // 扩窗（App 在位移前调用）：只多物化更早回合，视口位置不动
      return {
        ...state,
        windowGroups: Math.max(DIALOGUE_KEEP_REPLIES, action.groups),
      };
    case "status":
      return setSystemStatus(state, action.status);
    case "set-theme":
      return { ...state, themeId: action.themeId };
    case "status-column": {
      // P7：Ctrl+S 切换垂直状态列显隐（缺省取反）；隐藏时把焦点从状态列移开
      // （否则 0 宽面板仍会被 focusFrame 画出退化边框，压在内容首列上）
      const visible = action.visible ?? !state.statusColumnVisible;
      return {
        ...state,
        statusColumnVisible: visible,
        focusedPanel:
          !visible && state.focusedPanel === "status"
            ? null
            : state.focusedPanel,
      };
    }
    case "lower-panes": {
      // #9：Ctrl+T 切换下半区（Turn 流 + 工具区）显隐（缺省取反）；
      // 隐藏时把焦点从下半区移开（隐藏即不聚焦），输入区不受影响
      const visible = action.visible ?? !state.lowerPanesVisible;
      return {
        ...state,
        lowerPanesVisible: visible,
        focusedPanel:
          !visible && state.focusedPanel === "activity"
            ? null
            : state.focusedPanel,
      };
    }
    case "activity-compact": {
      // 回合区压缩（按类别）：true=该类条目压 1 行 + 省略号；false=完整折行
      const next = { ...state.activityCompact };
      for (const category of action.categories) next[category] = action.on;
      return { ...state, activityCompact: next };
    }
    case "activity-show": {
      // 回合区显示（按类别）：true=显示该类内容；false=不显示
      const next = { ...state.activityShow };
      for (const category of action.categories) next[category] = action.on;
      return { ...state, activityShow: next };
    }
    case "symbol-unify":
      // 模型输出符号统一开关：true=变体替换为推荐并提醒；false=原样（不替换不提醒）
      return { ...state, symbolUnify: action.on };
    case "flow-track":
      // flow-track 注入开关（进程本地态，不落 tui-state.json）：标题栏符号开绿 / 关灰
      return { ...state, flowTrackEnabled: action.enabled };
    case "status-column-scroll":
      // 顶部状态列纵向滚动：偏移累加，渲染层按可视行数 clamp；不进入会话区滚动
      return {
        ...state,
        statusColumnScroll: Math.max(
          0,
          state.statusColumnScroll + action.delta,
        ),
      };
    case "focus-panel": {
      // 「一键一区域」三态（2026-10-14 用户裁定，取代 Tab 焦点循环）：
      //  未聚焦 → 显示（若已收起）并聚焦；已聚焦 → 收起该区域 + 焦点回会话区（null）。
      // 可见但未聚焦时首次按键只聚焦（不收起）⟹ 收起可见面板需按两次。
      // 状态列 / 下半区「隐藏即不聚焦」由本分支与 status-column / lower-panes 各自保证；
      // 二者隐藏时「再按区域键」应重新显示并聚焦（不是收起），故按可见性分派而非按焦点。
      const target = action.panel;
      if (target === "history") {
        // 会话区恒显示：已聚焦 → 回无焦点；未聚焦 → 聚焦
        return {
          ...state,
          focusedPanel: state.focusedPanel === "history" ? null : "history",
        };
      }
      if (target === "status") {
        const collapse =
          state.statusColumnVisible && state.focusedPanel === "status";
        return {
          ...state,
          statusColumnVisible: !collapse,
          focusedPanel: collapse ? null : "status",
        };
      }
      const collapse =
        state.lowerPanesVisible && state.focusedPanel === "activity";
      return {
        ...state,
        lowerPanesVisible: !collapse,
        focusedPanel: collapse ? null : "activity",
      };
    }
    case "activity-scroll": {
      // 回合区（流输出）滚动。带 `top` 时按「节键 + 行」定位（App 先算好 positionAt）:
      // 位置用内容段身份表达, 上方插段不改画面; `null` = 跟随最新。
      // 缺 `top`(旧路径) 偏移累加(距底行数), 0=跟随最新; `max` = 上一帧回填的可滚动上限,
      // 先收敛越界再叠加、不超上限(避免"按了没反应"的假死, 与会话区 scrollBy 同口径)。
      if ("top" in action) {
        return {
          ...state,
          activityTop: action.top ?? null,
          activityScroll: Math.max(0, action.offset ?? 0),
        };
      }
      const max = Math.max(0, action.max ?? Number.MAX_SAFE_INTEGER);
      const cur = Math.min(state.activityScroll, max);
      return {
        ...state,
        activityScroll: Math.min(max, Math.max(0, cur + action.delta)),
      };
    }
    default:
      return undefined;
  }
}
