/**
 * 敏感文件保护单测：归一化 / 默认清单命中 / 路径提取 / 放行清单。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkSensitivePath,
  compileSensitiveRules,
  extractCommandPaths,
  normalizePath,
  DEFAULT_SENSITIVE_RULES,
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
