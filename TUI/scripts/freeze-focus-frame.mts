// TUI/scripts/freeze-focus-frame.mts — 冻结焦点构图与面板渲染基线（接线汇合里程碑前置）
//
// 一次性工具：调用当前 buildFrame 输出固化为 fixtures/focus-frame-legacy.json，
// 以供 tests/focus-frame.test.ts 从 fixture 读取基线做双轨对照（旧实现删除后
// 对照测试仍独立可回归）。**场景构造与测试共用 tests/helpers/focusFrameScenes.ts**
// ——此前两处各写一份，冻结脚本停在「内容不进 pipeline」的旧写法，夹具与断言长期错位
// （2026-10-14 修复：重冻出的基线即测试所断言的 state）。
//
// 用法：node --experimental-transform-types scripts/freeze-focus-frame.mts
//
// 重冻记录：2026-10-14（提示行统一格式 + 提示区 1 至 2 行动态高：焦点场景换新提示文案、
// `panel-picker@w60` 提示行折 2 行）—— 见 TUI/docs/implementation/
// 2026-10-14-focus-panel-key.md「偏差」节；一般回归勿盲刷夹具。
// 重冻记录追加 2026-10-15（普通输入态两态提示行前置输入模式提示符图例 `[> / ! $ <]`：
// 焦点场景与面板场景的默认提示行文案随之变更，属预期差异）。
// 重冻记录追加 2026-10-16（BACKLOG「按键提示信息与实际绑定对齐」决策 2 —— 面板态提示补齐：
// `panel-approval@w60` 列 `y/n` 与 `←/→` 后 60 列下由 1 行折成 2 行（交互区差 1 行，
// 活动区为空故无其它行差异）、`panel-picker@w60` 的 `[Tab]切列` 改为 `[Tab/←/→]切列`；
// `focus-*` 与其余面板场景无差异，属预期差异）。
// 重冻记录追加 2026-10-16（BACKLOG「取消 pane 边界留白空行的竖线」—— 会话区「用户块 → 正文」
// 与回合区「思考 ↔ 正文」的留白空行由「继承下一行前导竖线」改为**裸空行**：各焦点 / 面板
// 场景中该行变为纯空白、原竖线段的 ansi 一并消失，属预期差异）。
//
// 重冻记录追加 2026-10-26（用户输入 markdown 排版改「块铺满」形制：用户块（段落 / 列表 /
// 代码）统一为 box 外壳——左缘固定 `gutter-1` 列、右缘 `┃` 贴 pane 右缘、不再按最长行收缩。
// 各焦点 / 面板场景含用户块的行由「右对齐收缩块」变为「铺满 + 左留白」，属预期差异）。
//
// 重冻记录追加 2026-10-26（渲染流水线结构收敛 + 行尾补白口径定案）：新链摊平每行补到
// pane 宽（用户裁定保留补白、断言改比对前 trim），故 8 个焦点场景的会话区文本行仅多出
// **行尾空格**（L11-L16 / L14-L16，逐行已人工比对，无字形 / 行数变化）；7 个面板场景逐行零差异。
// 同行改口径：会话区竖线后**不带空格**（`┃`直接接正文，右缘 suffix = gutter − 1 空格），
// 纯虚线 turn 分隔行不再被空文本盒挤出一列空白。
//
// 序列化口径：整帧每行 { text, ansi } —— text=纯文本拼接（行宽 infos 保留），
// ansi=行经 dark 主题段级序列化（样式差异捕获）。key=`scene@w{cols}`。
// 注意：fixture 缩进以本脚本写出的为准，勿对产出的 JSON 跑 `format`
// （jq 会整体改缩进，把几行真实差异淹成整文件 diff）。

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildFrame } from "../src/app/layout.ts";
import { rowAnsi } from "../tests/helpers/rowText.ts";
import {
  FOCUS_FRAME_SCENES,
  colsFor,
  stateFor,
} from "../tests/helpers/focusFrameScenes.ts";
import type { AppState } from "../src/app/state.ts";
import type { FrameRow } from "../src/renderer/screen.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "focus-frame-legacy.json",
);

/** 基线帧：整帧每行 {text, ansi} */
type Row = { text: string; ansi: string };
type Entry = { rows: Row[] };
type Fixture = Record<string, Entry>;

const TF = { rows: 24 } as const;

function rowsOf(s: AppState, cols: number): Row[] {
  return buildFrame(s, { ...TF, cols }).map((r: FrameRow) => ({
    text: r.segments.map((g) => g.text).join(""),
    ansi: rowAnsi(r),
  }));
}

const fixture: Fixture = {};
for (const scene of FOCUS_FRAME_SCENES) {
  fixture[scene] = { rows: rowsOf(stateFor(scene), colsFor(scene)) };
}

writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
console.log(`frozen ${Object.keys(fixture).length} scenes -> ${outPath}`);
