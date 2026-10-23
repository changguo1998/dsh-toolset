#!/usr/bin/env node
/**
 * scripts/verify-coagent.mjs — coagent 的真机自检（人工跑，不进 CI）。
 *
 * 本脚本只做**能自动化的部分**：前置条件、本地守门断言、人工步骤清单。
 * 拉起 / 认领 / 交接 / 收尾必须在挂载了 coagent 的 dsh 会话里经工具调用完成 —— 脚本没有
 * 跨进程调用模型工具的通路，故不假装跑通全链（诚实边界见 README「验证」）。
 *
 * 用法：
 *   npm run verify              # 前置条件 + 本地守门断言 + 人工步骤
 *   npm run verify -- --negative  # 额外强调负向用例（cwd 非法 / target 被拒）
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const lines = [];

function ok(message) {
  lines.push(`✓ ${message}`);
}

function fail(message) {
  failures.push(message);
  lines.push(`✗ ${message}`);
}

function info(message) {
  lines.push(`- ${message}`);
}

function shellBinary() {
  const shell = process.env["SHELL"] ?? "";
  return shell.includes("zsh") ? "zsh" : "bash";
}

/** 1. `fffdsh` 必须是登录 shell 里的函数（不是可执行文件）。 */
function checkFffdshFunction() {
  try {
    execFileSync(shellBinary(), ["-ic", "type fffdsh"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    ok("交互 shell 里能拿到 fffdsh 函数（type fffdsh）");
  } catch {
    fail(
      `交互 shell 里拿不到 fffdsh：${shellBinary()} -ic 'type fffdsh' 失败（终端的登录 shell 必须加载它）`,
    );
  }
}

/** 2. 终端的 shell 环境必须有 `*_API_KEY`（fffdsh 的前置检查）；只报名字，不打印值。 */
function checkApiKeyEnv() {
  let env = "";
  try {
    env = execFileSync(shellBinary(), ["-ic", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
  } catch {
    fail("读不到交互 shell 的环境变量（env 失败）");
    return;
  }
  const names = env
    .split("\n")
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*API_KEY=.+/.test(line))
    .map((line) => line.slice(0, line.indexOf("=")));
  if (names.length === 0) {
    fail("交互 shell 环境里没有 *_API_KEY（fffdsh 会在启动 dsh 之前就失败）");
    return;
  }
  ok(`交互 shell 环境里有 API key：${names.join(", ")}（只报名字）`);
}

/** 3. herdr CLI 可达（服务面由 herdr-use 持有，但排障与人工核对要用 CLI）。 */
function checkHerdrCli() {
  try {
    const path = execFileSync("sh", ["-c", "command -v herdr"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    ok(`herdr CLI 在 PATH 上：${path}`);
  } catch {
    fail("PATH 上没有 herdr CLI（herdr-use 的终端操作与人工核对都会不可用）");
  }
}

/** 4. 本地守门断言（不依赖真机；与单测同源但跑的是构建产物）。 */
async function checkLocalGuards(negative) {
  const distLaunch = join(root, "dist", "src", "launch.js");
  if (!existsSync(distLaunch)) {
    fail("未构建：先 npm run build（本脚本断言的是 dist 产物）");
    return;
  }
  const launch = await import(pathToFileURL(distLaunch).href);

  if (launch.LAUNCH_COMMAND !== "fffdsh") {
    fail(`拉起命令不是 fffdsh：${launch.LAUNCH_COMMAND}`);
  } else {
    ok("拉起命令固定为 fffdsh（白名单）");
  }

  if (launch.checkForegroundText("fffdsh").ok !== true) {
    fail("正常命令 fffdsh 被守门误拒");
  }
  for (const text of [
    "nohup fffdsh &",
    "setsid fffdsh",
    "fffdsh &",
    "fffdsh; disown",
    "bg fffdsh",
    "screen -dm fffdsh",
    "tmux new -d fffdsh",
  ]) {
    if (launch.checkForegroundText(text).ok !== false) {
      fail(`脱管痕迹未被拒绝：${text}`);
    }
  }
  ok("脱管痕迹（nohup / setsid / & / disown / bg / screen / tmux）一律拒");

  const target = launch.parseSpawnArgs({ target: "tab" });
  if (target.ok !== false || !/target/.test(target.reason)) {
    fail("已删除的 target 参数未被拒绝");
  } else {
    ok("spawn 的 target 参数已删除（传入即 invalid_params）");
  }

  const missing = await launch.checkCwd("/definitely/not/a/coagent-dir");
  if (missing.ok !== false) {
    fail("不存在的 cwd 未被拒绝");
  } else {
    ok("cwd 必须是存在且可访问的目录");
  }

  if (negative) {
    const extra = launch.parseSpawnArgs({ task: "写报告" });
    if (extra.ok !== false || !/channel_delegate/.test(extra.next ?? "")) {
      fail("task 参数未被拒绝或未指路 channel_delegate");
    } else {
      ok("负向：task 参数被拒并指路 channel_delegate");
    }
  }
}

function printManualSteps() {
  lines.push("");
  lines.push(
    "人工步骤（在挂载了 coagent 的 dsh 会话里执行；脚本无法跨进程调模型工具）：",
  );
  lines.push(
    '  1. coagent spawn({cwd:"<仓库根>"}) → 记下 terminal_id / session_id；',
  );
  lines.push("  2. session_channel peers → session_id 在线，且与父会话不同；");
  lines.push(
    "  3. herdr_list → 能看到 label 为 coagent/<id> 且 registered:true 的终端；",
  );
  lines.push(
    "  4. herdr_read({terminal_id}) 能看到 dsh 界面；herdr_text 能插一句话；",
  );
  lines.push(
    "  5. channel_delegate({to: session_id, ...}) → channel_task status 到终态；",
  );
  lines.push(
    "  6. coagent list → ready；coagent close → closed；herdr_list 无该 label；",
  );
  lines.push("  7. 残留核对：不存在带 coagent/ 前缀却不在记录里的终端。");
  lines.push("");
  lines.push(
    "未验证项（本脚本不覆盖）：真机 create / run / read / info / close 的回执形状、fffdsh 真正拉起后的认领时序。",
  );
}

checkFffdshFunction();
checkApiKeyEnv();
checkHerdrCli();
await checkLocalGuards(process.argv.includes("--negative"));
printManualSteps();

console.log(lines.join("\n"));
if (failures.length > 0) {
  console.error(
    `\n${failures.length} 项前置/守门检查未通过，全链验证不能开始。`,
  );
  process.exitCode = 1;
} else {
  console.log(
    "\n前置条件与本地守门检查通过；按上面的步骤在 dsh 会话里跑全链。",
  );
}
