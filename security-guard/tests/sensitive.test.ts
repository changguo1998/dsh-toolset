/**
 * 敏感文件保护单测：归一化 / 默认清单命中 / 路径提取 / 放行清单。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkSensitivePath,
  compileSensitiveRules,
  extractCommandPaths,
  extractPatchPaths,
  normalizePath,
  basenameOf,
  DEFAULT_SENSITIVE_RULES,
  type SensitiveRule,
} from "../src/sensitive.ts";

const HOME = "/home/tester";
const rules = compileSensitiveRules(DEFAULT_SENSITIVE_RULES, HOME);

/** 用默认清单检查路径，返回命中规则 id（无命中为 null）。 */
function check(p: string): string | null {
  return checkSensitivePath(p, rules, HOME)?.rule.id ?? null;
}

test("归一化：~ / $HOME / ${HOME} 展开并折叠斜杠", () => {
  assert.equal(normalizePath("~/.ssh", HOME), "/home/tester/.ssh");
  assert.equal(normalizePath("$HOME/.aws", HOME), "/home/tester/.aws");
  assert.equal(normalizePath("${HOME}/.kube", HOME), "/home/tester/.kube");
  assert.equal(normalizePath('"/home/a//b"', HOME), "/home/a/b");
  assert.equal(normalizePath("./src", HOME), "./src");
});

test("默认清单：凭据目录命中（含子树、各种家目录写法）", () => {
  assert.equal(check("~/.ssh/id_rsa"), "ssh-directory");
  assert.equal(check("~/.ssh"), "ssh-directory");
  assert.equal(check("/home/tester/.ssh/known_hosts"), "ssh-directory");
  assert.equal(check("$HOME/.aws/credentials"), "aws-credentials");
  assert.equal(check("${HOME}/.kube/config"), "kube-directory");
  assert.equal(check("~/.gnupg/private-keys-v1.d/x.key"), "gnupg-directory");
  assert.equal(check("~/.config/gh/hosts.yml"), "gh-credentials");
  assert.equal(check("~/.docker/config.json"), "docker-config");
});

test("默认清单：凭据文件 / env / 私钥命中（basename 语义，任意深度）", () => {
  assert.equal(check("./.env"), "env-file");
  assert.equal(check("config/.env.local"), "env-variant");
  assert.equal(check("/etc/.env"), "env-file");
  assert.equal(check("certs/server.pem"), "pem-key");
  assert.equal(check("/opt/app/db.key"), "key-file");
  assert.equal(check("id_ed25519"), "ssh-ed25519-key");
  assert.equal(check("deploy/id_rsa"), "ssh-rsa-key");
  assert.equal(check("gcp/credentials.json"), "gcp-credentials");
  assert.equal(check("sa/service-account-prod.json"), "service-account");
  assert.equal(check("~/.netrc"), "netrc");
  assert.equal(check("~/.git-credentials"), "git-credentials");
});

test("默认清单：普通工程文件放行", () => {
  assert.equal(check("src/index.ts"), null);
  assert.equal(check("README.md"), null);
  assert.equal(check("node_modules/.bin/tsc"), null);
  assert.equal(check("/tmp/out.json"), null);
  assert.equal(check("package.json"), null);
});

test("路径提取：引号 / token / 粘连 / 绝对路径", () => {
  const a = extractCommandPaths("cat ~/.ssh/id_rsa");
  assert.ok(a.includes("~/.ssh/id_rsa"));
  const b = extractCommandPaths('cat < "$HOME/.aws/credentials"');
  assert.ok(b.includes("$HOME/.aws/credentials"));
  const c = extractCommandPaths("cat ./config/.env && echo done");
  assert.ok(c.includes("./config/.env"));
  const d = extractCommandPaths("grep foo src/bar.ts");
  assert.ok(d.includes("src/bar.ts"));
  const e = extractCommandPaths("echo x > /dev/sda");
  assert.ok(e.includes("/dev/sda"));
  // 裸 token（如 ls）也保留为候选：无害且能拦 `cat id_rsa` 这类无路径前缀写法；
  // 选项（-la）被过滤
  const f = extractCommandPaths("ls -la");
  assert.deepEqual(f, ["ls"]);
});

test("补丁路径提取：四类标记 + 去重 + 引号", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: docs/new.md",
    "+hello",
    "*** Update File: ~/.ssh/config",
    "@@",
    "-old",
    "+new",
    "*** Delete File: tmp/old.txt",
    "*** Move to: 'src/moved.ts'",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(extractPatchPaths(patch), [
    "docs/new.md",
    "~/.ssh/config",
    "tmp/old.txt",
    "src/moved.ts",
  ]);
  // 同一路径出现多次只留一份
  const twice = ["*** Update File: a.ts", "@@", "*** Update File: a.ts"].join(
    "\n",
  );
  assert.deepEqual(extractPatchPaths(twice), ["a.ts"]);
  // 无标记 / 空文本 → 空数组（调用方按「无路径可查」处理）
  assert.deepEqual(extractPatchPaths(""), []);
  assert.deepEqual(extractPatchPaths("*** Begin Patch\n+just a line\n"), []);
  // 标记行前的空白不影响匹配（补丁可能带缩进）
  assert.deepEqual(extractPatchPaths("  *** Add File: b.ts"), ["b.ts"]);
  // 只有标记没路径 → 不入结果
  assert.deepEqual(extractPatchPaths("*** Delete File:   "), []);
});

test("提取 + 检查联动：补丁文本里的敏感路径被拦", () => {
  for (const patch of [
    "*** Update File: ~/.ssh/config",
    "*** Add File: /home/tester/.aws/credentials",
    "*** Delete File: .env",
    "*** Move to: config/.env.local",
  ]) {
    const paths = extractPatchPaths(patch);
    const hit = paths
      .map((p) => checkSensitivePath(p, rules, HOME))
      .find((h) => h !== null);
    assert.notEqual(hit, null, `expected sensitive hit for: ${patch}`);
  }
  // 工作区内的普通补丁不命中
  assert.equal(
    check(extractPatchPaths("*** Add File: src/a.ts")[0] ?? ""),
    null,
  );
});

test("提取 + 检查联动：shell 命令文本中的敏感路径被拦", () => {
  for (const cmd of [
    "cat ~/.ssh/id_rsa",
    "cp $HOME/.aws/credentials /tmp/x",
    "cat ./config/.env",
    "echo 'backup' >> ~/.kube/config",
  ]) {
    const paths = extractCommandPaths(cmd);
    const hit = paths
      .map((p) => checkSensitivePath(p, rules, HOME))
      .find((h) => h !== null);
    assert.notEqual(hit, null, `expected sensitive hit for: ${cmd}`);
  }
});

test("放行：allowedPaths 前缀与 glob 生效", () => {
  const allowed = compileSensitiveRules(
    [
      { id: "allow-ssh", path: "~/.ssh", reason: "放行" },
      { id: "allow-pem", path: "*.pem", reason: "放行" },
    ],
    HOME,
  );
  const norm = (p: string) => normalizePath(p, HOME);
  assert.ok(allowed.some((r) => r.matchPath(norm("~/.ssh/id_rsa"))));
  assert.ok(allowed.some((r) => r.matchPath(norm("certs/server.pem"))));
  assert.ok(!allowed.some((r) => r.matchPath(norm("~/.aws/credentials"))));
});

// ------------------------------------------------- 归一化与匹配的边角形态（阶段 2 补锚点）

test("归一化: 家目录的三种单独写法、引号与尾斜杠按字面保留", () => {
  assert.equal(normalizePath("${HOME}", HOME), HOME);
  assert.equal(normalizePath("$HOME", HOME), HOME);
  assert.equal(normalizePath("~", HOME), HOME);
  // 带引号与首尾空白: 引号剥掉、空白 trim
  assert.equal(normalizePath('  "~/x"  ', HOME), `${HOME}/x`);
  assert.equal(normalizePath("'$HOME/y'", HOME), `${HOME}/y`);
  // 尾斜杠不折叠（只折叠重复斜杠）; 空串原样
  assert.equal(normalizePath(`"${HOME}//z/"`, HOME), `${HOME}/z/`);
  assert.equal(normalizePath("", HOME), "");
});

test("basenameOf: 有分隔符取末段、无分隔符原样、末尾分隔符得空串", () => {
  assert.equal(basenameOf("a/b"), "b");
  assert.equal(basenameOf("plain.txt"), "plain.txt");
  assert.equal(basenameOf("a/b/"), "");
  assert.equal(basenameOf(""), "");
});

test("glob 条目: ** 跨目录、? 单字符、/** 结尾时目录本身也算命中", () => {
  const globRules: SensitiveRule[] = [
    { id: "glob-deep", path: "**/secrets/**", reason: "跨目录" },
    { id: "glob-one", path: "token?.txt", reason: "单字符" },
  ];
  const compiled = compileSensitiveRules(globRules, HOME);
  const check = (p: string) => checkSensitivePath(p, compiled, HOME)?.rule.id;
  // ** 跨 / ：任意深度命中，目录本身也命中
  assert.equal(check("/srv/secrets/a/b"), "glob-deep");
  assert.equal(check("/srv/secrets"), "glob-deep");
  assert.equal(check("/srv/public/a"), undefined);
  // ? 只吃一个字符，且不跨 /（basename 语义下按末段匹配）
  assert.equal(check("token1.txt"), "glob-one");
  assert.equal(check("token.txt"), undefined);
  assert.equal(check("token1.txtx"), undefined);
});

test("字面条目: 含 / 按完整路径子树匹配, 不含 / 按 basename 任意深度匹配", () => {
  const compiled = compileSensitiveRules(
    [
      { id: "literal-dir", path: "/opt/app/data", reason: "目录子树" },
      { id: "literal-name", path: "secret.txt", reason: "basename" },
    ],
    HOME,
  );
  const check = (p: string) => checkSensitivePath(p, compiled, HOME)?.rule.id;
  assert.equal(check("/opt/app/data"), "literal-dir");
  assert.equal(check("/opt/app/data/x/y"), "literal-dir");
  assert.equal(check("/opt/app/database"), undefined, "前缀须落在 / 边界上");
  assert.equal(check("/srv/secret.txt"), "literal-name");
  assert.equal(check("secret.txt"), "literal-name");
  assert.equal(check("/srv/secret.txt.bak"), undefined);
});

test("路径提取: 空命令返回空数组, 同一路径的带引号与裸 token 形态去重", () => {
  assert.deepEqual(extractCommandPaths(""), []);
  const paths = extractCommandPaths("cat .env '.env'");
  assert.equal(
    paths.filter((p) => p === ".env").length,
    1,
    `同一路径只留一份: ${JSON.stringify(paths)}`,
  );
  // 家目录前缀在无空格粘连时也能提取（< 重定向）
  assert.ok(
    extractCommandPaths("cat<~/.aws/credentials").includes(
      "~/.aws/credentials",
    ),
  );
});
