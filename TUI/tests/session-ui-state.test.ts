// tests/session-ui-state.test.ts — TUI 侧会话状态快照（tui-state.json）读写
//
// 快照随会话目录走（<会话根>/<slug>/<id>/tui-state.json）：只承载宿主日志不记录的
// 状态（verbose/symbol-unify）与模型/模式的兜底值。读写一律 best-effort：
// 目录缺失、文件损坏、版本不符都静默降级（读 undefined、写 false），绝不抛错。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionUiState,
  SESSION_UI_STATE_FILE,
  writeSessionUiState,
  type SessionUiState,
} from "../src/app/adapter/session-ui-state.ts";
import { locateSessionDir } from "../src/app/adapter/session-paths.ts";

/** 临时会话根：<root>/<slug>/<id>/ */
function makeRoot(
  id: string,
  slug = "proj-slug",
): {
  root: string;
  dir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "dsh-tui-state-"));
  const dir = join(root, slug, id);
  mkdirSync(dir, { recursive: true });
  return {
    root,
    dir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("写→读往返：全部字段（含可选 reasoningEffort / modes）", () => {
  const { root, dir, cleanup } = makeRoot("tui-a1");
  try {
    const state: SessionUiState = {
      version: 1,
      model: {
        provider: "deepseek",
        model: "deepseek-reasoner",
        reasoningEffort: "high",
      },
      verbose: false,
      symbolUnify: false,
      modes: {
        plan: "on",
        sandbox: "danger-full-access",
        permission: "full",
        policy: "never",
      },
    };
    const res = writeSessionUiState("tui-a1", state, [root]);
    assert.equal(res.ok, true, "写入成功");
    assert.equal(
      res.ok && res.path,
      join(dir, SESSION_UI_STATE_FILE),
      "写进会话目录内",
    );
    assert.deepEqual(readSessionUiState("tui-a1", [root]), state, "读回一致");
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes(".tmp-")),
      [],
      "无临时文件残留（先写临时文件再 rename）",
    );
  } finally {
    cleanup();
  }
});

test("会话目录不存在（仅内存会话）：写失败、读 undefined，且不创建目录", () => {
  const { root, cleanup } = makeRoot("tui-exists");
  try {
    const res = writeSessionUiState(
      "tui-missing",
      { version: 1, verbose: true },
      [root],
    );
    assert.equal(res.ok, false, "无目录 → 写失败");
    assert.equal(
      readSessionUiState("tui-missing", [root]),
      undefined,
      "无目录 → 无快照",
    );
    assert.deepEqual(
      readdirSync(root),
      ["proj-slug"],
      "不新建目录（只在既有会话目录内写）",
    );
  } finally {
    cleanup();
  }
});

test("损坏/版本不符/字段类型不符：读 undefined 或丢弃坏字段，不抛错", () => {
  const { root, dir, cleanup } = makeRoot("tui-corrupt");
  try {
    const file = join(dir, SESSION_UI_STATE_FILE);
    writeFileSync(file, "{ not json", "utf8");
    assert.equal(
      readSessionUiState("tui-corrupt", [root]),
      undefined,
      "损坏 JSON → undefined",
    );
    writeFileSync(
      file,
      JSON.stringify({ version: 99, verbose: false }),
      "utf8",
    );
    assert.equal(
      readSessionUiState("tui-corrupt", [root]),
      undefined,
      "版本不符 → undefined",
    );
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        verbose: "yes",
        symbolUnify: false,
        model: { provider: "p" }, // 缺 model → 丢弃该项
        modes: { plan: "maybe", sandbox: 42, policy: "never" },
      }),
      "utf8",
    );
    assert.deepEqual(
      readSessionUiState("tui-corrupt", [root]),
      { version: 1, symbolUnify: false, modes: { policy: "never" } },
      "坏字段逐项丢弃，其余保留",
    );
  } finally {
    cleanup();
  }
});

test("非法会话 id：定位拒绝（写失败 / 读 undefined），不越界到根外", () => {
  const { root, cleanup } = makeRoot("tui-safe");
  try {
    for (const bad of ["../escape", "a/b", ".", ""]) {
      assert.equal(
        writeSessionUiState(bad, { version: 1 }, [root]).ok,
        false,
        `拒绝写入：${bad}`,
      );
      assert.equal(
        readSessionUiState(bad, [root]),
        undefined,
        `拒绝读取：${bad}`,
      );
    }
  } finally {
    cleanup();
  }
});

test("locateSessionDir：按根顺序命中首个存在的会话目录", () => {
  const a = makeRoot("tui-dup", "slug-a");
  const b = makeRoot("tui-dup", "slug-b");
  try {
    const found = locateSessionDir("tui-dup", [a.root, b.root]);
    assert.equal(found.ok, true);
    assert.equal(
      found.ok && found.path,
      join(a.root, "slug-a", "tui-dup"),
      "按根顺序：首个命中根生效",
    );
    const onlyB = locateSessionDir("tui-dup", [b.root]);
    assert.equal(
      onlyB.ok && onlyB.path,
      join(b.root, "slug-b", "tui-dup"),
      "只给第二个根时命中该根",
    );
  } finally {
    a.cleanup();
    b.cleanup();
  }
});
