/**
 * 探测测试：可执行判定、PATH 查找、四级探测顺序（配置 → 环境变量 → PATH → 绝对路径）、
 * 版本读取与「配了却不可执行就不回落」。
 *
 * 全部用假解释器（`#!/bin/sh` 脚本），不依赖机器上装了什么。
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { nodeBackend } from "../src/langs/node.ts";
import { pythonBackend } from "../src/langs/python.ts";
import { shBackend } from "../src/langs/sh.ts";
import {
  isExecutableFile,
  probeInterpreter,
  readVersion,
  resolveExecutable,
  searchPath,
} from "../src/probe.ts";
import {
  fakeBackend,
  fakeInterpreter,
  pythonInfo,
  withTempDir,
  writeExecutable,
} from "./helpers.ts";

test("isExecutableFile：可执行文件 true，缺文件 / 目录 false", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(dir, "run.sh", "#!/bin/sh\nexit 0\n");
    assert.equal(isExecutableFile(exe), true);
    assert.equal(isExecutableFile(join(dir, "missing.sh")), false);
    assert.equal(isExecutableFile(dir), false);
    // root 下 X_OK 恒真，权限位用例无意义。
    if (process.getuid?.() !== 0) {
      const plain = join(dir, "plain.sh");
      writeFileSync(plain, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(plain, 0o644);
      assert.equal(isExecutableFile(plain), false);
    }
  } finally {
    cleanup();
  }
});

test("searchPath：按目录顺序命中；空 PATH 与缺文件不命中", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(dir, "fakepy", "#!/bin/sh\nexit 0\n");
    assert.equal(searchPath("fakepy", dir), exe);
    assert.equal(searchPath("fakepy", `/nonexistent${delimiter}${dir}`), exe);
    assert.equal(searchPath("fakepy", ""), null);
    assert.equal(searchPath("nope", dir), null);
  } finally {
    cleanup();
  }
});

test("resolveExecutable：绝对路径直接判定，裸命令名走 PATH", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(dir, "fakepy", "#!/bin/sh\nexit 0\n");
    assert.equal(resolveExecutable(exe, ""), exe);
    assert.equal(resolveExecutable("fakepy", dir), exe);
    assert.equal(resolveExecutable(join(dir, "nope"), ""), null);
    assert.equal(resolveExecutable("fakepy", ""), null);
  } finally {
    cleanup();
  }
});

test("readVersion：取 --version 的首个非空行", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(
      dir,
      "fakepy",
      fakeInterpreter("FakePython 9.9.9"),
    );
    assert.equal(readVersion(exe, ["--version"]), "FakePython 9.9.9");
  } finally {
    cleanup();
  }
});

test("probeInterpreter：显式配置优先，带来源与版本", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(
      dir,
      "fakepy",
      fakeInterpreter("FakePython 9.9.9"),
    );
    const outcome = probeInterpreter(fakeBackend(), {
      config: exe,
      env: { PATH: "" },
    });
    assert.equal(outcome.info?.source, "config");
    assert.equal(outcome.info?.path, exe);
    assert.equal(outcome.info?.version, "FakePython 9.9.9");
  } finally {
    cleanup();
  }
});

test("probeInterpreter：配置不可执行即判缺失，不回落 PATH", () => {
  const { dir, cleanup } = withTempDir();
  try {
    // PATH 里有可用的 fakepy：若回落就会命中它，用例因此能证明「不回落」。
    writeExecutable(dir, "fakepy", fakeInterpreter("FakePython 9.9.9"));
    const outcome = probeInterpreter(fakeBackend(), {
      config: join(dir, "missing-fakepy"),
      env: { PATH: dir },
    });
    assert.equal(outcome.info, null);
    assert.ok(outcome.trail.some((line) => line.includes("不可执行")));
  } finally {
    cleanup();
  }
});

test("probeInterpreter：环境变量命中，来源为 env", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(
      dir,
      "fakepy",
      fakeInterpreter("FakePython 9.9.9"),
    );
    const outcome = probeInterpreter(fakeBackend(), {
      env: { PATH: "", FAKE_INTERPRETER: exe },
    });
    assert.equal(outcome.info?.source, "env");
    assert.equal(outcome.info?.path, exe);
  } finally {
    cleanup();
  }
});

test("probeInterpreter：环境变量不可执行即判缺失，不回落 PATH", () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeExecutable(dir, "fakepy", fakeInterpreter("FakePython 9.9.9"));
    const outcome = probeInterpreter(fakeBackend(), {
      env: { PATH: dir, FAKE_INTERPRETER: join(dir, "missing-fakepy") },
    });
    assert.equal(outcome.info, null);
    assert.ok(
      outcome.trail.some((line) => line.includes("env:FAKE_INTERPRETER")),
    );
  } finally {
    cleanup();
  }
});

test("probeInterpreter：PATH 候选命中，来源为 path", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(
      dir,
      "fakepy",
      fakeInterpreter("FakePython 9.9.9"),
    );
    const outcome = probeInterpreter(fakeBackend(), { env: { PATH: dir } });
    assert.equal(outcome.info?.source, "path");
    assert.equal(outcome.info?.path, exe);
  } finally {
    cleanup();
  }
});

test("probeInterpreter：最后尝试常见绝对路径，来源为 absolute", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(
      dir,
      "fakepy",
      fakeInterpreter("FakePython 9.9.9"),
    );
    const backend = fakeBackend({ candidates: [], absolutePaths: [exe] });
    const outcome = probeInterpreter(backend, { env: { PATH: "" } });
    assert.equal(outcome.info?.source, "absolute");
    assert.equal(outcome.info?.path, exe);
  } finally {
    cleanup();
  }
});

test("后端表：node 走 PATH 候选与 SCRIPT_NODE_INTERPRETER 覆盖键", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(dir, "node", fakeInterpreter("v9.9.9"));
    const fromPath = probeInterpreter(nodeBackend, { env: { PATH: dir } });
    assert.equal(fromPath.info?.path, exe);
    assert.equal(fromPath.info?.source, "path");
    assert.equal(fromPath.info?.version, "v9.9.9");

    const fromEnv = probeInterpreter(nodeBackend, {
      env: { PATH: "", SCRIPT_NODE_INTERPRETER: exe },
    });
    assert.equal(fromEnv.info?.source, "env");
    assert.equal(
      nodeBackend.absolutePaths.every((candidate) =>
        candidate.includes("node"),
      ),
      true,
    );
  } finally {
    cleanup();
  }
});

test("python venv：工作区 .venv 命中，来源 venv，优先于 PATH", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const ws = join(dir, "ws");
    mkdirSync(join(ws, ".venv", "bin"), { recursive: true });
    const venvPy = writeExecutable(
      join(ws, ".venv", "bin"),
      "python",
      fakeInterpreter("Venv 3.12"),
    );
    // PATH 里也放一个 python：不探测 .venv 的话会命中它，用例因此能证明 venv 优先。
    writeExecutable(dir, "python", fakeInterpreter("Path 3.12"));
    const outcome = probeInterpreter(pythonBackend, {
      env: { PATH: dir },
      workspace: { dir: ws },
    });
    assert.equal(outcome.info?.source, "venv");
    assert.equal(outcome.info?.path, venvPy);
    assert.ok(outcome.trail.some((line) => line.includes("venv:")));
  } finally {
    cleanup();
  }
});

test("python venv：显式配置与环境变量优先于 .venv", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const ws = join(dir, "ws");
    mkdirSync(join(ws, ".venv", "bin"), { recursive: true });
    writeExecutable(
      join(ws, ".venv", "bin"),
      "python",
      fakeInterpreter("Venv 3.12"),
    );
    const cfg = writeExecutable(dir, "cfgpy", fakeInterpreter("Cfg 3.11"));
    const fromConfig = probeInterpreter(pythonBackend, {
      config: cfg,
      env: { PATH: "" },
      workspace: { dir: ws },
    });
    assert.equal(fromConfig.info?.source, "config");
    const envPy = writeExecutable(dir, "envpy", fakeInterpreter("Env 3.10"));
    const fromEnv = probeInterpreter(pythonBackend, {
      env: { PATH: "", SCRIPT_PY_INTERPRETER: envPy },
      workspace: { dir: ws },
    });
    assert.equal(fromEnv.info?.source, "env");
  } finally {
    cleanup();
  }
});

test("python venv：工作区无 .venv 时回落 PATH（来源 path）", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const exe = writeExecutable(dir, "python", fakeInterpreter("Sys 3.12"));
    const outcome = probeInterpreter(pythonBackend, {
      env: { PATH: dir },
      workspace: { dir },
    });
    assert.equal(outcome.info?.source, "path");
    assert.equal(outcome.info?.path, exe);
  } finally {
    cleanup();
  }
});

test("python uv：无 .venv 但有 pyproject.toml 且 PATH 有 uv 时，按解析路径命中", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const ws = join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, "pyproject.toml"),
      '[project]\nname = "x"\nversion = "0.1.0"\n',
      "utf8",
    );
    const resolved = writeExecutable(
      dir,
      "resolved-python",
      fakeInterpreter("Uv 3.13"),
    );
    writeExecutable(dir, "uv", `#!/bin/sh\necho "${resolved}"\n`);
    const outcome = probeInterpreter(pythonBackend, {
      env: { PATH: dir },
      workspace: { dir: ws },
    });
    assert.equal(outcome.info?.source, "uv");
    assert.equal(outcome.info?.path, resolved);
    assert.ok(outcome.trail.some((line) => line.includes("uv:")));
  } finally {
    cleanup();
  }
});

test("python uv：无项目标记或 PATH 无 uv 时，uv 分支不命中（回落 PATH / 绝对路径）", () => {
  const { dir, cleanup } = withTempDir();
  try {
    const ws = join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    // 无标记：直接跳过 uv。
    const noMarker = probeInterpreter(pythonBackend, {
      env: { PATH: dir },
      workspace: { dir: ws },
    });
    assert.notEqual(noMarker.info?.source, "uv");
    assert.ok(
      noMarker.trail.some((line) =>
        line.includes("无 pyproject.toml / uv.lock"),
      ),
      noMarker.trail.join("；"),
    );
    // 有标记但 PATH 无 uv：uv 分支不命中。
    writeFileSync(join(ws, "uv.lock"), "# lockfile\n", "utf8");
    const noUv = probeInterpreter(pythonBackend, {
      env: { PATH: dir },
      workspace: { dir: ws },
    });
    assert.notEqual(noUv.info?.source, "uv");
    assert.ok(
      noUv.trail.some((line) => line.includes("uv:未命中")),
      noUv.trail.join("；"),
    );
  } finally {
    cleanup();
  }
});

test("后端表：sh 的 versionArgs 为空 = 不做版本探测（避免把 --version 报错当版本）", () => {
  const { dir, cleanup } = withTempDir();
  try {
    // 假 sh：带参数就报错，无参数则回显 stdin（模拟 dash 对 --version 的态度）。
    const exe = writeExecutable(
      dir,
      "sh",
      `#!/bin/sh
if [ "$#" -ne 0 ]; then
  echo "sh: 0: Illegal option $1" >&2
  exit 2
fi
cat
exit 0
`,
    );
    const outcome = probeInterpreter(shBackend, { env: { PATH: dir } });
    assert.equal(outcome.info?.path, exe);
    assert.equal(outcome.info?.version, undefined);
    assert.deepEqual(shBackend.args, ["-s"]);
    assert.deepEqual(shBackend.versionArgs, []);
  } finally {
    cleanup();
  }
});

test("probeInterpreter：全都没命中时 info 为 null 且痕迹为空", () => {
  const backend = fakeBackend({ candidates: [], absolutePaths: [] });
  const outcome = probeInterpreter(backend, { env: { PATH: "" } });
  assert.equal(outcome.info, null);
  assert.deepEqual(outcome.trail, []);
});

const py = pythonInfo();
type SimpleTest = (name: string, fn: () => void | Promise<void>) => void;
const pyTest = (py === null ? test.skip : test) as SimpleTest;

pyTest("probeInterpreter：本机 Python 命中绝对路径并读到版本", () => {
  const outcome = probeInterpreter(pythonBackend);
  assert.notEqual(outcome.info, null);
  assert.ok(outcome.info?.path.startsWith("/"), outcome.info?.path);
  assert.equal(typeof outcome.info?.version, "string");
});
