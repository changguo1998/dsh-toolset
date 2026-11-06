import { test } from "node:test";
import assert from "node:assert/strict";

import {
  commandPositions,
  commandWords,
  isDynamicCommand,
  isShellName,
} from "../src/index.ts";

test("commandWords：逐段取命令位，参数位不算", () => {
  assert.deepEqual(commandWords("ls && python3 -V"), ["ls", "python3"]);
  assert.deepEqual(commandWords("echo 'a;b'; ruby x.rb"), ["echo", "ruby"]);
  assert.deepEqual(commandWords("git commit -m 'ruby: 说明'"), ["git"]);
  assert.deepEqual(commandWords("grep -rn python src/"), ["grep"]);
  assert.deepEqual(commandWords(""), []);
});

test("commandWords：段首变量赋值不算命令位", () => {
  assert.deepEqual(commandWords("FOO=1 python x.py"), ["python"]);
  assert.deepEqual(commandWords("A=1 B=2 /usr/bin/node x.mjs"), ["node"]);
});

test("commandWords：shell 关键字与取反不产生命令位", () => {
  assert.deepEqual(commandWords("if [ -f x ]; then python x; fi"), ["python"]);
  assert.deepEqual(commandWords("! ruby x.rb"), ["ruby"]);
  assert.deepEqual(commandWords("for f in a b; do node $f; done"), [
    "for",
    "node",
  ]);
});

test("commandWords：剥离包装器后取命令位", () => {
  assert.deepEqual(commandWords("sudo -u root uv run python x.py"), ["python"]);
  assert.deepEqual(commandWords("timeout 30 npx -y tsx gen.ts"), ["tsx"]);
  assert.deepEqual(commandWords("echo x | xargs -n1 ruby"), ["echo", "ruby"]);
});

test("commandWords：shell -c 与 eval 递归", () => {
  assert.deepEqual(commandWords('bash -c "python x.py"'), ["bash", "python"]);
  assert.deepEqual(commandWords("sh -lc 'ruby x.rb'"), ["sh", "ruby"]);
  assert.deepEqual(commandWords("eval 'ruby x.rb'"), ["eval", "ruby"]);
});

test("commandWords：命令替换与反引号递归", () => {
  assert.deepEqual(commandWords("echo $(date)"), ["echo", "date"]);
  // 赋值语句 `x=`whoami`` 的整体不是命令位，值里的替换才算
  assert.deepEqual(commandWords("x=`whoami`; echo ok"), ["whoami", "echo"]);
  assert.deepEqual(commandWords("echo $(echo $(date))"), [
    "echo",
    "echo",
    "date",
  ]);
});

test("commandPositions：来源、深度与包装器链", () => {
  const positions = commandPositions('sudo env FOO=1 bash -c "python x.py"');
  assert.deepEqual(
    positions.map((position) => position.word),
    ["bash", "python"],
  );
  assert.deepEqual(positions[0]?.wrappers, ["sudo", "env"]);
  assert.equal(positions[0]?.source, "top");
  assert.equal(positions[1]?.source, "shell");
  assert.equal(positions[1]?.depth, 1);

  const substitution = commandPositions("echo $(ruby x.rb)");
  assert.equal(substitution[1]?.source, "substitution");
  assert.equal(substitution[1]?.depth, 1);
});

test("commandPositions：maxDepth 限制递归", () => {
  assert.deepEqual(commandWords('bash -c "python x.py"', { maxDepth: 0 }), [
    "bash",
  ]);
  assert.deepEqual(commandWords('bash -c "python x.py"', { maxDepth: 1 }), [
    "bash",
    "python",
  ]);
});

test("commandPositions：追加的包装器优先匹配", () => {
  const words = commandWords("mytool run python x.py", {
    wrappers: [{ words: ["mytool", "run"] }],
  });
  assert.deepEqual(words, ["python"]);
});

test("isDynamicCommand：$cmd / 命令替换 / 反引号产生命令位时才算", () => {
  assert.equal(isDynamicCommand("$CMD arg"), true);
  assert.equal(isDynamicCommand("echo $(date)"), false);
  assert.equal(isDynamicCommand("ls -la"), false);
});

test("isShellName：只认 shell 族", () => {
  assert.equal(isShellName("bash"), true);
  assert.equal(isShellName("sh"), true);
  assert.equal(isShellName("python"), false);
});
