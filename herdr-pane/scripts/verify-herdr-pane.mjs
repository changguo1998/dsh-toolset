// scripts/verify-herdr-pane.mjs — 真机端到端验证脚本（人工跑，不进 CI）
//
// 为什么不进 CI：herdr 不保证存在，且真实验证会改动用户布局（建 / 关 pane）。单测覆盖参数面与
// 判定逻辑（`npm test`，注入 fake runner / fake reader），本脚本只补「真机行为对不对」这一层。
//
// 用法（必须在 herdr 管理的 pane 内跑，即 `HERDR_ENV=1`）：
//   npm run build && node scripts/verify-herdr-pane.mjs            # 全自动：跑完即关 pane
//   node scripts/verify-herdr-pane.mjs --keep                       # 跑完保留 pane 供人工看
//   node scripts/verify-herdr-pane.mjs --with-python                # 新 pane 里先起 python3 -i
//
// 验收对应关系（docs/implementation/2026-10-16-herdr-pane-design.md「验收」第 3 / 4 条）：
//   create → read → send_text → send_keys → wait(match) → wait(stable) → run → info → label → close，
//   期间不应抢走调用者 pane 的焦点（`--no-focus`），正常退出后 `herdr pane list` 无本次创建的 pane。
import { createHerdrPlugin, dispatchAction } from "../dist/src/index.js";

const args = new Set(process.argv.slice(2));
const keep = args.has("--keep");
const withPython = args.has("--with-python");

/** 逐步打印动作结果（失败即退出并保留现场，便于人工查）。 */
async function step(label, action, params, deps) {
  const result = await dispatchAction(action, params, deps);
  const head = result.ok ? "OK  " : "FAIL";
  console.log(`[${head}] ${label}`);
  if (!result.ok) {
    console.error(`        ${result.error.code}: ${result.error.message}`);
    if (result.error.hint !== undefined)
      console.error(`        ${result.error.hint}`);
    return result;
  }
  return result;
}

/** 断言（失败即抛，交顶层统一收尾）。 */
function expect(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

const plugin = createHerdrPlugin(
  // 脚本不需要宿主工具面：给一个只收 register 的最小 ctx
  { tools: { register() {} }, on: () => () => true },
  {},
  {},
);

if (plugin === undefined) {
  console.error(
    "[verify] 未启用：需要 herdr 环境（HERDR_ENV / HERDR_SOCKET_PATH / HERDR_PANE_ID）",
  );
  process.exit(1);
}

const { deps, config } = plugin;
let createdPaneId;
let failed = false;

try {
  console.log(
    `[verify] caller=${deps.callerPaneId} timeoutMs=${config.timeoutMs}，config=${JSON.stringify(
      {
        requireApproval: config.requireApproval,
        closeOnExit: config.closeOnExit,
        label: config.label,
      },
    )}`,
  );

  // 1) create：不抢焦点、显式 cwd，取 .result.pane.pane_id
  const created = await step("create", "create", {}, deps);
  if (!created.ok) throw new Error("create 失败，后续动作无目标 pane");
  createdPaneId = created.payload.pane_id;
  expect(
    typeof createdPaneId === "string" && createdPaneId !== "",
    "create 应返回 pane_id",
  );
  console.log(
    `        新 pane = ${createdPaneId}（direction=${created.payload.direction}）`,
  );

  // 2) read：socket 通道，拿到 revision / truncated
  const read = await step(
    "read（socket）",
    "read",
    {
      pane_id: createdPaneId,
      source: "visible",
      lines: 20,
    },
    deps,
  );
  expect(read.ok, "read 应成功");
  expect(
    typeof read.payload.revision === "number",
    "read 应带 revision（socket 独有）",
  );

  // 3) send_text：注入字面量（不回车）
  await step(
    "send_text",
    "send_text",
    {
      pane_id: createdPaneId,
      text: "printf 'herdr-pane-ready\\n'",
    },
    deps,
  );

  // 4) send_keys：回车提交（enter 是 herdr 的规范键名之一）
  await step(
    "send_keys（enter）",
    "send_keys",
    {
      pane_id: createdPaneId,
      keys: ["enter"],
    },
    deps,
  );

  // 5) wait(match)：等服务端在输出里看到标记
  const matched = await step(
    "wait（match）",
    "wait",
    {
      pane_id: createdPaneId,
      match: "herdr-pane-ready",
      lines: 40,
      timeout_ms: 10_000,
    },
    deps,
  );
  expect(matched.ok, "wait match 应命中");

  // 6) run：文本 + 回车一次提交
  await step(
    "run",
    "run",
    {
      pane_id: createdPaneId,
      command: "printf 'run-ok\\n'",
    },
    deps,
  );
  const runMatched = await step(
    "wait（run 回显）",
    "wait",
    {
      pane_id: createdPaneId,
      match: "run-ok",
      lines: 40,
      timeout_ms: 10_000,
    },
    deps,
  );
  expect(runMatched.ok, "run 的回显应可等");

  // 7) wait(stable)：静默判稳（走 socket 的 revision）
  const stable = await step(
    "wait（stable）",
    "wait",
    {
      pane_id: createdPaneId,
      stable: true,
      settle_ms: 400,
      timeout_ms: 10_000,
    },
    deps,
  );
  expect(stable.ok, "stable 应判稳");

  // 8) info：进程探活
  const info = await step("info", "info", { pane_id: createdPaneId }, deps);
  expect(info.ok, "info 应成功");

  // 9) label：改 / 清都验一次
  await step(
    "label（自定义）",
    "label",
    {
      pane_id: createdPaneId,
      label: "dsh-pane-verify",
    },
    deps,
  );
  await step("label（恢复缺省）", "label", { pane_id: createdPaneId }, deps);

  if (withPython) {
    // 交互式程序（REPL）：需要屏幕状态 + 按键时序的典型场景
    await step(
      "run（python3 -i）",
      "run",
      {
        pane_id: createdPaneId,
        command: "python3 -i",
      },
      deps,
    );
    const prompt = await step(
      "wait（python 提示符）",
      "wait",
      {
        pane_id: createdPaneId,
        regex: ">>>",
        lines: 40,
        timeout_ms: 15_000,
      },
      deps,
    );
    expect(prompt.ok, "python 提示符应出现");
    await step(
      "run（python 表达式）",
      "send_text",
      {
        pane_id: createdPaneId,
        text: "1+1",
      },
      deps,
    );
    await step(
      "send_keys（enter）",
      "send_keys",
      {
        pane_id: createdPaneId,
        keys: ["enter"],
      },
      deps,
    );
    await step(
      "wait（表达式结果）",
      "wait",
      {
        pane_id: createdPaneId,
        match: "2",
        lines: 20,
        timeout_ms: 10_000,
      },
      deps,
    );
    await step(
      "send_keys（ctrl+d 退出 python）",
      "send_keys",
      {
        pane_id: createdPaneId,
        keys: ["ctrl+d"],
      },
      deps,
    );
  }

  // 10) list：核对 label 与本插件登记标记
  const listed = await step("list", "list", {}, deps);
  expect(listed.ok, "list 应成功");
  const mine = listed.payload.panes.find(
    (pane) => pane.pane_id === createdPaneId,
  );
  expect(mine?.registered === true, "list 应把新 pane 标为本插件登记项");

  console.log("\n[verify] 动作面全部通过。对比基线：");
  console.log("  herdr pane list   → 应能看到本次创建的 pane 与它的 label");
  console.log("  调用者 pane 焦点未被抢走（--no-focus 生效）");
  if (keep) {
    console.log(
      `\n[--keep] pane ${createdPaneId} 保留，人工看完后手动 herdr pane close ${createdPaneId}`,
    );
  }
} catch (error) {
  failed = true;
  console.error(`\n[verify] 中断：${String(error)}`);
  console.error(`       本次创建的 pane：${createdPaneId ?? "（无）"}`);
} finally {
  if (createdPaneId !== undefined && !keep) {
    const closed = await step(
      "close（收尾）",
      "close",
      { pane_id: createdPaneId },
      deps,
    );
    if (!closed.ok) {
      console.error(
        `       收尾失败，请手动 herdr pane close ${createdPaneId}`,
      );
      failed = true;
    }
  }
  plugin.dispose();
}

process.exit(failed ? 1 : 0);
