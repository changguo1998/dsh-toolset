// demo/main.ts — demo 入口：mock adapter 喂数据，走通 renderer→app 全栈
//
// 独立入口，无 DSH 依赖。构建后运行 dist/demo/main.js。
// 无 TTY（管道/CI 等）或带 --smoke 时自动走冒烟脚本：合成按键驱动并自断言
// 新输入交互（! 为普通字符 / $ 切模式 + shell 提交左提示符 $ / 空输入 Backspace
// 回退 / Alt+Enter 打断并发送 / Esc idle 无操作 / 审批弹窗 Esc 不打断不关闭），
// 产出 SMOKE_* 证据后 /quit 以退出码 0 收尾，便于无头环境演示与机械验证。

import { createRenderer, type KeyEvent } from "../src/renderer/index.ts";
import { App } from "../src/app/index.ts";
import { createProcessStatusQueries } from "../src/app/status.ts";
import { createMockDshAdapter, type MockDshAdapter } from "./mockAdapter.ts";

const renderer = createRenderer();
const adapter: MockDshAdapter = createMockDshAdapter({
  autoApproval: false, // 冒烟由脚本显式驱动审批弹窗，避免 timing 干扰
}) as MockDshAdapter;

const app = new App({
  renderer,
  adapter,
  status: { queries: createProcessStatusQueries(), intervalMs: 5000 },
});
app.start();

// 退出路径交 renderer：/quit 命令、SIGINT/SIGTERM 信号或进程结束即可；此处不加额外逻辑。

// —— 冒烟模式（无 TTY 或显式 --smoke）：合成按键驱动 + 自断言，产出 SMOKE_* 证据 ——
const smoke = process.argv.includes("--smoke") || !process.stdin.isTTY;
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
      // 3. $ 切 shell 模式 + 提交 → 不加 $ 前缀发送 "ls"；随后左提示符应为 $
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
        sessionId: "s1",
        status: "idle",
      });
      await sleep(200);
      renderer.emitKey(key("escape"));
      await sleep(200);
      // 7. 审批弹窗：agent 活跃 + approval 打开时 Esc 不打断、不关闭；y 关闭
      adapter.emitEvent({
        type: "agent-status",
        sessionId: "s1",
        status: "tool",
      });
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
        "prompt-shell-left",
        plain.includes("$> "),
        "no '$> ' left-prompt in frames",
      );
      ok(
        "approval-rendered",
        plain.includes("允许执行?"),
        "approval text absent from frames",
      );

      // 问答面板断言：提交整批（含第 2 题自定义 note）、取消走 cancelQuestion、Esc 不打断
      ok(
        "question-rendered",
        plain.includes("请回答（第"),
        "question panel title absent from frames",
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
