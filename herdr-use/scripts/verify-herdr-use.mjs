// scripts/verify-herdr-use.mjs — 真机端到端验证脚本（人工跑，不进 CI）
//
// 为什么不进 CI：herdr 不保证存在，且真实验证会改动用户布局（建 / 关 tab、workspace）。
// 单测覆盖参数面与判定逻辑（`npm test`，注入 fake runner / fake reader / fake herdr 服务端），
// 本脚本只补「真机行为对不对」这一层。
//
// 用法（二进制可解析 + herdr 服务端在跑即可；dsh 不必在 herdr 内）：
//   npm run build && node scripts/verify-herdr-use.mjs          # 前台全自动：跑完即关终端
//   node scripts/verify-herdr-use.mjs --keep                     # 跑完保留现场供人工看
//   node scripts/verify-herdr-use.mjs --with-python              # 额外验 python3 -i 的 REPL 场景
//   node scripts/verify-herdr-use.mjs --background               # 额外验 foreground:false（dshbg session）
//   node scripts/verify-herdr-use.mjs --check-cascade            # 关掉本次终端后看 workspace 是否还在
//   node scripts/verify-herdr-use.mjs --session-id verify-1      # 固定会话身份（重跑可验 workspace 复用）
//   node scripts/verify-herdr-use.mjs --cwd /path/to/workdir     # 覆盖会话工作目录（label 用它）
//
// 验收链（对应追踪文档「验收」）：
//   herdr_create → herdr_read → herdr_text + herdr_key(enter) → herdr_wait(match) → herdr_run
//   → herdr_wait(match) → herdr_wait(stable) → herdr_info → herdr_label → herdr_list → herdr_close；
//   可选后台终端（foreground:false）走同一条链；正常退出后本次创建的终端全部关闭。
import {
  createHerdrPlugin,
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
const withBackground = args.has("--background");
const checkCascade = args.has("--check-cascade");
const cwd = optionValue("--cwd") ?? process.cwd();
const sessionId =
  optionValue("--session-id") ?? `verify-${Date.now().toString(36)}`;

/** 会话上下文：服务面末参支持 exec / { session } / { id, cwd } 三种形态，这里用第三种。 */
const context = { id: sessionId, cwd };

/** 断言（失败即抛，交顶层统一收尾）。 */
function expect(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

/** 逐步打印服务面结果（失败即抛）。 */
async function step(label, call) {
  const result = await call();
  console.log(`[${result.ok ? "OK  " : "FAIL"}] ${label}`);
  if (!result.ok) {
    console.error(`        ${result.error.code}: ${result.error.message}`);
    if (result.error.hint !== undefined)
      console.error(`        ${result.error.hint}`);
    throw new Error(`${label} 失败`);
  }
  return result;
}

/**
 * socket 等待期间保持事件循环：`src/socket.ts` 的请求超时与 `stable` 判稳 sleep 都 `unref()`
 * （插件不该吊住宿主进程）。本脚本独立运行时事件循环里可能没有其它 ref 句柄，node 会在顶层
 * await 未结算时直接退出，故只在脚本侧临时挂一个 keepalive。
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

const { deps, config, service } = plugin;
/** 本次创建的终端（收尾用）。 */
const created = [];
let failed = false;

/** 建终端并登记到收尾清单。 */
async function createTerminal(label, foreground) {
  const result = await step(`herdr_create（${label}）`, () =>
    service.create({ label, foreground }, context),
  );
  const id = String(result.payload.terminal_id);
  created.push(id);
  expect(
    result.payload.foreground === foreground,
    "create 回执的 foreground 应与入参一致",
  );
  return id;
}

/** 跑一条命令并等回显。 */
async function runAndWait(id, command, marker, timeoutMs = 10_000) {
  await step(`herdr_run（${marker}）`, () => service.run(id, command, context));
  const matched = await step(`herdr_wait（${marker}）`, () =>
    service.wait(id, { match: marker, lines: 40, timeoutMs }, context),
  );
  expect(matched.payload.matched === true, `${marker} 应命中`);
}

try {
  console.log(
    `[verify] session=${sessionId} cwd=${cwd} timeoutMs=${config.timeoutMs}，config=${JSON.stringify(
      { closeOnExit: config.closeOnExit, label: config.label },
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

  // 1) create：新 tab + 自带 root pane；terminal_id = root pane id
  const terminalId = await createTerminal("verify-fg", true);

  // 2) read：socket 通道，拿到 revision / truncated
  const read = await withKeepAlive(() =>
    step("herdr_read（socket）", () =>
      service.read(terminalId, { source: "visible", lines: 20 }, context),
    ),
  );
  expect(typeof read.payload.text === "string", "read 应返回文本");
  expect(
    typeof read.payload.revision === "number",
    "read 应带 revision（socket 独有）",
  );

  // 3) text + key(enter)：注入字面量，再单独回车
  await step("herdr_text", () =>
    service.text(terminalId, "printf 'verify-ok\\n'", context),
  );
  await step("herdr_key（enter）", () =>
    service.key(terminalId, ["enter"], context),
  );
  const matched = await step("herdr_wait（match）", () =>
    service.wait(
      terminalId,
      { match: "verify-ok", lines: 40, timeoutMs: 10_000 },
      context,
    ),
  );
  expect(matched.payload.matched === true, "send_text 的回显应可等");

  // 4) run：文本 + 回车一次提交
  await runAndWait(terminalId, "printf 'run-ok\\n'", "run-ok");

  // 5) stable：静默判稳（走 socket 的 revision）
  const stable = await withKeepAlive(() =>
    step("herdr_wait（stable）", () =>
      service.wait(
        terminalId,
        { stable: true, settleMs: 400, timeoutMs: 15_000 },
        context,
      ),
    ),
  );
  expect(stable.payload.stable === true, "屏内容应能判稳");

  // 6) info：进程探活
  const info = await step("herdr_info", () =>
    service.info(terminalId, context),
  );
  expect(info.payload.running === false, "停在 shell 提示符时应无前台进程");

  // 7) label：tab 标题与 pane label 同步
  await step("herdr_label", () =>
    service.label(terminalId, "verify-renamed", context),
  );

  // 8) list：本插件登记标记 + 前台标记
  const listed = await step("herdr_list", () => service.list(context));
  const mine = listed.payload.terminals.find(
    (row) => row.terminal_id === terminalId,
  );
  expect(mine?.registered === true, "list 应把新终端标为本插件登记项");
  expect(mine?.foreground === true, "list 应标前台终端");

  if (withPython) {
    await step("herdr_run（python3 -i）", () =>
      service.run(terminalId, "python3 -i", context),
    );
    await step("herdr_wait（python 提示符）", () =>
      service.wait(
        terminalId,
        { regex: ">>>", lines: 40, timeoutMs: 15_000 },
        context,
      ),
    );
    await step("herdr_text（python 表达式）", () =>
      service.text(terminalId, "1+1", context),
    );
    await step("herdr_key（enter）", () =>
      service.key(terminalId, ["enter"], context),
    );
    await step("herdr_wait（表达式结果）", () =>
      service.wait(
        terminalId,
        { match: "2", lines: 20, timeoutMs: 10_000 },
        context,
      ),
    );
    await step("herdr_key（ctrl+d）", () =>
      service.key(terminalId, ["ctrl+d"], context),
    );
  }

  if (withBackground) {
    const bgId = await createTerminal("verify-bg", false);
    await runAndWait(bgId, "printf 'bg-ok\\n'", "bg-ok");
    const bgList = await step("herdr_list（后台）", () =>
      service.list(context),
    );
    const bgRow = bgList.payload.terminals.find(
      (row) => row.terminal_id === bgId,
    );
    expect(
      bgRow?.foreground === false,
      "后台终端应在 list 里标 foreground:false",
    );
    await step("herdr_close（后台）", () => service.close(bgId, context));
    created.pop();
  }

  if (checkCascade) {
    const after = await herdr(deps, ["workspace", "list"]);
    const binding = plugin.registry.bindingsOf(sessionId)[0];
    const stillThere =
      binding !== undefined &&
      (after.workspaces ?? []).some(
        (workspace) => workspace.workspace_id === binding.workspaceId,
      );
    console.log(
      `        workspace 在本次终端关闭前仍在：${
        stillThere ? "是" : "否"
      }（关掉最后一个终端后由退出清理决定是否关闭）`,
    );
  }

  console.log("\n[verify] 终端面全部通过。对比基线：");
  console.log("  herdr tab list    → 应能看到已改名的终端 tab（--keep 时）");
  console.log("  调用者 pane 焦点未被抢走（--no-focus 生效）");
} catch (error) {
  failed = true;
  console.error(`\n[verify] 中断：${String(error)}`);
  console.error(`       本次创建的终端：${created.join(", ") || "（无）"}`);
} finally {
  if (!keep) {
    for (const id of created) {
      const result = await service.close(id, context);
      if (!result.ok) {
        console.error(`       收尾失败，请手动关闭终端 ${id}`);
        failed = true;
      }
    }
  }
  // --keep 要真的留下现场：退出清理按 closeOnExit 决定是否关终端 / workspace
  if (keep) plugin.config.closeOnExit = false;
  plugin.dispose();
}

process.exit(failed ? 1 : 0);
