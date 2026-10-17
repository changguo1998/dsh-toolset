/**
 * 探测测试：可执行判定、PATH 查找、四级探测顺序（配置 → 环境变量 → PATH → 绝对路径）、
 * 版本读取与「配了却不可执行就不回落」。
 *
 * 全部用假解释器（`#!/bin/sh` 脚本），不依赖机器上装了什么。
 */

import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { pythonBackend } from "../src/langs/python.ts";
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
