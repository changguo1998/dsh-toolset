#!/usr/bin/env node
// bin/dsh-tui.js — dsh-tui 双态启动器（delegating launcher）
//
// 双态判定与社区 @deepseek-harness-tui/dsh-tui bin 同构（零第三方依赖）：
//   - 目标 profile 存在（$DSH_HOME/profiles/<profile> 且其 dsh-tui bundle 已
//     安装于 node_modules/@dsh-toolset/dsh-tui）→ spawn `dsh --profile <profile>`，
//     argv 与退出码原样透传（真实链路：profile 树内 apply(ctx) 建 agent）。
//   - 无 DSH / 无该 profile / `--demo` → 退化为 mock demo（renderer+app+
//     mock adapter 走通全栈，纯本地演示，不触碰 DSH）。
//
// 零 lib 依赖是启动器的迁移契约：本文件只基于 node:child_process / node:fs / node:url。

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE = process.env.DSH_TUI_PROFILE ?? "dsh-toolset-tui";
const PACKAGE = "@dsh-toolset/dsh-tui";
const OWN_NAME = "@dsh-toolset/dsh-tui";

/** 目标 profile 的 dsh-tui bundle 是否已安装（包目录 + name 匹配 + bin 存在） */
function profileBundleReady() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const pkgDir = join(home, "profiles", PROFILE, "node_modules", PACKAGE);
  const pkg = join(pkgDir, "package.json");
  const bin = join(pkgDir, "bin", "dsh-tui.js");
  if (!existsSync(pkg) || !existsSync(bin)) return false;
  try {
    // 仅校验 name——避免半安装/占位目录被判为已就绪
    return JSON.parse(readFileSync(pkg, "utf8")).name === OWN_NAME;
  } catch {
    return false;
  }
}

/** 委托：argv 透传给 `dsh --profile <p>`，退出码/信号跟随子进程 */
function delegate(args) {
  const child = spawn("dsh", ["--profile", PROFILE, ...args], {
    stdio: "inherit",
    shell: false,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    process.stderr.write(
      "[dsh-tui] 委托 dsh 失败: " + String(err.message) + "\n",
    );
    process.exit(1);
  });
}

/** 无 DSH 退化：mock demo（异步启动，生命周期交 renderer） */
async function demo() {
  const { createRenderer } = await import("../dist/src/renderer/index.js");
  const { App } = await import("../dist/src/app/index.js");
  const { createMockDshAdapter } = await import("../dist/demo/mockAdapter.js");
  const app = new App({
    renderer: createRenderer(),
    adapter: createMockDshAdapter(),
  });
  app.start();
}

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "--demo") {
  void demo();
} else if (cmd === "--help" || cmd === "-h") {
  process.stdout.write(
    [
      "dsh-tui — DSH (DeepSeek Harness) 进程内集成终端 UI",
      "",
      "用法:",
      "  dsh-tui                        双态启动:有可用 profile 则委托真实链路,否则 mock demo",
      "  dsh-tui --demo                强制 mock demo(无 DSH 依赖)",
      "  dsh-tui --help                本帮助",
      "",
      "环境:",
      `  DSH_HOME       (当前 ${process.env.DSH_HOME ?? join(homedir(), ".dsh")})`,
      `  DSH_TUI_PROFILE(当前 ${PROFILE})`,
    ].join("\n") + "\n",
  );
} else if (profileBundleReady()) {
  delegate(args);
} else {
  void demo();
}
