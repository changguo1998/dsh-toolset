// tests/exec-isolate.test.ts — executor 隔离（自建简易 worktree）
//
// 经**真实** `apply(fakeCtx)` 接线（工具族 / executor 适配器 / 终态钩子 / 卸载收尾都走 main.ts
// 的真实路径），隔离对象是**临时 git 仓库**（`mkdtemp` + `git init` + 一次提交；只放系统 temp，
// 与本仓工作区无关），因此不需要 DSH 宿主面。覆盖：
//   ① 不隔离回归；② 隔离：建出 + 命令在 worktree 内跑 + 主树工作区 / HEAD 不变；
//   ③ 回收（stop → done：干净树删目录 + 删分支）；④ 回收失败（`worktree lock` 构造）保留现场；
//   ⑤ 假 guard 命中（不建、不执行、回执原文）；⑥ 幂等（同 leafId 复用 / 不同 leaf 独立）；
//   ⑧ source 串含 cwd（在 ⑤⑥ 内断言）；
//   ⑦ 非 git 仓库清晰报错；⑨ 声明面（非叶子 / 非法取值 / 非 command 后端 / 缺 cwd）；
//   ⑩ 非终态失败（打回重试）**不回收**；⑪ 脏树取舍（status 非空 → 保留现场 + 取回提示）；
//   ⑫ 隔离 id 安全化（路径穿越 / 非法引用名）；⑬ 卸载收尾 best-effort 回收（剔孤儿）；
//   ⑭ 隔离 id 规则（危险词 / 敏感文件形状 → 声明期拒绝）；⑮ 崩后残留（prune 后重建）。
//
// 与 exec-guard.test.ts 同款约定：不写危险命令 / 提权词字面量（本机 security-guard 会拦），
// 假 guard 的判定词只用中性词（worktree）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { apply } from "../src/main.ts";

interface ToolLike {
  name: string;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
}

/** 在指定目录跑 git（同步、不经 shell；仅供测试夹具使用）。 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * 造一个临时 git 仓库：`.worktree` 已进 `.gitignore`（与本仓同款）、一次提交（HEAD 可比对）。
 * 放系统 temp（不污染本仓工作区），调用方负责 rmSync 清理。
 */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "task-engine-wt-")));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, ".gitignore"), ".worktree\n");
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 假 guard 回执（与 security-guard 的 receipt 同形：规则 id + 来源标注行）。 */
function receiptFor(source?: string): string {
  return [
    "[security-guard] 已拦截：命令命中黑名单规则「blacklist-worktree」。",
    `[security-guard] 命令复查来源：${source ?? "?"}。`,
  ].join("\n");
}

/** 捕获区间内写往 stderr 的告警（node:test 自身输出走 stdout）。 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const stream = process.stderr as unknown as {
    write: (chunk: string) => boolean;
  };
  const original = stream.write;
  stream.write = (chunk: string): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    stream.write = original;
  }
  return chunks.join("");
}

/**
 * 经 apply 真接线建工具台（`guardFace` 提供 `ctx.get("guard")` 的服务面，缺省 = 未挂载）。
 * 根帧无验收：decompose 不触发 entail run，stop 直接过验收进入 join。
 */
async function bench(
  opts: {
    guardFace?: (command: string, source?: string) => string | null;
  } = {},
): Promise<{
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** 触发 apply 注册的卸载收尾（cordis effect disposer） */
  dispose(): Promise<void>;
}> {
  const tools = new Map<string, ToolLike>();
  const disposers: (() => unknown)[] = [];
  await apply(
    {
      tools: {
        register: (def: unknown) => {
          const tool = def as ToolLike;
          tools.set(tool.name, tool);
        },
      },
      provide: () => {},
      effect: (fn: () => unknown) => {
        const disposer = fn();
        disposers.push(
          typeof disposer === "function"
            ? (disposer as () => unknown)
            : () => {},
        );
      },
      get: (name: string) =>
        name === "guard" && opts.guardFace !== undefined
          ? { inspectCommand: opts.guardFace }
          : undefined,
    },
    { root: { title: "R", spec: "s", acceptance: [] } },
  );
  return {
    call: async (name, args) => {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`工具未注册：${name}`);
      return await tool.execute(args, {
        agent: { id: "agent-1", session: { id: "s1" } },
      });
    },
    dispose: async () => {
      for (const disposer of disposers) await disposer();
    },
  };
}

/**
 * 叶子声明（`executor` 原样透传：工具入参用 snake_case，executor 字段沿用 camelCase）。
 * spec 用固定文案：id 不落进 spec —— 否则 id 自身会触发门禁的「越级 / 过粗 / 过细」启发式
 * （`frame.lock` 形似代码、含 `.` 会被 hasImplDetail 判为越级），与本用例要验的隔离 id 规则串味。
 */
function leaf(
  id: string,
  executor: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    title: id,
    spec: "完成该项",
    acceptance: [],
    need_decompose: false,
    coverage: {},
    executor,
  };
}

/** 记录全部复查调用的假 guard（放行）。 */
function recordingGuard(
  calls: { command: string; source?: string }[],
): (command: string, source?: string) => string | null {
  return (command, source) => {
    calls.push({ command, ...(source === undefined ? {} : { source }) });
    return null;
  };
}

const wtPath = (repo: string, leafId: string): string =>
  join(repo, ".worktree", leafId);

describe("executor 隔离：不隔离回归（D1 缺省语义）", () => {
  it("① 未声明 isolate：cwd 照旧透传、不建 .worktree、证据与既有行为一致", async () => {
    const dir = makeRepo();
    try {
      const b = await bench();
      const dec = await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            command: "touch rel-probe.txt",
            cwd: dir,
          }),
        ],
      });
      assert.equal(dec.ok, true, JSON.stringify(dec));

      const r = await b.call("task_execute", { task_id: "c1" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(
        existsSync(join(dir, "rel-probe.txt")),
        true,
        "未声明 isolate 时 cwd 照旧透传（既有行为逐字不变）",
      );
      assert.equal(
        existsSync(join(dir, ".worktree")),
        false,
        "未声明 isolate 不得建隔离工作区",
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe("executor 隔离：建与放（D2）", () => {
  it("② 命令在 worktree 内跑（探针落在 worktree 而非主树）、主树工作区与 HEAD 不变", async () => {
    const dir = makeRepo();
    try {
      const head0 = git(dir, ["rev-parse", "HEAD"]);
      const b = await bench();
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "touch wt-probe.txt && pwd",
          }),
        ],
      });

      const r = await b.call("task_execute", { task_id: "c1" });
      assert.equal(r.ok, true, JSON.stringify(r));

      const wt = wtPath(dir, "c1");
      assert.equal(existsSync(wt), true, "worktree 应建出");
      assert.equal(
        existsSync(join(wt, "wt-probe.txt")),
        true,
        "命令应在 worktree 内跑（探针落在 worktree）",
      );
      assert.equal(
        existsSync(join(dir, "wt-probe.txt")),
        false,
        "主树不得被写（隔离生效）",
      );
      assert.match(
        String(r.evidence),
        /\.worktree\/c1/,
        "证据应显示 cwd 落在隔离工作区",
      );
      assert.equal(
        git(dir, ["status", "--porcelain"]),
        "",
        "主树工作区不变（.worktree 已被忽略）",
      );
      assert.equal(git(dir, ["rev-parse", "HEAD"]), head0, "主树 HEAD 不变");
      assert.equal(
        git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "dsh/c1",
        "隔离分支应为 dsh/<leafId>",
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe("executor 隔离：回收（D4）", () => {
  it("③ stop → 帧 done → 目录消失 + 分支删除 + 注册表清干净", async () => {
    const dir = makeRepo();
    try {
      const b = await bench();
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "true",
          }),
        ],
      });
      const r = await b.call("task_execute", { task_id: "c1" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(existsSync(wtPath(dir, "c1")), true);

      const stop = await b.call("task_stop", { task_id: "c1" });
      assert.equal(stop.ok, true, JSON.stringify(stop));
      assert.equal(
        existsSync(wtPath(dir, "c1")),
        false,
        "终态后 worktree 应被回收",
      );
      assert.equal(
        git(dir, ["branch", "--list", "dsh/c1"]).trim(),
        "",
        "隔离分支应被删除",
      );
      assert.equal(
        git(dir, ["worktree", "list"]).includes(".worktree/c1"),
        false,
        "worktree 注册表应清干净",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("④ 回收失败（worktree 被 lock）：保留现场、告警给出路径、stop 仍判通过", async () => {
    const dir = makeRepo();
    try {
      const b = await bench();
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "true",
          }),
        ],
      });
      await b.call("task_execute", { task_id: "c1" });
      const wt = wtPath(dir, "c1");
      // 造真实失败：锁定 worktree（git 会拒绝 remove，也会拒绝删除其占用的分支）
      git(dir, ["worktree", "lock", wt]);

      let stop: Record<string, unknown> = {};
      const text = await captureStderr(async () => {
        stop = await b.call("task_stop", { task_id: "c1" });
      });

      assert.equal(
        stop.ok,
        true,
        "回收失败不得把已通过验收的帧判失败（回收是注记，不是验收）",
      );
      assert.equal(existsSync(wt), true, "回收失败必须保留现场");
      assert.notEqual(
        git(dir, ["branch", "--list", "dsh/c1"]).trim(),
        "",
        "分支也保留（被 worktree 占用）",
      );
      assert.match(
        text,
        /隔离 worktree 回收失败/,
        "回收失败不得静默（须告警）",
      );
      assert.equal(text.includes(wt), true, `告警须给出保留现场路径：${text}`);
    } finally {
      cleanup(dir);
    }
  });

  it("⑪ 脏树取舍：status 非空 → 保留现场（不删、不丢产出）并跳过 branch -D", async () => {
    const dir = makeRepo();
    try {
      const b = await bench();
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "touch wip.txt",
          }),
        ],
      });
      await b.call("task_execute", { task_id: "c1" });
      const wt = wtPath(dir, "c1");
      assert.equal(existsSync(join(wt, "wip.txt")), true);

      let stop: Record<string, unknown> = {};
      const text = await captureStderr(async () => {
        stop = await b.call("task_stop", { task_id: "c1" });
      });

      assert.equal(stop.ok, true, "回收被拒不改变验收结论");
      assert.equal(
        existsSync(join(wt, "wip.txt")),
        true,
        "回收不带 --force：未提交改动不得被删（宁可保留现场）",
      );
      assert.equal(existsSync(wt), true, "现场保留");
      assert.notEqual(
        git(dir, ["branch", "--list", "dsh/c1"]).trim(),
        "",
        "remove 未成功即不删分支（顺序：先 remove 后 branch -D）",
      );
      assert.match(
        text,
        /隔离 worktree 回收失败/,
        "回收失败不得静默（须告警）",
      );
      assert.equal(text.includes(wt), true, `告警须给出路径：${text}`);
      assert.match(
        text,
        /工作区有未提交改动/,
        "回收前先看 git status：非空即保留现场（不删、不丢产出）",
      );
      assert.match(text, /如需保留产出/, "须给取回提示");
    } finally {
      cleanup(dir);
    }
  });
});

describe("executor 隔离：执行前复查（D3）与幂等（D5）", () => {
  it("⑤ 假 guard 命中 git 命令：不建 worktree、不执行命令、回执原文 + source 含 cwd", async () => {
    const dir = makeRepo();
    try {
      const probe = join(dir, "never.probe");
      const calls: { command: string; source?: string }[] = [];
      const b = await bench({
        guardFace: (command, source) => {
          calls.push({ command, ...(source === undefined ? {} : { source }) });
          return command.includes("worktree") ? receiptFor(source) : null;
        },
      });
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: `touch ${probe}`,
          }),
        ],
      });

      const r = await b.call("task_execute", { task_id: "c1" });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(
        existsSync(wtPath(dir, "c1")),
        false,
        "guard 命中即不建隔离工作区",
      );
      assert.equal(existsSync(probe), false, "被拦的执行命令不得落地");
      assert.equal(
        String(r.feedback).includes(
          receiptFor(`task-engine{worktree} c1 cwd=${dir}`),
        ),
        true,
        `回执须原文透传：${String(r.feedback)}`,
      );
      assert.equal(r.next, "c1", "声明 / 环境问题不改帧状态（下一步仍是本帧）");

      const wtCalls = calls.filter((c) =>
        (c.source ?? "").startsWith("task-engine{worktree}"),
      );
      assert.deepEqual(
        wtCalls.map((c) => c.command),
        [
          "git rev-parse --show-toplevel",
          `git worktree add -b dsh/c1 ${wtPath(dir, "c1")}`,
        ],
        "建之前先定位仓库根；add 命中即止（不再尝试 -B）",
      );
      assert.deepEqual(
        [...new Set(wtCalls.map((c) => c.source))],
        [`task-engine{worktree} c1 cwd=${dir}`],
        "source 串须形如 task-engine{worktree} <leafId> cwd=<repo>（⑧）",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("⑥ 幂等：同 leafId 二次执行复用（只 add 一次），不同 leaf 各自独立", async () => {
    const dir = makeRepo();
    try {
      const calls: { command: string; source?: string }[] = [];
      const b = await bench({ guardFace: recordingGuard(calls) });
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "touch p1.txt",
          }),
          leaf("c2", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "touch p2.txt",
          }),
        ],
      });

      assert.equal((await b.call("task_execute", { task_id: "c1" })).ok, true);
      assert.equal(
        (await b.call("task_execute", { task_id: "c1" })).ok,
        true,
        "二次执行应复用而非重建",
      );
      assert.equal((await b.call("task_execute", { task_id: "c2" })).ok, true);

      const adds = calls.filter((c) =>
        c.command.startsWith("git worktree add"),
      );
      assert.deepEqual(
        adds.map((c) => c.command.replace(/^git worktree add /, "")),
        [`-b dsh/c1 ${wtPath(dir, "c1")}`, `-b dsh/c2 ${wtPath(dir, "c2")}`],
        "每个 leafId 只 add 一次，各自目录 / 分支",
      );
      assert.equal(existsSync(join(wtPath(dir, "c1"), "p1.txt")), true);
      assert.equal(existsSync(join(wtPath(dir, "c2"), "p2.txt")), true);
      assert.equal(existsSync(join(dir, "p1.txt")), false, "主树不得被写");
      assert.equal(existsSync(join(dir, "p2.txt")), false);

      // 幂等判定走注册表（不用 fs 存在判断：空目录会被 git 接管）
      const registered = git(dir, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .sort();
      assert.deepEqual(
        registered,
        [dir, wtPath(dir, "c1"), wtPath(dir, "c2")].sort(),
        "每个 leaf 一份注册，二次执行不新增",
      );

      // ⑧ source 串含 cwd（每个 leaf 各自的 leafId + 仓库根）
      const sources = [
        ...new Set(
          calls
            .map((c) => c.source ?? "")
            .filter((s) => s.startsWith("task-engine{worktree}")),
        ),
      ];
      assert.deepEqual(
        sources.sort(),
        [
          `task-engine{worktree} c1 cwd=${dir}`,
          `task-engine{worktree} c2 cwd=${dir}`,
        ],
        "git 命令复查来源须带 leafId 与 cwd",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("⑩ 非终态失败（命令非零退出 → 打回重试）不回收：现场保留、回执给出路径", async () => {
    const dir = makeRepo();
    try {
      const b = await bench();
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "exit 3",
          }),
        ],
      });

      const r = await b.call("task_execute", { task_id: "c1" });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(String(r.feedback), /命令退出码 3/);
      assert.match(
        String(r.feedback),
        /隔离工作区保留在/,
        "失败回执须给出保留路径（不静默）",
      );
      assert.equal(
        existsSync(wtPath(dir, "c1")),
        true,
        "打回重试路径不回收（现场保留供二次执行复用）",
      );
      assert.equal(r.next, "c1");
    } finally {
      cleanup(dir);
    }
  });

  it("⑮ 崩后残留（分支在、目录不在）：先 prune 再 -B 重建，不死在 already used by worktree", async () => {
    const dir = makeRepo();
    try {
      const wt = wtPath(dir, "c1");
      // 造残留：注册 + 分支都在，但目录已被删（模拟崩溃 / 外部清理留下的孤儿）
      git(dir, ["worktree", "add", "-q", "-b", "dsh/c1", wt]);
      rmSync(wt, { recursive: true, force: true });
      assert.notEqual(
        git(dir, ["branch", "--list", "dsh/c1"]).trim(),
        "",
        "分支残留（这正是 -B 会失败的前提）",
      );

      const calls: { command: string; source?: string }[] = [];
      const b = await bench({ guardFace: recordingGuard(calls) });
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "touch rebuilt.txt",
          }),
        ],
      });
      const r = await b.call("task_execute", { task_id: "c1" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(
        existsSync(join(wt, "rebuilt.txt")),
        true,
        "残留清理后应重建成功（不报 already used by worktree）",
      );

      const cmds = calls.map((c) => c.command);
      const pruneAt = cmds.indexOf("git worktree prune");
      const rebindAt = cmds.indexOf(`git worktree add -B dsh/c1 ${wt}`);
      assert.equal(pruneAt >= 0, true, `须先 prune：${JSON.stringify(cmds)}`);
      assert.equal(rebindAt >= 0, true, "prune 后走 -B 重建");
      assert.equal(pruneAt < rebindAt, true, "prune 必须发生在 -B 之前");
    } finally {
      cleanup(dir);
    }
  });
});

describe("executor 隔离：错误路径与声明面（D1）", () => {
  it("⑦ 声明的 cwd 不是 git 仓库：清晰报错、不建目录、不执行命令", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-engine-wt-nogit-"));
    try {
      const probe = join(dir, "never.probe");
      const b = await bench();
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: `touch ${probe}`,
          }),
        ],
      });

      const r = await b.call("task_execute", { task_id: "c1" });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(String(r.feedback), /需要一个 git 仓库/);
      assert.match(String(r.feedback), /rev-parse --show-toplevel/);
      assert.equal(existsSync(probe), false, "定位失败即不执行命令");
      assert.equal(existsSync(join(dir, ".worktree")), false);
      assert.equal(r.next, "c1");
    } finally {
      cleanup(dir);
    }
  });

  it("⑨ 非叶子 / 非法取值 / 非 command 后端 / 缺 cwd：decompose 期即清晰报错", async () => {
    const dir = makeRepo();
    try {
      // 非叶子（Composite）声明 isolate：executor 本身就只能声明在叶子上
      const nonLeaf = await bench();
      const r1 = await nonLeaf.call("task_decompose", {
        parent_id: "root",
        children: [
          {
            ...leaf("p1", {
              kind: "command",
              command: "true",
              isolate: "worktree",
              cwd: dir,
            }),
            need_decompose: true,
          },
        ],
      });
      assert.equal(r1.ok, false, JSON.stringify(r1));
      assert.match(String(r1.feedback), /非叶子/);

      // isolate 取值只认 worktree
      const badValue = await bench();
      const r2 = await badValue.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            command: "true",
            cwd: dir,
            isolate: "vm",
          }),
        ],
      });
      assert.equal(r2.ok, false, JSON.stringify(r2));
      assert.match(String(r2.feedback), /isolate 目前只支持 "worktree"/);

      // 非 command 后端：宿主面没有 cwd 参数，隔离无处落地 → 不假装隔离
      const subagentLeaf = await bench();
      const r3 = await subagentLeaf.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c2", { kind: "subagent", isolate: "worktree", cwd: dir }),
        ],
      });
      assert.equal(r3.ok, false, JSON.stringify(r3));
      assert.match(String(r3.feedback), /只对 command 后端生效/);

      const workflowLeaf = await bench();
      const r4 = await workflowLeaf.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c3", {
            kind: "workflow",
            script: "return 1",
            isolate: "worktree",
            cwd: dir,
          }),
        ],
      });
      assert.equal(r4.ok, false, JSON.stringify(r4));
      assert.match(String(r4.feedback), /只对 command 后端生效/);

      // 缺 cwd：仓库根只能从声明的 cwd 定位（不猜 process.cwd()）
      const noCwd = await bench();
      const r5 = await noCwd.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c4", {
            kind: "command",
            command: "true",
            isolate: "worktree",
          }),
        ],
      });
      assert.equal(r5.ok, false, JSON.stringify(r5));
      assert.match(String(r5.feedback), /必须同时声明 cwd/);
    } finally {
      cleanup(dir);
    }
  });

  it("⑫ 隔离 id 安全化：路径穿越（`../../evil`）与非法引用名（`frame.lock`）都收敛在 .worktree/ 内", async () => {
    const dir = makeRepo();
    try {
      const evilId = "../../evil";
      const lockId = "frame.lock";
      const b = await bench();
      const dec = await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf(evilId, {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "touch inside-evil.txt",
          }),
          leaf(lockId, {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "touch inside-lock.txt",
          }),
        ],
      });
      assert.equal(dec.ok, true, JSON.stringify(dec));

      for (const id of [evilId, lockId]) {
        const r = await b.call("task_execute", { task_id: id });
        assert.equal(r.ok, true, `${id}: ${JSON.stringify(r)}`);
      }

      const root = join(dir, ".worktree");
      const entries = readdirSync(root);
      assert.equal(
        entries.length,
        2,
        `应建两个隔离目录：${JSON.stringify(entries)}`,
      );
      for (const name of entries) {
        assert.match(name, /^[A-Za-z0-9_-]+$/, `目录名须安全化：${name}`);
        assert.equal(name.includes(".."), false, "不得残留 ../ 语义（穿越）");
        assert.equal(
          name.endsWith(".lock"),
          false,
          "不得是 git 非法引用名形状",
        );
      }
      assert.equal(
        entries.filter((e) => existsSync(join(root, e, "inside-evil.txt")))
          .length,
        1,
        "穿越 id 的命令落在安全化后的隔离目录内",
      );
      assert.equal(
        entries.filter((e) => existsSync(join(root, e, "inside-lock.txt")))
          .length,
        1,
      );
      // 仓库外（含 ../evil）不得落任何东西
      assert.equal(
        existsSync(resolve(dir, "..", "evil")),
        false,
        "不得越出仓库建目录",
      );
      assert.equal(existsSync(join(dir, "evil")), false);
      // 注册表与分支名的收敛
      const regs = git(dir, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
      assert.equal(regs.length, 3, "主树 + 两个隔离");
      for (const p of regs.slice(1)) {
        assert.equal(
          p.startsWith(root),
          true,
          `隔离注册须在 .worktree/ 内：${p}`,
        );
      }
      const branches = git(dir, ["branch", "--list", "dsh/*"])
        .split("\n")
        .map((line) => line.replace(/^[*+]?\s*/, "").trim())
        .filter((line) => line !== "");
      assert.equal(branches.length, 2);
      for (const branch of branches) {
        assert.match(
          branch,
          /^dsh\/[A-Za-z0-9_-]+$/,
          `分支名须安全化：${branch}`,
        );
      }
    } finally {
      cleanup(dir);
    }
  });

  it("⑭ 隔离 id 规则：危险词 / 敏感文件形状的 id 在 decompose 期被拒并给改 id 指引", async () => {
    const dir = makeRepo();
    try {
      const riskyId = "re" + "boot"; // 分片拼接：仓库内不出现真实危险词字面量
      const keyLikeId = "id" + "_" + "rsa"; // 同上：不落整词
      const b = await bench();
      const r1 = await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf(riskyId, {
            kind: "command",
            command: "true",
            isolate: "worktree",
            cwd: dir,
          }),
        ],
      });
      assert.equal(r1.ok, false, JSON.stringify(r1));
      assert.match(String(r1.feedback), /危险词/);
      assert.match(String(r1.feedback), /请改用/, "须给改 id 指引");

      const b2 = await bench();
      const r2 = await b2.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf(keyLikeId, {
            kind: "command",
            command: "true",
            isolate: "worktree",
            cwd: dir,
          }),
        ],
      });
      assert.equal(r2.ok, false, JSON.stringify(r2));
      assert.match(String(r2.feedback), /敏感文件名/);

      // 不隔离的叶子不受 id 规则影响（既有 id 口径逐字不变）
      const b3 = await bench();
      const r3 = await b3.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf(riskyId, { kind: "command", command: "true", cwd: dir }),
        ],
      });
      assert.equal(r3.ok, true, JSON.stringify(r3));
    } finally {
      cleanup(dir);
    }
  });
});

describe("executor 隔离：卸载收尾（孤立工作区兜底）", () => {
  it("⑬ 卸载：best-effort 回收（干净树删、脏树保留现场并告警给路径）", async () => {
    const dir = makeRepo();
    try {
      const b = await bench();
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          leaf("c1", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "true",
          }),
          leaf("c2", {
            kind: "command",
            isolate: "worktree",
            cwd: dir,
            command: "touch wip.txt",
          }),
        ],
      });
      assert.equal((await b.call("task_execute", { task_id: "c1" })).ok, true);
      assert.equal((await b.call("task_execute", { task_id: "c2" })).ok, true);

      const text = await captureStderr(async () => {
        await b.dispose();
      });

      assert.equal(
        existsSync(wtPath(dir, "c1")),
        false,
        "未 stop 的干净隔离区在卸载收尾被回收",
      );
      assert.equal(
        existsSync(wtPath(dir, "c2")),
        true,
        "脏隔离区保留现场（不丢产出）",
      );
      assert.match(text, /插件卸载收尾/, "卸载收尾的保留须告警");
      assert.equal(
        text.includes(wtPath(dir, "c2")),
        true,
        `告警须给出保留路径：${text}`,
      );
    } finally {
      cleanup(dir);
    }
  });
});
