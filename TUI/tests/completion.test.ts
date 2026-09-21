// tests/completion.test.ts — 命令输入补全单测（纯函数层）
//
// 覆盖：命令 token 判定（含 slash 模式下无前导 `/` 的归一）、前缀匹配与排序
// （items[0]=最匹配）、宿主命令并入与去重、候选全量（不设硬上限，面板按可视行截断）、
// 面板渲染（默认高亮/行数）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completeCommandInput,
  isCommandTokenInput,
  LOCAL_COMMANDS,
} from "../src/app/commands.ts";
import { renderCommandCompletion } from "../src/app/components/CommandCompletion.ts";
import { displayWidth } from "../src/app/layout.ts";
import { rowAnsi } from "./helpers/rowText.ts";

const names = (items: { name: string }[] | undefined): string[] =>
  (items ?? []).map((i) => i.name);

test("isCommandTokenInput：仅字面 `/` 开头的单个命令 token", () => {
  assert.equal(isCommandTokenInput("/"), true);
  assert.equal(isCommandTokenInput("/mo"), true);
  assert.equal(isCommandTokenInput("/MO"), true);
  assert.equal(isCommandTokenInput("/clear_screen-2"), true);
  // 带参数 / 多 token / 非命令首字符 / 反斜杠
  assert.equal(isCommandTokenInput("/mo x"), false);
  assert.equal(isCommandTokenInput("/mo\n"), false);
  assert.equal(isCommandTokenInput("mo"), false);
  assert.equal(isCommandTokenInput(""), false);
  assert.equal(isCommandTokenInput("/mo/x"), false);
});

test("completeCommandInput：前缀匹配 + 最匹配（名称最短）排首", () => {
  // "/m" → model(5)、memory(6) 都带 m 前缀（短在前）；provider/thinking 等不含 m 前缀的都不进候选
  const r = completeCommandInput("/m");
  assert.deepEqual(names(r?.items), ["model", "memory"]);
  assert.equal(r?.index, 0, "默认选中项为 items[0]（最匹配）");
  // 多命中时按名称短→长：cls(3) 最短 → 首位
  const all = completeCommandInput("/");
  assert.deepEqual(names(all?.items)?.slice(0, 3), ["cls", "copy", "fork"]);
  assert.equal(all?.items.length, LOCAL_COMMANDS.length);
});

test("completeCommandInput：大小写不敏感 + 别名可补全", () => {
  assert.deepEqual(names(completeCommandInput("/MODEL")?.items), ["model"]);
  // 别名是目录中的独立项：/thi → thinking（与 /effort 同列）
  assert.deepEqual(names(completeCommandInput("/thi")?.items), ["thinking"]);
  assert.deepEqual(names(completeCommandInput("/cl")?.items), [
    "cls",
    "clearscreen",
  ]);
});

test("completeCommandInput：slash 模式下输入框无前导 `/`（归一后匹配）", () => {
  assert.deepEqual(names(completeCommandInput("mo", [], "slash")?.items), [
    "model",
  ]);
  // 归一后同样支持「空 token = 全量」
  assert.equal(completeCommandInput("", [], "slash")?.items.length, LOCAL_COMMANDS.length);
  // 非 slash 模式的裸名字不匹配（避免普通文本误触发）
  assert.equal(completeCommandInput("mo", [], "normal"), null);
  assert.equal(completeCommandInput("mo", [], "shell"), null);
  // slash 模式下带参数（空格后）不再是命令 token
  assert.equal(completeCommandInput("model de", [], "slash"), null);
});

test("completeCommandInput：宿主命令并入 + 同名以本地目录优先（去重）", () => {
  const host = [
    { name: "compact", desc: "压缩会话上下文" },
    { name: "model", desc: "宿主同名命令" },
  ];
  const r = completeCommandInput("/co", host, "slash");
  // 本地目录含 /stats 的别名 context（批次 1）、/contract（A5）、/council（P2#18）：
  // 排序=名称长度优先、同长按字典序（compact/context/council 同 7 字符按字典序）
  assert.deepEqual(names(r?.items), [
    "copy",
    "compact",
    "context",
    "council",
    "contract",
  ]);
  assert.equal(
    r?.items.find((i) => i.name === "compact")?.desc,
    "压缩会话上下文",
  );
  // 同名去重：/mo 只出一个 model，且 desc 取本地目录
  const m = completeCommandInput("/mo", host, "slash");
  assert.deepEqual(names(m?.items), ["model"]);
  assert.equal(
    m?.items[0]?.desc,
    LOCAL_COMMANDS.find((c) => c.name === "model")?.desc,
  );
});

test("completeCommandInput：无命中 → null（不显示空面板）", () => {
  assert.equal(completeCommandInput("/zzz"), null);
  assert.equal(completeCommandInput("/mo x"), null);
  assert.equal(completeCommandInput("hello"), null);
});

test("renderCommandCompletion：标题 + 默认高亮首项 + 恰 height 行", () => {
  const completion = completeCommandInput("/")!;
  const rows = renderCommandCompletion({
    completion,
    height: 10,
    width: 60,
    themeId: "dark",
  });
  assert.equal(rows.length, 10, "输出行数 = height");
  assert.ok(rowAnsi(rows[0]!).includes("/命令补全"), "标题行");
  // 默认焦点行 = items[0]（黄，含 `> /cls`）
  const focused = rows.find((r) => rowAnsi(r).includes("> /cls"))!;
  assert.ok(
    rowAnsi(focused).includes("\x1b[38;2;233;201;68m"),
    `默认高亮最匹配项(黄): ${rowAnsi(focused)}`,
  );
  // 末行是候选行（面板不放提示行：键位统一在输入区下方的按键提示区）
  // height=10 → 标题 1 行 + 9 行候选，本地候选数足够铺满
  assert.ok(
    rowAnsi(rows[9]!).includes("/"),
    `末行应为候选行（铺满活动区）: ${JSON.stringify(rowAnsi(rows[9]!))}`,
  );
  assert.ok(
    !rows.some((r) => rowAnsi(r).includes("[tab]")),
    "面板内不应出现按键提示行",
  );
  assert.equal(
    rows.filter((r) => rowAnsi(r).trim() !== "").length,
    10,
    "标题 + 9 行候选（无空行）",
  );
});

test("renderCommandCompletion：行宽不得超列宽（否则挤偏边框 + 终端折行）", () => {
  // 回归：标题/候选（含 CJK desc）/提示行均需 ≤ width；窄列宽下尤其容易溢出
  for (const width of [80, 40, 24, 12, 4]) {
    const completion = completeCommandInput("/")!;
    const rows = renderCommandCompletion({
      completion: { ...completion, index: 3 },
      height: 12,
      width,
      themeId: "dark",
    });
    assert.equal(rows.length, 12, "输出行数 = height");
    for (const r of rows) {
      assert.ok(
        displayWidth(rowAnsi(r)) <= width,
        `width=${width} 行超宽(${displayWidth(rowAnsi(r))}): ${JSON.stringify(rowAnsi(r))}`,
      );
    }
  }
});

test("renderCommandCompletion：候选超出可视行时丢弃多余项（不滚动）", () => {
  const completion = completeCommandInput("/")!;
  const height = 4; // 可视候选 = height-1 = 3 行
  const rows = renderCommandCompletion({
    completion,
    height,
    width: 60,
    themeId: "dark",
  });
  assert.equal(rows.length, height, "输出行数 = height");
  const body = rows.slice(1);
  const names = body.map(
    (r) => rowAnsi(r).match(/\/([a-z][a-z0-9_-]*)/)?.[1] ?? "",
  );
  assert.deepEqual(
    names,
    completion.items.slice(0, 3).map((i) => i.name),
    "只显示最前面 3 个候选（多余丢弃）",
  );
  assert.ok(
    !names.includes(completion.items[3]!.name),
    "第 4 个及之后的候选不应出现",
  );
  // 焦点移到末尾也不滚动窗口：恒显示最前面几项（可判据区别于旧滚动实现）
  const tail = renderCommandCompletion({
    completion: { ...completion, index: completion.items.length - 1 },
    height,
    width: 60,
    themeId: "dark",
  });
  assert.deepEqual(
    tail
      .slice(1)
      .map((r) => rowAnsi(r).match(/\/([a-z][a-z0-9_-]*)/)?.[1] ?? ""),
    completion.items.slice(0, 3).map((i) => i.name),
    "焦点在末尾时仍显示最前面 3 项（不滚动）",
  );
});
