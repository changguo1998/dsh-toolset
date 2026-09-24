// demo/main.ts — demo 入口：mock adapter 喂数据，走通 renderer→app 全栈
//
// 独立入口，无 DSH 依赖（不读取 profile 的 cordis.patch.yml 配置）。
// 构建后运行 dist/demo/main.js；可选参数：
//   --theme dark|light  显式指定主题（幂等；非法值回退内置默认）
//   --smoke             无 TTY（管道/CI 等）或带 --smoke 时自动走冒烟脚本：
//                       合成按键驱动并自断言
// 新输入交互（! 为普通字符 / $ 切模式 + shell 提交左提示符 $ / 空输入 Backspace
// 回退 / Alt+Enter 打断并发送 / Esc idle 无操作 / 审批弹窗 Esc 不打断不关闭），
// 产出 SMOKE_* 证据后 /quit 以退出码 0 收尾，便于无头环境演示与机械验证。

import {
  createRenderer,
  type FrameRow,
  type FrameSection,
  type KeyEvent,
} from "../src/renderer/index.ts";
import { loadTuiConfig } from "../src/app/config.ts";
import { resolveThemes } from "../src/renderer/theme-config.ts";
import {
  ansiNameToHex,
  hexSgr,
  normalizeThemeId,
} from "../src/renderer/theme.ts";
import { App } from "../src/app/index.ts";
import { createProcessStatusQueries } from "../src/app/status.ts";
import { createMockDshAdapter, type MockDshAdapter } from "./mockAdapter.ts";

const tuiConfig = loadTuiConfig();
const resolvedThemes = resolveThemes(tuiConfig.theme);
const renderer = createRenderer({ themes: resolvedThemes.themes });
// demo 交互模式启用自动审批（第二次回复后弹审批窗）；smoke 由脚本显式
// 驱动审批弹窗，避免自动触发与脚本时序互相干扰
const smoke = process.argv.includes("--smoke") || !process.stdin.isTTY;
const adapter: MockDshAdapter = createMockDshAdapter({
  autoApproval: !smoke,
}) as MockDshAdapter;

// demo 主题：--theme <light|dark> 显式传入（缺省回落配置文件 theme.active）
const themeIdx = process.argv.indexOf("--theme");
const initialTheme = themeIdx >= 0 ? process.argv[themeIdx + 1] : undefined;

// 冒烟断言用主题实际槽位色（不硬编码 dark 色值）：red/green/yellow 随主题变化
const smokeTheme = resolvedThemes.themes[normalizeThemeId(initialTheme)];
const smokeSgr = (name: "red" | "green" | "yellow"): string =>
  hexSgr(ansiNameToHex(smokeTheme, name)!, true);

// 冒烟模式：额外记录**完整帧**文本——stdout 上只有增量行，折行通知的两半会被其它行
// 插入打断（按连续文本断言会漏）；渲染层每帧都拿到整帧行数组，改从它取证。
const smokeFrames: string[] = [];
if (smoke) {
  const origRender = renderer.render.bind(renderer);
  const origRefresh = renderer.refresh.bind(renderer);
  const cap = (rows: FrameRow[]): void => {
    smokeFrames.push(
      rows.map((r) => r.segments.map((x) => x.text).join("")).join("\n"),
    );
  };
  renderer.render = ((rows: FrameRow[], sections?: FrameSection[]) => {
    cap(rows);
    origRender(rows, sections);
  }) as typeof renderer.render;
  renderer.refresh = ((rows: FrameRow[], sections?: FrameSection[]) => {
    cap(rows);
    origRefresh(rows, sections);
  }) as typeof renderer.refresh;
}

const app = new App({
  renderer,
  adapter,
  ...tuiConfig.layout,
  initialTheme: normalizeThemeId(initialTheme ?? resolvedThemes.active),
  status: { queries: createProcessStatusQueries(), intervalMs: 5000 },
});
app.start();

// 退出路径交 renderer：/quit 命令、SIGINT/SIGTERM 信号或进程结束即可；此处不加额外逻辑。

// —— 冒烟模式（无 TTY 或显式 --smoke）：合成按键驱动 + 自断言，产出 SMOKE_* 证据 ——
// 捕获 renderer 写出的帧文本（ANSI 剥离后扫描提示符/审批弹窗证据）
let smokeOut = "";
if (smoke) {
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    smokeOut += String(chunk);
    return origWrite(chunk as never, ...(rest as never[]));
  }) as typeof process.stdout.write;
}

const key = (name: string, meta = false): KeyEvent => ({
  name,
  ctrl: false,
  meta,
  shift: false,
});
const typeText = (line: string): void => {
  for (const ch of line) renderer.emitKey(key(ch));
};
const typeLine = (line: string): void => {
  typeText(line);
  renderer.emitKey(key("enter"));
};
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

if (smoke) {
  // 等 app.start() 完成 onKey 注册与首帧渲染后再注入按键
  setTimeout(() => {
    void (async () => {
      const pass = (label: string): void =>
        console.error("SMOKE_PASS " + label);
      const fail = (label: string, detail = ""): void => {
        console.error(
          "SMOKE_FAIL " + label + (detail ? " (" + detail + ")" : ""),
        );
        process.exitCode = 1;
      };
      const ok = (label: string, cond: boolean, detail = ""): void => {
        if (cond) pass(label);
        else fail(label, detail);
      };
      // 1. /model 交互选择（既有冒烟路径）
      typeLine("/model");
      await sleep(600);
      renderer.emitKey(key("down"));
      await sleep(150);
      renderer.emitKey(key("enter"));
      await sleep(600);
      // 2. ! 为普通字符：空输入按 ! 不切模式，直接发送 "!hello"
      typeLine("!hello");
      await sleep(2600); // 等 mock 回复 + turn-end（把上次模式落回 normal）
      // 3. $ 切 shell 模式 + 提交 → 不加 $ 前缀发送 "ls"；提示符单字符（状态符号在状态栏）
      renderer.emitKey(key("$"));
      typeText("ls");
      renderer.emitKey(key("enter"));
      await sleep(2600);
      // 4. / 切 slash 后空输入 Backspace 回退 normal → 再发送普通 "x"
      renderer.emitKey(key("/"));
      renderer.emitKey(key("backspace"));
      typeLine("x");
      await sleep(2600);
      // 5. Alt+Enter（meta+enter）：先打断再发送 "rm tmp"
      typeText("rm tmp");
      renderer.emitKey(key("enter", true));
      await sleep(2600);
      // 6. Esc：idle 时无操作（显式推 agent-status idle 保证确定性）
      adapter.emitEvent({
        type: "agent-status",
        sessionId: "mock-1",
        status: "idle",
      });
      await sleep(200);
      renderer.emitKey(key("escape"));
      await sleep(200);
      // 7. 审批弹窗：agent 活跃 + approval 打开时 Esc 不打断、不关闭；y 关闭
      adapter.emitEvent({
        type: "agent-status",
        sessionId: "mock-1",
        status: "tool",
      });
      // P1：状态符号随用户块——△ 只出现在**最新未终态块**上。先提交一条（mock 尚未回包），
      // 再打开审批面板，帧内即可见 `△ <文本>`（状态栏已不再承载状态符号）
      typeLine("等待审批的输入");
      await sleep(120);
      adapter.emitEvent({
        type: "approval",
        id: "smoke-ap",
        prompt: "允许执行?（y/n）",
      });
      await sleep(300);
      renderer.emitKey(key("escape"));
      await sleep(200);
      renderer.emitKey(key("y"));
      await sleep(300);

      // 8. 问答面板提交：question 事件 → ↓/空格选“测试” → 右切题 → Tab 自定义输入键入 note → Enter 提交整批
      adapter.emitEvent({
        type: "question",
        id: "smoke-q1",
        questions: [
          {
            id: "sq1",
            question: "选择部署环境？",
            header: "部署",
            options: [{ label: "生产" }, { label: "测试" }],
          },
          {
            id: "sq2",
            question: "保留日志？",
            multiSelect: true,
            options: [{ label: "保留" }, { label: "压缩" }],
          },
        ],
      });
      await sleep(300);
      renderer.emitKey(key("down"));
      renderer.emitKey(key(" "));
      await sleep(150);
      renderer.emitKey(key("right")); // 切到第 2 题
      renderer.emitKey(key("down")); // 压缩
      renderer.emitKey(key("down")); // “自定义回答”兜底项
      typeText("note");
      await sleep(150);
      renderer.emitKey(key("enter"));
      await sleep(400);
      // 9. 问答面板取消：question 事件 → Esc 仅取消（不打断 turn）
      adapter.emitEvent({
        type: "question",
        id: "smoke-q2",
        questions: [
          { id: "sq3", question: "取消测试？", options: [{ label: "A" }] },
        ],
      });
      await sleep(300);
      renderer.emitKey(key("escape"));
      await sleep(300);

      // P1：中止终态（灰 ■）——提交一条并让宿主以 aborted 收尾（`?` 只在「未终态且非活跃」
      // 时出现：由恢复历史/异常中断产生，单测覆盖；冒烟验可驱动的 ■）
      typeLine("中止示例");
      await sleep(120);
      adapter.emitEvent({ type: "turn-end", reason: "aborted" });
      await sleep(200);

      // —— 自断言（interrupt 应恰好 1 次：仅 Alt+Enter；Esc idle 与审批 Esc 均不得打断）——
      const sent = adapter.sent;
      ok(
        "dash-ordinary",
        sent.includes("!hello"),
        "sent=" + JSON.stringify(sent),
      );
      ok("shell-submit", sent.includes("ls"), "sent=" + JSON.stringify(sent));
      ok(
        "backspace-revert",
        sent.includes("x") && !sent.includes("/x"),
        "sent=" + JSON.stringify(sent),
      );
      ok(
        "alt-enter-send",
        sent.includes("rm tmp"),
        "sent=" + JSON.stringify(sent),
      );
      ok(
        "interrupt-exactly-once",
        adapter.interrupts === 1,
        "interrupts=" + adapter.interrupts,
      );
      const plain = smokeOut.replace(/\x1b\[[0-9;]*m/g, "");
      ok(
        "prompt-single-char",
        !plain.includes("$> "),
        "prompt should be single char (no '$> ' two-char prompt)",
      );
      // P1：状态符号在**用户块首行左侧**（`符号 + 1 空格 + 文本`），状态栏不再承载：
      // 终态绿 ✓ / 灰 ■（中止）/ 无终态 `?`；活跃块在忙时 ●/○、审批·问答面板打开时 △
      ok(
        "userblock-aborted-mark",
        /■ 中止示例┃/.test(plain),
        "no '■ ' aborted mark on the user block",
      );
      ok(
        "userblock-success-mark",
        /✓ (rm tmp|ls|!hello)┃/.test(plain),
        "no '✓ ' mark on a completed user block",
      );
      ok(
        "userblock-waiting-mark",
        /△ 等待审批/.test(plain),
        "no '△ ' mark on the active user block while the approval panel is open",
      );
      // 运行中 ●/○ 交替符号（流式输出驱动，相位不定故两相皆可）
      ok(
        "userblock-running-mark",
        /[●○] (rm tmp|等待审批|!hello|ls)/.test(plain),
        "no '●/○ ' mark on the active user block",
      );
      ok(
        "approval-rendered",
        plain.includes("允许执行?"),
        "approval text absent from frames",
      );
      // 面板按钮提示着色（raw 帧含 ANSI）：y 批准红、n 拒绝绿
      ok(
        "approval-y-red",
        smokeOut.includes(smokeSgr("red") + "[y]批准"),
        "approval [y] should be red",
      );
      ok(
        "approval-n-green",
        smokeOut.includes(smokeSgr("green") + "[n]拒绝"),
        "approval [n] should be green",
      );
      // /model 选择面板选项着色：打开时当前模型选中行绿、down 后焦点行黄
      // /model 选择面板选项着色：打开时当前模型选中行绿（焦点行黄见单测：
      // mock 仅一个 provider 恒为选中，> 焦点行不会在冒烟中出现）
      ok(
        "model-selected-green",
        smokeOut.includes(smokeSgr("green") + "* "),
        "model picker selected row should be green",
      );

      // 问答面板断言：提交整批（含第 2 题自定义 note）、取消走 cancelQuestion、Esc 不打断
      ok(
        "question-rendered",
        plain.includes("请回答（第"),
        "question panel title absent from frames",
      );
      // 问答面板选项着色：初始光标行（生产）黄
      ok(
        "question-option-focus-yellow",
        smokeOut.includes(smokeSgr("yellow") + " >  生产"),
        "question option focus row should be yellow",
      );
      ok(
        "question-submitted",
        adapter.answeredQuestions.length === 1 &&
          adapter.answeredQuestions[0]!.id === "smoke-q1" &&
          JSON.stringify(adapter.answeredQuestions[0]!.answer.answers) ===
            JSON.stringify([
              { id: "sq1", selected: ["测试"] },
              { id: "sq2", selected: [], custom: "note" },
            ]),
        "answered=" + JSON.stringify(adapter.answeredQuestions),
      );
      ok(
        "question-cancelled",
        adapter.cancelledQuestions.includes("smoke-q2"),
        "cancelled=" + JSON.stringify(adapter.cancelledQuestions),
      );
      ok(
        "question-esck-no-interrupt",
        adapter.interrupts === 1,
        "question Esc must not interrupt, interrupts=" + adapter.interrupts,
      );
      // 10. 状态栏会话徽标（mode/policy/preset/jobs；goal/todo 在
      //     左侧顶部状态列详显，状态栏不显示）；/goal 只提示查看信息栏（面板已移除）
      const badgePlain = smokeOut.replace(/\x1b\[[0-9;]*m/g, "");
      /** 折行归一化：去掉 ANSI / 空白 / pane 边框 `│`——通知文本可能被 pane 宽折成多行，
       *  逐行子串匹配会漏（同一行内才匹配），故按「拼接后的连续文本」断言 */
      const flatFrames = (): string =>
        smokeFrames.join("\n").replace(/[│\s]+/g, "");
      // P7：Mode 块已从状态列移除 → 会话状态符号改在**标题栏首行**（preset + 图标组 + 标题）。
      // 图标是 Nerd Font 私有区字形，按码位断言（终端字体差异不影响判断）
      const modeIconsPlain = flatFrames();
      const ICON = {
        box: "\u{ED95}",
        boxClosed: "\u{ED75}",
        ask: "\u{F1739}",
        never: "\u{F1414}",
        route: "\u{EDA6}",
        verbose: "\u{F09AA}",
        unify: "\u{F04C6}",
        bell: "\u{F009F}",
        preset: "\u{F0A66}",
      };
      ok(
        "titlebar-mode-icons",
        (modeIconsPlain.includes(ICON.box) ||
          modeIconsPlain.includes(ICON.boxClosed)) &&
          modeIconsPlain.includes(ICON.ask) &&
          modeIconsPlain.includes(ICON.route),
        "no title-bar status icons (sandbox / policy / plan) in frames",
      );
      ok(
        "status-column-no-mode",
        !badgePlain.includes("plan off on") &&
          !badgePlain.includes("sandbox ro wr full"),
        "status column still shows the removed Mode block",
      );
      ok(
        "step-header",
        /\d{2}:\d{2}:\d{2} #1 /.test(badgePlain) &&
          /\d{2}:\d{2}:\d{2} #2 /.test(badgePlain),
        "no `╌╌ hh:mm:ss #N ` step headers in frames",
      );
      ok(
        "subagent-line",
        badgePlain.includes("@ researcher os"),
        "no @ label os subagent line in frames",
      );
      ok(
        "compaction-summary-toast",
        flatFrames().includes("压缩完成：已压缩182条历史消息"),
        "no compaction-summary toast in frames",
      );
      ok(
        "tool-meta-diff",
        badgePlain.includes("(+1/-0)"),
        "no tool/result.meta diff summary in frames",
      );
      ok(
        "session-title-status-col",
        badgePlain.includes("升级适配 · 0.1.2-rc.1"),
        "no session-title at status column top in frames",
      );
      ok(
        "interrupted-notice",
        badgePlain.includes("模型输出已中断"),
        "no interrupted muted notice in frames",
      );
      typeLine("/goal");
      await sleep(300);
      const panelPlain = smokeOut.replace(/\x1b\[[0-9;]*m/g, "");
      ok(
        "goal-panel",
        panelPlain.includes("详情见左侧信息栏") &&
          panelPlain.includes("P2 阶段 B1+B2"),
        "goal 提示/状态列 objective absent from frames",
      );
      ok(
        "status-col-elements",
        panelPlain.includes("Goal active") &&
          panelPlain.includes("Todo 1/4") &&
          panelPlain.includes("● 状态栏 goal 徽标") &&
          // 列总高 > 窗口 17：折叠等级 L2（仅进行中）隐藏三合一+长待办 2 项
          // 并压 goal 为标题行（…(+2项已隐藏)）
          panelPlain.includes("…(+2项已隐藏)"),
        "status column goal/todo elements absent from frames",
      );
      await sleep(200);

      // /permission 无参：读目录 → 打开状态选项面板（标题 + 可用预设选项）
      typeLine("/permission");
      await sleep(400);
      const permPlain = smokeOut.replace(/\x1b\[[0-9;]*m/g, "");
      ok(
        "permission-catalog",
        permPlain.includes("/permission 权限预设") &&
          permPlain.includes("danger-full-access") &&
          permPlain.includes("[Enter]提交"),
        "no /permission status panel in frames",
      );
      renderer.emitKey(key("escape")); // 关闭面板
      await sleep(100);

      // —— 活动区混合断言：思考/中间输出/工具/notice 按时间顺序混合 ——
      // 先 /cls 清掉旧活动区瞬态（turn-begin 是内部 reducer 动作，adapter 事件面不可
      // 发），再注入一个混合回合：thinking → stream(中间，非 final) → 工具调用/结果
      // → notice → stream(最终总结)；turn-end 后中间输出/工具/notice 留在活动区（按
      // 时间同屏），最终总结标 final 进历史区。
      typeLine("/cls");
      await sleep(300);
      adapter.emitEvent({
        type: "thinking",
        sessionId: "mock-1",
        text: "混合思考行",
      });
      adapter.emitEvent({
        type: "stream",
        sessionId: "mock-1",
        text: "混合中间输出",
      });
      adapter.emitEvent({
        type: "tool-call",
        sessionId: "mock-1",
        name: "bash",
        summary: "mixed-check",
      });
      adapter.emitEvent({
        type: "tool-result",
        sessionId: "mock-1",
        ok: true,
        detail: "mixed ok",
      });
      adapter.emitEvent({ type: "notice", text: "混合 notice 提示" });
      adapter.emitEvent({
        type: "stream",
        sessionId: "mock-1",
        text: "混合最终总结",
      });
      adapter.emitEvent({ type: "turn-end" });
      await sleep(400);
      const mixedLines = (smokeOut.split("\x1b[2J\x1b[H").at(-1) ?? "")
        .split("\r\n")
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
      const lineIdx = (sub: string): number =>
        mixedLines.findIndex((l) => l.includes(sub));
      const aT = lineIdx("混合思考行");
      const aM = lineIdx("混合中间输出");
      const aTool = lineIdx("mixed-check");
      const aN = lineIdx("混合 notice 提示");
      const aSum = lineIdx("混合最终总结");
      // 活动区分隔行（左列全 ─）：混合内容在分隔行后按时间顺序同屏
      const mixedSepIdx = mixedLines.findIndex(
        (l, i) => i > 1 && /^─+$/.test(l.slice(0, 40).trim()),
      );
      const sepBefore = (i: number): boolean => i >= 0 && i > mixedSepIdx;
      // 排列方式为 auto（上下/左右随几何选择）：只断言活动条目的**时间顺序**与总结落位；
      // 上下排列时另有活动区分隔行（mixedSepIdx），左右排列时该行不存在（=-1）
      ok(
        "activity-mixed-ordered",
        aT >= 0 &&
          aM > aT &&
          aTool > aM &&
          aN > aTool &&
          aSum >= 0 &&
          (mixedSepIdx < 0 || aSum < mixedSepIdx),
        "idx=" + [aT, aM, aTool, aN, aSum, mixedSepIdx].join(","),
      );
      // /preset 无参：读目录 → 打开状态选项面板（标题 + agent 预设选项）
      typeLine("/preset");
      await sleep(400);
      const presNoArgPlain = smokeOut.replace(/\x1b\[[0-9;]*m/g, "");
      ok(
        "preset-catalog",
        presNoArgPlain.includes("/preset agent 预设") &&
          presNoArgPlain.includes("code-review") &&
          presNoArgPlain.includes("[Enter]提交"),
        "no /preset status panel in frames",
      );
      renderer.emitKey(key("escape")); // 关闭面板
      await sleep(100);

      // C 阶段：/policy 审批策略。启动注入 approval/policy(ask) → 状态栏 ask 徽标；
      // `/policy never` → notice + mock 回发 approval/policy(never) → 徽标变 auto
      // ask 生效时 policy 行文本恒为 "policy ask auto"，当前项以绿色高亮——
      // 用 raw 帧的绿色 SGR（dark #61D383）断言 ask 为生效项（区分色而非文本）
      ok(
        "policy-badge-ask",
        smokeOut.includes(smokeSgr("yellow") + ICON.ask),
        "no yellow ask icon in the title bar",
      );
      typeLine("/policy never");
      await sleep(400);
      const policyPlain = smokeOut.replace(/\x1b\[[0-9;]*m/g, "");
      ok(
        "policy-command-call",
        adapter.setApprovalPolicyCalls === 1 && adapter.lastPolicy === "never",
        "setApprovalPolicyCalls=" +
          adapter.setApprovalPolicyCalls +
          " last=" +
          String(adapter.lastPolicy),
      );
      ok(
        "policy-notice",
        flatFrames().includes("审批策略：never（工具调用自动放行）"),
        "no /policy never notice in frames",
      );
      ok(
        "policy-badge-never",
        smokeOut.includes(smokeSgr("green") + ICON.never),
        "no green never icon in the title bar after /policy never",
      );
      // P3：/preset 命令 + /jobs 面板 + 状态栏预设/任务徽标（mock 已实现新写路径）
      typeLine("/preset code-review");
      await sleep(400);
      const presetPlain = smokeOut.replace(/\x1b\[[0-9;]*m/g, "");
      ok(
        "preset-select-call",
        adapter.selectPresetCalls >= 1 && adapter.lastPreset === "code-review",
        "selectPresetCalls=" +
          adapter.selectPresetCalls +
          " last=" +
          adapter.lastPreset,
      );
      ok(
        "preset-notice",
        // 通知整串（`agent 预设：已切换为 code-review`）在 80 列下会被 pane 宽折行，
        // 且左右排列时两半之间夹着另一 pane 的行文本（无法拼接）→ 断言可容纳的前缀片段
        flatFrames().includes("agent预设：已切换为") &&
          flatFrames().includes("code-review"),
        "no /preset notice fragment in frames",
      );
      ok(
        "preset-badge",
        presetPlain.includes(ICON.preset + " code-review"),
        "no preset icon+name in the title bar",
      );
      // /jobs 面板：打开 → refreshJobs 拉取 → 任务状态行（标题 + label + 徽标计数）；Esc 关闭
      typeLine("/jobs");
      await sleep(400);
      const jobsPlain = smokeOut.replace(/\x1b\[[0-9;]*m/g, "");
      ok(
        "jobs-panel",
        jobsPlain.includes("后台任务") &&
          jobsPlain.includes("● running run tests") &&
          jobsPlain.includes("✓ done build demo"),
        "jobs panel rows absent from frames",
      );
      // 面板默认高亮 index0（subprocess-1 running）→ Enter 走 killJob 取消该任务
      renderer.emitKey(key("enter"));
      await sleep(300);
      ok(
        "jobs-kill",
        adapter.killJobCalls >= 1 && adapter.lastKillId === "subprocess-1",
        "killJobCalls=" + adapter.killJobCalls + " last=" + adapter.lastKillId,
      );
      renderer.emitKey(key("escape"));
      await sleep(200);
      console.error(
        "SMOKE_OK sent=" +
          JSON.stringify(sent) +
          " interrupts=" +
          adapter.interrupts,
      );
      typeLine("/quit");
    })().catch((err) => {
      console.error("SMOKE_ERROR " + String(err));
      process.exitCode = 1;
    });
  }, 150);
}
