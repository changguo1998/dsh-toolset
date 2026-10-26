// tests/layout-hang-guard.test.ts — 排版防死循环闸（生成语料 + 子进程超时）
//
// 背景（2026-10-27 真机卡死排查）：主线程被同步代码占死时，画面与 250ms 闪烁定时器一起停，
// 而 node:test 的超时只能打断异步挂起、打不断同步死循环。故本用例把生成语料丢进**子进程**
// 跑，父进程用 spawnSync 的 timeout 兜底：任一条内容形态触发同步死循环 → 子进程超时被杀 →
// 用例失败（stderr 里有「最后开始的那条」形态名，便于定位）。
//
// 语料维度：可用宽（含 1 / 2 / 奇数窄宽）× 内容形态（宽字符、零宽、emoji、竖线密集、
// 超宽单字符、缩进列表、代码围栏、表格 N 列）。除防死循环，同一趟还钉住单帧成本的宽松上界
// （本机实测各形态均 < 10ms，阈值取 1000ms 只抓「量级退化」，不做性能回归）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 子进程内的探测脚本（跑完全部语料；每例先打形态名，再断言单帧成本） */
// 脚本落在临时目录，源码导入一律用绝对路径（由父进程按仓库根拼好再注入）
const probeSource = (root: string): string => `
import { initialState, reduceState } from ${JSON.stringify(`${root}/src/app/state.ts`)};
import { buildFrame } from ${JSON.stringify(`${root}/src/app/layout.ts`)};
import { sectionsFromBuffer } from ${JSON.stringify(`${root}/src/app/layout/pipeline/replay.ts`)};

const WIDTHS = [1, 2, 3, 5, 17, 40, 80];
const FORMS = {
  cjk: () => "汉字宽度测试".repeat(20),
  zeroWidth: () => "a\\u200bb\\u0301c".repeat(200),
  emoji: () => "🙂✅❌🎯".repeat(30),
  pipes: () => "| " + Array.from({ length: 120 }, (_, i) => "c" + i).join(" | ") + " |",
  wideCharOnly: () => "漢".repeat(500),
  narrowList: () => Array.from({ length: 40 }, (_, i) => "  ".repeat(i % 3) + "- 项 " + i).join("\\n"),
  fence: () => Array.from({ length: 20 }, () => "\\u0060\\u0060\\u0060ts\\nconst a = 1;\\n\\u0060\\u0060\\u0060").join("\\n"),
  table: () => {
    const head = "| " + Array.from({ length: 40 }, (_, i) => "h" + i).join(" | ") + " |";
    const sep = "| " + Array.from({ length: 40 }, () => ":--:").join(" | ") + " |";
    return [head, sep, head].join("\\n");
  },
  longToken: () => "x".repeat(5000),
  // 回归（2026-10-27 真机卡死）：只有标记没有正文的行曾让 parse 列表分支原地打转
  bareBullet: () => "- 项一\\n-\\n*\\n1.\\n-\\u00a0\\n尾",
  // 嵌套列表（2026-10-27 起按缩进产层级）：深缩进 + 长项折行 + 标记混排
  nestedList: () => Array.from({ length: 8 }, (_, i) => "  ".repeat(i) + "- 第 " + i + " 层" + "字".repeat(12)).join("\\n"),
  quote: () => "> ".repeat(30) + "嵌套引用文本",
};

const SIZE_ROWS = 24;
let worst = 0;
for (const [name, make] of Object.entries(FORMS)) {
  for (const cols of WIDTHS) {
    process.stderr.write("case " + name + " w=" + cols + "\\n");
    const text = make();
    const sections = sectionsFromBuffer([{ text, kind: "assistant" }], { history: true });
    let s = reduceState(initialState(), { type: "pipeline-state", pipeline: sections });
    s = reduceState(s, { type: "thinking", text, segment: "thinking" });
    const t0 = performance.now();
    buildFrame(s, { cols, rows: SIZE_ROWS });
    const ms = performance.now() - t0;
    worst = Math.max(worst, ms);
    if (ms > 1000) {
      console.error("SLOW " + name + " w=" + cols + " " + ms.toFixed(0) + "ms");
      process.exit(2);
    }
  }
}
console.log("worst=" + worst.toFixed(1) + "ms");
`;

test("生成语料 × 窄宽：排版不死循环、单帧成本有上界（子进程兜底超时）", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-hang-guard-"));
  const probe = join(dir, "probe.mts");
  writeFileSync(probe, probeSource(process.cwd()), "utf8");
  try {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", probe],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000, // 兜底：同步死循环会卡到超时被杀
      },
    );
    if (r.error !== undefined) {
      const last =
        (r.stderr ?? "").trim().split("\n").filter(Boolean).pop() ?? "(无)";
      assert.fail(
        `排版子进程未在 60s 内结束（疑似同步死循环），最后开始：${last}（${r.error.message}）`,
      );
    }
    assert.equal(
      r.status,
      0,
      `排版子进程失败（退出码 ${r.status}）：${(r.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`,
    );
    assert.match(r.stdout ?? "", /worst=[\d.]+ms/, "应打印单帧成本上界");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
