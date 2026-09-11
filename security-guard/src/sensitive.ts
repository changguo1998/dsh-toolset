/**
 * 敏感文件保护（纯函数层）：路径归一化、命令文本路径提取、规则匹配。
 *
 * 策略语义：「宁可误拦不可漏拦」。默认保护清单 = 凭据目录 / 凭据文件 /
 * env 文件 / 私钥文件。条目两种形式：
 * - 不含 glob 字符 → 字面路径：命中该路径本身及其整棵子树（目录前缀语义）；
 * - 含 `*` / `?` → glob：`*` 不跨 `/`，`**` 跨 `/`。
 * 不含 `/` 的条目（如 `.env`、`id_rsa`、`*.pem`）按 basename 匹配，
 * 任意深度都保护；含 `/` 的条目按归一化后的完整路径匹配。
 * 用户层通过 sensitiveFiles.rules 追加条目、通过 sensitiveFiles.allowedPaths 放行。
 */

/** 单条敏感路径规则。 */
export interface SensitiveRule {
  /** 稳定规则 id（回执与日志中展示）。 */
  id: string;
  /** 路径条目：字面路径或 glob（见文件头语义）。 */
  path: string;
  /** 人话原因（回执「原因」字段）。 */
  reason: string;
}

/** 敏感路径命中结果。 */
export interface SensitiveHit {
  rule: SensitiveRule;
  /** 提取出的原始路径文本（未归一化）。 */
  path: string;
}

/** 编译后的敏感路径规则（已归一化条目路径、已编译 glob）。 */
export interface CompiledSensitiveRule {
  id: string;
  reason: string;
  matchPath: (normalizedPath: string) => boolean;
}

/**
 * 路径归一化：去两端引号、展开 ~ / $HOME / ${HOME}、折叠重复斜杠。
 * 相对路径原样保留（按 basename 规则仍可命中）。
 */
export function normalizePath(input: string, home: string): string {
  let out = input.trim().replace(/^['"]+|['"]+$/g, "");
  if (out === "~" || out.startsWith("~/")) {
    out = home + out.slice(1);
  } else if (out === "$HOME" || out.startsWith("$HOME/")) {
    out = home + out.slice(5);
  } else if (out === "${HOME}" || out.startsWith("${HOME}/")) {
    out = home + out.slice(7);
  }
  return out.replace(/\/{2,}/g, "/");
}

/** 取归一化路径的 basename。 */
export function basenameOf(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/** glob 转正则源：`*` → [^/]*，`**` → .*，`?` → [^/]，其余字符转义。 */
function globToRegexSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

/** 条目是否含 glob 字符。 */
function isGlobEntry(entry: string): boolean {
  return entry.includes("*") || entry.includes("?");
}

/**
 * 编译敏感路径规则集。
 * 字面条目：basename 条目按 basename 精确匹配；完整路径条目按前缀（含子树）匹配。
 * glob 条目：以 `/**` 结尾时目录本身也算命中。
 */
export function compileSensitiveRules(
  rules: readonly SensitiveRule[],
  home: string,
): CompiledSensitiveRule[] {
  return rules.map((rule) => {
    const entry = normalizePath(rule.path, home);
    const basenameOnly = !entry.includes("/");
    if (isGlobEntry(entry)) {
      const body = entry.endsWith("/**") ? entry.slice(0, -3) : entry;
      const regex = new RegExp(`^${globToRegexSource(body)}$`);
      const dirRegex = entry.endsWith("/**")
        ? new RegExp(`^${globToRegexSource(body)}(?:/.*)?$`)
        : null;
      return {
        id: rule.id,
        reason: rule.reason,
        matchPath: (norm: string) => {
          if (dirRegex !== null && dirRegex.test(norm)) return true;
          return basenameOnly ? regex.test(basenameOf(norm)) : regex.test(norm);
        },
      };
    }
    // 字面条目
    return {
      id: rule.id,
      reason: rule.reason,
      matchPath: (norm: string) => {
        if (basenameOnly) return basenameOf(norm) === entry;
        return norm === entry || norm.startsWith(`${entry}/`);
      },
    };
  });
}

/** 在已编译规则集上检查一条路径，返回第一个命中的规则。 */
export function checkSensitivePath(
  inputPath: string,
  rules: readonly CompiledSensitiveRule[],
  home: string,
): SensitiveHit | null {
  const norm = normalizePath(inputPath, home);
  for (const rule of rules) {
    if (rule.matchPath(norm)) {
      return {
        rule: {
          id: rule.id,
          path: inputPath,
          reason: rule.reason,
        },
        path: inputPath,
      };
    }
  }
  return null;
}

/**
 * 从命令文本中提取路径候选（保守超集）：
 * 1) 成对引号内的字符串；
 * 2) 不含 = 的非选项 token（裸 token 也会参与 basename 规则匹配，如 `cat .env`）；
 * 3) ~/$HOME 前缀子串（覆盖 `cat<"$HOME/.aws/x"` 这类无空格粘连）；
 * 4) 绝对路径子串。
 */
export function extractCommandPaths(command: string): string[] {
  const found = new Set<string>();
  // 引号内字符串（保留内容、去掉引号本身）
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    const s = m[1] ?? m[2] ?? "";
    if (s.length > 0) found.add(s);
  }
  // 未加引号的 token：跳过选项（-开头）与 env 赋值（含 =）
  for (const token of command.split(/[\s|;&<>()]+/)) {
    if (token.length > 0 && !token.startsWith("-") && !token.includes("=")) {
      found.add(token);
    }
  }
  // 家目录前缀子串（处理 < 粘连、重定向无空格等写法）
  for (const m of command.matchAll(
    /(?:~|\$HOME|\$\{HOME\})\/[\w.@*-]+(?:\/[\w.@*-]+)*/g,
  )) {
    found.add(m[0]);
  }
  // 绝对路径子串
  for (const m of command.matchAll(/\/[\w.@*-]+(?:\/[\w.@*-]+)+/g)) {
    found.add(m[0]);
  }
  return [...found];
}

/** 默认敏感路径保护清单（保守集：凭据目录 + 凭据文件 + env + 私钥）。 */
export const DEFAULT_SENSITIVE_RULES: readonly SensitiveRule[] = [
  {
    id: "ssh-directory",
    path: "~/.ssh",
    reason: "OpenSSH 凭据目录（私钥、known_hosts、配置）",
  },
  { id: "aws-credentials", path: "~/.aws", reason: "AWS 凭据与配置目录" },
  { id: "gnupg-directory", path: "~/.gnupg", reason: "GPG 密钥环目录" },
  {
    id: "kube-directory",
    path: "~/.kube",
    reason: "Kubernetes 凭据目录（kubeconfig）",
  },
  {
    id: "gh-credentials",
    path: "~/.config/gh",
    reason: "GitHub CLI 凭据目录（token）",
  },
  {
    id: "gcloud-credentials",
    path: "~/.config/gcloud",
    reason: "GCloud 凭据目录",
  },
  {
    id: "docker-config",
    path: "~/.docker/config.json",
    reason: "Docker 凭据配置（registry token）",
  },
  { id: "netrc", path: ".netrc", reason: "netrc 明文凭据文件" },
  {
    id: "git-credentials",
    path: ".git-credentials",
    reason: "Git 凭据存储（含 token）",
  },
  { id: "npmrc", path: ".npmrc", reason: "npm 配置（可能含 registry token）" },
  { id: "pypirc", path: ".pypirc", reason: "PyPI 上传凭据文件" },
  { id: "env-file", path: ".env", reason: "env 环境变量文件（可能含密钥）" },
  {
    id: "env-variant",
    path: ".env.*",
    reason: "env 环境变量文件变体（可能含密钥）",
  },
  { id: "pem-key", path: "*.pem", reason: "PEM 私钥/证书文件" },
  { id: "key-file", path: "*.key", reason: "私钥文件（.key）" },
  { id: "pkcs12", path: "*.p12", reason: "PKCS#12 密钥库（含私钥）" },
  { id: "pkcs12-pfx", path: "*.pfx", reason: "PKCS#12 密钥库（含私钥）" },
  { id: "jks-keystore", path: "*.jks", reason: "Java 密钥库（含私钥）" },
  { id: "keystore", path: "*.keystore", reason: "密钥库文件（含私钥）" },
  { id: "ssh-rsa-key", path: "id_rsa", reason: "OpenSSH RSA 私钥" },
  { id: "ssh-ed25519-key", path: "id_ed25519", reason: "OpenSSH Ed25519 私钥" },
  { id: "ssh-ecdsa-key", path: "id_ecdsa", reason: "OpenSSH ECDSA 私钥" },
  { id: "ssh-dsa-key", path: "id_dsa", reason: "OpenSSH DSA 私钥" },
  {
    id: "gcp-credentials",
    path: "credentials.json",
    reason: "GCP 凭据 JSON（可能含服务账号密钥）",
  },
  {
    id: "service-account",
    path: "service-account*.json",
    reason: "服务账号凭据 JSON（可能含私钥）",
  },
  {
    id: "kubeconfig",
    path: "kubeconfig",
    reason: "Kubernetes 凭据配置（含 token）",
  },
];
