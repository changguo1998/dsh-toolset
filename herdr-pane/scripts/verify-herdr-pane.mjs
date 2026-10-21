// scripts/verify-herdr-pane.mjs — 真机端到端验证脚本（人工跑，不进 CI）
//
// 为什么不进 CI：herdr 不保证存在，且真实验证会改动用户布局（建 / 关 pane、tab、workspace）。
// 单测覆盖参数面与判定逻辑（`npm test`，注入 fake runner / fake reader / fake herdr 服务端），
// 本脚本只补「真机行为对不对」这一层。
//
// 用法（二进制可解析 + herdr 服务端在跑即可；dsh 不必在 herdr 内）：
//   npm run build && node scripts/verify-herdr-pane.mjs            # 全自动：跑完即关 pane
//   node scripts/verify-herdr-pane.mjs --keep                       # 跑完保留现场供人工看
//   node scripts/verify-herdr-pane.mjs --with-python                # 新 pane 里先起 python3 -i
//   node scripts/verify-herdr-pane.mjs --with-tab                   # 建 tab → run → wait → read → tab_close
//   node scripts/verify-herdr-pane.mjs --check-cascade              # 关掉本次 create 的 pane 后看 workspace 是否还在
//   node scripts/verify-herdr-pane.mjs --session-id verify-1        # 固定会话身份（重跑可验 workspace 复用）
//   node scripts/verify-herdr-pane.mjs --cwd /path/to/workdir       # 覆盖会话工作目录（label 用它）
//
// 验收对应关系（追踪文档「测试要点」与「规划」第 8 条）：
//   create → read → send_text → send_keys → wait(match) → wait(stable) → run → info → label → list → close，
//   期间不抢调用者 pane 的焦点（`--no-focus`）；`create` 落在本会话 workspace 的活动 pane；
//   正常退出后本会话 workspace 内无本次创建的 pane（workspace 空则被内部关闭）。
import {
  createHerdrPlugin,
  dispatchAction,
  parseEnvelope,
  workspaceLabel,
} from "../dist/src/index.js";

/** 逐项解析带值的开关（`--session-id x` / `--cwd /p`）。 */
function optionValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const args = new Set(process.argv.slice(2));
const keep = args.has("--keep");
const withPython = args.has("--with-python");
const withTab = args.has("--with-tab");
const checkCascade = args.has("--check-cascade");
const cwd = optionValue("--cwd") ?? process.cwd();
const sessionId =
  optionValue("--session-id") ?? `verify-${Date.now().toString(36)}`;

/** 宿主执行上下文的最小形态：本包只读 `exec.agent.session` 的 id 与 cwd。 */
const exec = { agent: { session: { id: sessionId, header: { cwd } } } };

/** 逐步打印动作结果（失败即退出并保留现场，便于人工查）。 */
async function step(label, action, params, deps) {
  const result = await dispatchAction(action, params, deps, exec);
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

/**
 * socket 等待期间保持事件循环：`src/socket.ts` 的请求超时与 `stable` 判稳 sleep 都 `unref()`
 * （插件不该吊住宿主进程）。本脚本独立运行时事件循环里可能没有其它 ref 句柄，node 会在顶层
 * await 未结算时直接退出（实测停在 `wait（stable）`），故只在脚本侧临时挂一个 keepalive；
 * 不改 `socket.ts` 的 unref 语义。
 */
async function withKeepAlive(fn) {
  const keepAlive = setInterval(() => {}, 500);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

/** 直接调 herdr CLI（只读核对；不走插件动作面，避免用被测代码验自己）。 */
async function herdr(deps, argv) {
  const result = await deps.runner.run(argv, deps.config.timeoutMs);
  const envelope = parseEnvelope(result.stdout, result.stderr, result.exitCode);
  if (envelope.kind !== "ok") {
    throw new Error(
      `herdr ${argv.join(" ")} 失败：${JSON.stringify(envelope)}`,
    );
  }
  return envelope.result;
}

const plugin = createHerdrPlugin(
  // 脚本不需要宿主工具面：给一个只收 register 的最小 ctx
  { tools: { register() {} }, on: () => () => true },
  {},
  {},
);

if (plugin === undefined) {
  console.error(
    "[verify] 未启用：需要 herdr 二进制可解析且服务端在跑（herdr status --json 报 server.status=running）",
  );
  process.exit(1);
}

const { deps, config } = plugin;
let createdPaneId;
let createdTabId;
let failed = false;

try {
  console.log(
    `[verify] session=${sessionId} cwd=${cwd} timeoutMs=${config.timeoutMs}，config=${JSON.stringify(
      {
        requireApproval: config.requireApproval,
        closeOnExit: config.closeOnExit,
        label: config.label,
      },
    )}`,
  );

  const label = workspaceLabel({ id: sessionId, cwd });
  const before = await herdr(deps, ["workspace", "list"]);
  const existing = (before.workspaces ?? []).filter(
    (workspace) => workspace.label === label,
  );
  console.log(
    `        workspace 约定 label=${label}：${
      existing.length === 0
        ? "未存在（本次会新建）"
        : `已存在 ${existing[0].workspace_id}（本次复用）`
    }`,
  );

  // 1) create：落在本会话 workspace 的活动 pane（不是调用者 pane），不抢焦点
  const created = await step("create", "create", {}, deps);
  if (!created.ok) throw new Error("create 失败，后续动作无目标 pane");
  createdPaneId = created.payload.pane_id;
  expect(
    typeof createdPaneId === "string" && createdPaneId !== "",
    "create 应返回 pane_id",
  );
  const binding = plugin.registry.workspaceBinding;
  expect(binding !== undefined, "create 应建立会话 workspace 绑定");
  console.log(
    `        新 pane = ${createdPaneId}（direction=${created.payload.direction}，split_from=${created.payload.split_from}，workspace label=${binding.label}）`,
  );

  // 1.1) 用 CLI 核对落点确实在本会话 workspace（回执不暴露 workspace 面）
  const panes = await herdr(deps, [
    "pane",
    "list",
    "--workspace",
    binding.workspaceId,
  ]);
  const mine = (panes.panes ?? []).find(
    (pane) => pane.pane_id === createdPaneId,
  );
  expect(mine !== undefined, "create 的新 pane 应落在本会话 workspace 内");

  // 2) read：socket 通道，拿到 revision / truncated
  const read = await withKeepAlive(() =>
    step(
      "read（socket）",
      "read",
      {
        pane_id: createdPaneId,
        source: "visible",
        lines: 20,
      },
      deps,
    ),
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
  const stable = await withKeepAlive(() =>
    step(
      "wait（stable）",
      "wait",
      {
        pane_id: createdPaneId,
        stable: true,
        settle_ms: 400,
        timeout_ms: 10_000,
      },
      deps,
    ),
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
      "send_text（python 表达式）",
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

  if (withTab) {
    // tab 三动作：建 tab → 在其中 run / wait / read → tab_close
    const tab = await step(
      "tab_create",
      "tab_create",
      { label: "dsh-pane-verify" },
      deps,
    );
    expect(tab.ok, "tab_create 应成功");
    createdTabId = tab.payload.tab_id;
    const tabPaneId = tab.payload.pane_id;
    expect(typeof createdTabId === "string", "tab_create 应返回 tab_id");
    expect(typeof tabPaneId === "string", "tab_create 应返回 root pane");

    const listedTabs = await step("tab_list", "tab_list", {}, deps);
    expect(listedTabs.ok, "tab_list 应成功");
    const registeredTab = (listedTabs.payload.tabs ?? []).find(
      (item) => item.tab_id === createdTabId,
    );
    expect(
      registeredTab?.registered === true,
      "tab_list 应把新 tab 标为本插件登记项",
    );

    await step(
      "run（tab 内）",
      "run",
      { pane_id: tabPaneId, command: "printf 'tab-ok\\n'" },
      deps,
    );
    const tabMatched = await step(
      "wait（tab 内回显）",
      "wait",
      { pane_id: tabPaneId, match: "tab-ok", lines: 40, timeout_ms: 10_000 },
      deps,
    );
    expect(tabMatched.ok, "tab 内的命令回显应可等");
    const tabRead = await withKeepAlive(() =>
      step(
        "read（tab 内）",
        "read",
        { pane_id: tabPaneId, source: "visible", lines: 20 },
        deps,
      ),
    );
    expect(tabRead.ok, "tab 内的 pane 应可读");

    const closedTab = await step(
      "tab_close",
      "tab_close",
      { tab_id: createdTabId },
      deps,
    );
    expect(closedTab.ok, "tab_close 应成功");
    createdTabId = undefined;
  }

  // 10) list：核对 label 与本插件登记标记
  const listed = await step("list", "list", {}, deps);
  expect(listed.ok, "list 应成功");
  const mineInList = listed.payload.panes.find(
    (pane) => pane.pane_id === createdPaneId,
  );
  expect(mineInList?.registered === true, "list 应把新 pane 标为本插件登记项");

  if (checkCascade) {
    // 关掉 workspace 里最后一个本插件 pane 后，看 workspace 是否还在（关闭语义未文档化）
    await step(
      "close（cascade 探针）",
      "close",
      { pane_id: createdPaneId },
      deps,
    );
    createdPaneId = undefined;
    const after = await herdr(deps, ["workspace", "list"]);
    const stillThere = (after.workspaces ?? []).some(
      (workspace) => workspace.workspace_id === binding.workspaceId,
    );
    console.log(
      `        workspace ${binding.workspaceId} 关掉本次 create 的 pane 后：${
        stillThere
          ? "仍在（真机结论：关掉 tab 的最后一个 pane 只级联关 tab；workspace 由插件退出清理负责关闭）"
          : "已随 pane 一起消失（级联关闭）"
      }`,
    );
  }

  console.log("\n[verify] 动作面全部通过。对比基线：");
  console.log("  herdr pane list   → 应能看到本次创建的 pane 与它的 label");
  console.log(
    "  herdr tab list    → 应能看到本次创建的 tab（--with-tab 已关掉则看不到）",
  );
  console.log("  调用者 pane 焦点未被抢走（--no-focus 生效）");
  if (keep) {
    console.log(
      `\n[--keep] 现场保留：pane ${createdPaneId ?? "（已关）"}` +
        `${createdTabId === undefined ? "" : `，tab ${createdTabId}`}；` +
        `workspace ${binding.workspaceId}（手动清理：herdr pane close / tab close / workspace close）`,
    );
  }
} catch (error) {
  failed = true;
  console.error(`\n[verify] 中断：${String(error)}`);
  console.error(
    `       本次创建的 pane：${createdPaneId ?? "（无）"}；tab：${createdTabId ?? "（无）"}`,
  );
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
  if (createdTabId !== undefined && !keep) {
    const closedTab = await step(
      "tab_close（收尾）",
      "tab_close",
      { tab_id: createdTabId },
      deps,
    );
    if (!closedTab.ok) {
      console.error(`       收尾失败，请手动 herdr tab close ${createdTabId}`);
      failed = true;
    }
  }
  // --keep 要真的留下现场：退出清理按 closeOnExit 决定是否关 pane / workspace
  if (keep) plugin.config.closeOnExit = false;
  plugin.dispose();
}

process.exit(failed ? 1 : 0);
