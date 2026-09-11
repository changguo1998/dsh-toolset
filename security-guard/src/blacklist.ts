/**
 * 危险命令黑名单匹配（纯函数层，无宿主依赖，可独立单测）。
 *
 * 策略语义：「宁可误拦不可漏拦」——默认规则集覆盖灾难性类别
 * （递归删除根/家目录、提权、远程管道执行、fork 炸弹、裸盘写入、重启关机、
 * 分区破坏等）。用户层配置只追加规则与放行模式，不能移除默认规则
 * （整体关闭某一层用 enabled=false）。
 */

/** 单条黑名单规则：id + 命中判定 + 人话命中原因（用于回执）。 */
export interface CommandRule {
  /** 稳定规则 id（回执与日志中展示）。 */
  id: string;
  /** 命中的人话原因（回执「原因」字段）。 */
  reason: string;
  /** 正则检测源（不锚定，按子串语义匹配整段命令文本）；与 test 二选一。 */
  pattern?: string;
  /** 自定义谓词检测（内置规则用它实现精确的命令语义）；与 pattern 二选一。 */
  test?: (command: string) => boolean;
}

/** 黑名单命中结果。 */
export interface CommandHit {
  rule: CommandRule;
  command: string;
}

/**
 * 把复合命令切成独立段（按 ; | & 换行切分，引号内的分隔符不切）。
 * 仅用于 rm/chmod 的逐段命令词法分析；管道类规则直接对整段文本做正则。
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of command) {
    // 引号内原样累积，直到配对引号闭合
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    // 遇到段分隔符：落段并开新段
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
      if (current.trim().length > 0) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) segments.push(current.trim());
  return segments;
}

/** 去掉字符串两端成对的引号（单引号或双引号）。 */
export function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const head = t[0]!;
    const tail = t[t.length - 1]!;
    if ((head === "'" && tail === "'") || (head === '"' && tail === '"')) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** 高危 rm 目标：/ ~ $HOME . （及带尾斜杠或 * 的形式）。 */
const DANGEROUS_RM_TARGET =
  /^(?:\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\.|\.\/)(?:\*)?$/;

/**
 * 嵌入式 rm 危险删除的整文本兜底正则：捕获词法分段找不到的形式
 * （run_code 代码字符串、引号命令内嵌 rm -rf / 等）。
 * 要求「rm + 递归标志 + 高危目标」紧邻，目标后须为引号/空白/分隔符/串尾，
 * 避免 /tmp/app、node_modules 等普通目标被误判。
 */
const EMBEDDED_RM_RE =
  /\brm\s+(?:\S+\s+)*?-(?:r|R)[a-zA-Z]*\s+(?:--no-preserve-root\s+)?['"]?(\/\*?|~\/|\$HOME\/?|\$\{HOME\}\/?|\.\/?)(?=['"\s,;)]|$)/;

/**
 * rm 递归删除根/家目录/当前目录判定：
 * 逐段取首个词（允许前导 env 赋值与带路径的 rm），要求递归标志（-r/-R/--recursive）
 * 且至少一个目标属于高危目标集；--no-preserve-root 出现即命中。
 */
export function rmRecursiveRootHit(command: string): boolean {
  if (EMBEDDED_RM_RE.test(command)) return true;
  if (/--no-preserve-root\b/.test(command)) return true;
  for (const segment of splitCommandSegments(command)) {
    const words = segment.split(/\s+/).filter(Boolean);
    let i = 0;
    // 跳过前导 env 赋值（FOO=bar rm ...）
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    if (i >= words.length) continue;
    const cmd = words[i]!;
    if (basenameOf(cmd) !== "rm") continue;
    // 收集递归标志与位置参数（目标）
    let recursive = false;
    const targets: string[] = [];
    for (const w of words.slice(i + 1)) {
      if (w.startsWith("--")) {
        if (w === "--recursive") recursive = true;
      } else if (w.startsWith("-")) {
        if (/[rR]/.test(w.slice(1))) recursive = true;
      } else {
        targets.push(stripQuotes(w));
      }
    }
    if (!recursive) continue;
    if (targets.some((t) => DANGEROUS_RM_TARGET.test(t))) return true;
  }
  return false;
}

/** 远程下载脚本直接管道进 shell（curl|sh 一族）及 $()/反引号/进程替换形式。 */
export function remotePipeShellHit(command: string): boolean {
  // curl/wget ... | (sudo) sh 形式
  const pipeToShell =
    /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/;
  // sh -c "$(curl ...)" 形式
  const substShell = /\b(?:ba|z|da|k)?sh\b[^\n]*?\$\(\s*(?:curl|wget)\b/;
  // sh -c `curl ...` 反引号形式
  const substShellTick = /\b(?:ba|z|da|k)?sh\b[^\n]*?`[^`\n]*\b(?:curl|wget)\b/;
  // bash <(curl ...) 进程替换形式
  const procSubst = /\b(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)\b/;
  return (
    pipeToShell.test(command) ||
    substShell.test(command) ||
    substShellTick.test(command) ||
    procSubst.test(command)
  );
}

/** 裸块设备名（sd、nvme、hd、vd、xvd 系列）；/dev/null、/dev/zero 等虚拟设备不算。 */
const RAW_DEVICE =
  /(?:sd[A-Za-z]+|nvme[A-Za-z0-9._-]+|hd[A-Za-z]+|vd[A-Za-z]+|xvd[A-Za-z]+)/;

/**
 * chmod 777 系统目录判定：
 * 逐段取 chmod，要求 mode 恰为 777 且目标属于高危系统目录
 * （/ ~ $HOME /etc /usr /bin /sbin /boot /var 及其子树）。
 */
export function chmod777RootHit(command: string): boolean {
  const DANGEROUS_CHMOD_TARGET =
    /^(?:\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\/etc|\/usr|\/bin|\/sbin|\/boot|\/var)(?:\/.*)?$/;
  for (const segment of splitCommandSegments(command)) {
    const words = segment.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    if (i >= words.length) continue;
    if (basenameOf(words[i]!) !== "chmod") continue;
    let mode: string | null = null;
    const targets: string[] = [];
    for (const w of words.slice(i + 1)) {
      if (w.startsWith("-")) continue; // 递归标志等不影响 777 判定
      if (mode === null && /^[0-7]{3,4}$/.test(w)) {
        mode = w;
      } else if (!w.startsWith("-")) {
        targets.push(stripQuotes(w));
      }
    }
    if (mode === "777" && targets.some((t) => DANGEROUS_CHMOD_TARGET.test(t)))
      return true;
  }
  return false;
}

/** 取路径的最后一段（无路径分隔符时原样返回）。 */
function basenameOf(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/**
 * 默认危险命令黑名单（保守集）。
 * 规则顺序即回执优先级：先精确的灾难性语义（rm/chmod/远程管道），
 * 再宽口径的模式类（sudo、dd、mkfs、重启等）。
 */
export const DEFAULT_COMMAND_RULES: readonly CommandRule[] = [
  {
    id: "rm-recursive-root",
    reason: "递归删除根目录/家目录/当前目录，属不可逆数据破坏",
    test: rmRecursiveRootHit,
  },
  {
    id: "remote-pipe-shell",
    reason: "远程下载的脚本被直接送入 shell 执行，等同任意远程代码执行",
    test: remotePipeShellHit,
  },
  {
    id: "chmod-777-system",
    reason: "chmod 777 系统目录，破坏系统权限边界",
    test: chmod777RootHit,
  },
  {
    id: "sudo",
    reason: "提权（sudo）执行，超出本会话的权限边界",
    pattern: "\\bsudo\\b",
  },
  {
    id: "fork-bomb",
    reason: "fork 炸弹，会耗尽进程表拖垮整机",
    pattern: ":\\(\\s*\\)\\s*\\{[^}]*:\\s*\\|\\s*:[^}]*&[^}]*\\}\\s*;\\s*:",
  },
  {
    id: "dd-raw-device",
    reason: "dd 直接写入裸块设备，会破坏磁盘分区与数据",
    pattern: `\\bdd\\b[^|;&\\n]*\\bof\\s*=\\s*/dev/${RAW_DEVICE.source}`,
  },
  {
    id: "raw-device-write",
    reason: "shell 重定向/tee 直接写入裸块设备",
    pattern: `(?:>>?|\\btee\\b)\\s*/dev/${RAW_DEVICE.source}`,
  },
  {
    id: "mkfs",
    reason: "文件系统格式化，不可逆销毁磁盘数据",
    pattern: "\\bmkfs(?:\\.[A-Za-z0-9]+)?\\b",
  },
  {
    id: "wipefs",
    reason: "wipefs 清除磁盘文件系统签名，属破坏性操作",
    pattern: "\\bwipefs\\b",
  },
  {
    id: "partition-tool",
    reason: "分区工具直接操作裸磁盘设备",
    pattern: `\\b(?:fdisk|parted)\\b[^|;&\\n]*\\s/dev/${RAW_DEVICE.source}`,
  },
  {
    id: "reboot-class",
    reason: "关机/重启系统，会中断所有在跑的业务",
    pattern: "\\b(?:shutdown|reboot|halt|poweroff)\\b",
  },
  {
    id: "find-delete",
    reason: "find 组合 -delete / -exec rm，可能批量删除预期之外的文件",
    pattern: "\\bfind\\b[^|;&\\n]*?(?:-delete\\b|-exec\\s+(?:sudo\\s+)?rm\\b)",
  },
  {
    id: "crontab-remove",
    reason: "crontab -r 清空整个用户的定时任务表",
    pattern: "\\bcrontab\\s+(?:-\\S+\\s+)*-r\\b",
  },
  {
    id: "iptables-flush",
    reason: "iptables -F 清空防火墙规则，破坏网络安全策略",
    pattern: "\\biptables\\s+(?:-\\S+\\s+)*-F\\b",
  },
  {
    id: "kill-pid1",
    reason: "kill PID 1，会杀死会话宿主进程",
    pattern: "\\bkill\\s+(?:-\\S+\\s+)*1\\b(?!\\d)",
  },
];

/** 编译单条规则的正则源；返回 null 表示源非法（命中时按保守策略视为命中）。 */
function compilePattern(source: string | undefined): RegExp | null {
  if (source === undefined) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/**
 * 在规则集上匹配命令文本，返回第一个命中的规则（保守策略下
 * 规则源非法的正则也按命中处理，避免配置笔误导致漏拦）。
 */
export function matchCommand(
  command: string,
  rules: readonly CommandRule[],
): CommandHit | null {
  for (const rule of rules) {
    if (rule.test !== undefined) {
      if (rule.test(command)) return { rule, command };
      continue;
    }
    const re = compilePattern(rule.pattern);
    if (re === null || re.test(command)) return { rule, command };
  }
  return null;
}

/**
 * 编译用户层放行正则（commandBlacklist.allowPatterns）。
 * 与黑名单的保守方向相反：放行侧配置笔误时不放行（宁拦勿放）。
 */
export function compileAllowPatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p));
    } catch {
      // 非法放行正则 → 忽略（不放行）
    }
  }
  return out;
}

/** 命令文本是否被任一放行模式匹配（命中则跳过命令黑名单层）。 */
export function isCommandAllowed(
  command: string,
  allowPatterns: readonly RegExp[],
): boolean {
  return allowPatterns.some((re) => re.test(command));
}
