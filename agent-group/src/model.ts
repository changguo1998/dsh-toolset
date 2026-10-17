/**
 * 组状态的数据模型与**纯**状态迁移（不碰传输、不落盘、不读时钟）—— 与 `src/core.ts`
 * 的动作层分开，便于把连接规则、等级、未结指令、移除下推逐条写成可单测的纯函数。
 *
 * 不变量（决策项 7-10、14）：
 * - 组内名唯一；管理者固定 `manager`、等级恒 0、不能作为从方；
 * - 每 agent 至多一个主（`links` 以从方名为主键）；
 * - 自由代理 = 无主、无从、等级 0，只有自由代理能当从方；
 * - 等级沿主→从严格递增（从方等级 = 主方等级 + 1）；
 * - 每主从连接同时至多一条未结指令。
 */

import type {
  AgentGroupBook,
  AgentGroupState,
  GroupFailure,
  GroupInstruction,
  GroupLink,
  GroupMember,
  GroupView,
  InstructionOutcome,
} from "./types.ts";

/** 管理者的保留组内名（不能被 `add_member` 占用，也不能被 `remove` 移除）。 */
export const MANAGER_NAME = "manager";

/** 组名 / 成员名的共同字符口径（与全机别名同风格：窄、无空白、可直接进 JSON 与命令）。 */
export const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 构造失败信封（决策项 18：原因 + 下一步；`extra` 只放结构化的补充信息）。 */
export function failure(
  error: string,
  reason: string,
  next: string,
  extra: Record<string, unknown> = {},
): GroupFailure {
  return { ok: false, error, reason, next, ...extra };
}

/** 类型守卫：动作层用 `ok === false` 区分「成功迁移」与「拒绝」。 */
export function isFailure(value: unknown): value is GroupFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

/** 空状态（管理者尚未建组）。 */
export function emptyBook(managerSessionId: string): AgentGroupBook {
  return { version: 1, managerSessionId, groups: {} };
}

/** 名字校验（组名与成员名同口径）；返回原因串或 `undefined`。 */
export function nameError(label: string, name: string): string | undefined {
  if (name === "") return `${label}不能为空`;
  if (!NAME_RE.test(name))
    return `${label}须为 1-32 位 [A-Za-z0-9_-]（收到「${name}」）`;
  return undefined;
}

/** 取组；不存在 → 带下一步提示的拒绝。 */
export function pickGroup(
  book: AgentGroupBook,
  name: string,
): AgentGroupState | GroupFailure {
  const group = book.groups[name];
  if (group === undefined) {
    const names = Object.keys(book.groups);
    return failure(
      "group_not_found",
      `组「${name}」不存在（本会话现有组：${names.length === 0 ? "无" : names.join(", ")}）`,
      names.length === 0
        ? "先用 create_group 建组"
        : `group 用现有组名（${names.join(" / ")}），或用 status 查看`,
    );
  }
  return group;
}

/** 成员名校验 + 存在性（组内必须已有该成员），供各动作复用。 */
export function membersOf(group: AgentGroupState): string[] {
  return Object.keys(group.members).sort((a, b) => a.localeCompare(b));
}

/** 组内成员的从代理名单（按名字排序）。 */
export function subordinatesOf(group: AgentGroupState, name: string): string[] {
  return Object.values(group.links)
    .filter((link) => link.from === name)
    .map((link) => link.to)
    .sort((a, b) => a.localeCompare(b));
}

/** 该成员连接上的未结指令（没有 → `undefined`）。 */
export function openInstructionOf(
  group: AgentGroupState,
  memberName: string,
): GroupInstruction | undefined {
  return group.instructions.find(
    (instruction) =>
      instruction.to === memberName && instruction.status === "open",
  );
}

/** 默认组名（`group-1`、`group-2`…；跳过已占用的名字）。 */
export function defaultGroupName(book: AgentGroupBook): string {
  for (let i = 1; ; i += 1) {
    const name = `group-${i}`;
    if (book.groups[name] === undefined) return name;
  }
}

/**
 * 只保留最近 `max` 条**已结算**记录：未结指令（`open`）一律不裁 —— 裁掉它等于让那条连接
 * 「凭空可再发」，而它的远端任务还在跑（回报再也收不回来）。保持原有相对顺序。
 */
export function trimInstructions(
  instructions: readonly GroupInstruction[],
  max: number,
): GroupInstruction[] {
  const limit = Math.max(0, Math.floor(max));
  const open = instructions.filter((item) => item.status === "open");
  const settled = instructions.filter((item) => item.status !== "open");
  const keepSettled = Math.max(0, limit - open.length);
  const kept = new Set<GroupInstruction>([
    ...open,
    ...settled.slice(Math.max(0, settled.length - keepSettled)),
  ]);
  return instructions.filter((item) => kept.has(item));
}

/** 建组：管理者 = 调用方会话，作为固定成员 `manager`（等级 0）。 */
export function createGroup(
  book: AgentGroupBook,
  input: { name?: string; managerSessionId: string; now: number; id: string },
): { book: AgentGroupBook; group: AgentGroupState } | GroupFailure {
  const requested = (input.name ?? "").trim();
  const name = requested === "" ? defaultGroupName(book) : requested;
  const bad = nameError("组名", name);
  if (bad !== undefined) {
    return failure("invalid_argument", bad, "组名用 1-32 位 [A-Za-z0-9_-]");
  }
  if (book.groups[name] !== undefined) {
    return failure(
      "group_exists",
      `组「${name}」已存在`,
      `换一个组名，或用 status 查看组「${name}」`,
    );
  }
  const manager: GroupMember = {
    name: MANAGER_NAME,
    target: input.managerSessionId,
    sessionId: input.managerSessionId,
    level: 0,
    role: "manager",
    addedAt: input.now,
  };
  const group: AgentGroupState = {
    id: input.id,
    name,
    managerSessionId: input.managerSessionId,
    createdAt: input.now,
    members: { [MANAGER_NAME]: manager },
    links: {},
    instructions: [],
  };
  return {
    book: { ...book, groups: { ...book.groups, [name]: group } },
    group,
  };
}

/** 加成员：一次一个；目标须已由传输解析成会话 id（登记时在线，决策项 3）。 */
export function addMember(
  book: AgentGroupBook,
  input: {
    group: string;
    name: string;
    target: string;
    sessionId: string;
    now: number;
  },
):
  | { book: AgentGroupBook; group: AgentGroupState; member: GroupMember }
  | GroupFailure {
  const found = pickGroup(book, input.group);
  if (isFailure(found)) return found;
  const bad = nameError("成员名", input.name);
  if (bad !== undefined) {
    return failure("invalid_argument", bad, "成员名用 1-32 位 [A-Za-z0-9_-]");
  }
  if (input.name === MANAGER_NAME) {
    return failure(
      "manager_reserved",
      `「${MANAGER_NAME}」是管理者的保留名`,
      "换一个成员名（管理者的组内名固定为 manager）",
    );
  }
  if (input.target === "") {
    return failure(
      "invalid_argument",
      "target 不能为空",
      "target 用会话 id 或别名（见 session_channel 的 peers / alias list）",
    );
  }
  if (input.sessionId === "") {
    return failure(
      "target_offline",
      `目标「${input.target}」当前不可寻址`,
      "用 session_channel peers 确认目标在线后重试 add_member",
    );
  }
  const existing = found.members[input.name];
  if (existing !== undefined) {
    return failure(
      "member_exists",
      `组成员「${input.name}」已存在（target=${existing.target}）`,
      `换一个成员名，或先 remove name=${input.name} 再重加`,
    );
  }
  for (const member of Object.values(found.members)) {
    if (member.sessionId === input.sessionId) {
      return failure(
        "member_duplicate_target",
        `会话「${input.sessionId}」已以组内名「${member.name}」登记`,
        `直接用已有的「${member.name}」，或换一个目标会话`,
      );
    }
  }
  const member: GroupMember = {
    name: input.name,
    target: input.target,
    sessionId: input.sessionId,
    level: 0,
    role: "member",
    addedAt: input.now,
  };
  const group: AgentGroupState = {
    ...found,
    members: { ...found.members, [member.name]: member },
  };
  return {
    book: { ...book, groups: { ...book.groups, [found.name]: group } },
    group,
    member,
  };
}

/**
 * 建立主从连接（决策项 9：显式动作，当场校验从方是自由代理）。
 * 拒绝顺序固定：成员存在 → 自连 → 管理者不能当从 → 已有主 → 已有从 → 等级非 0 →
 * 等级守卫；每条拒绝都带原因与下一步。
 */
export function linkMembers(
  book: AgentGroupBook,
  input: { group: string; from: string; to: string; now: number },
):
  | { book: AgentGroupBook; group: AgentGroupState; link: GroupLink }
  | GroupFailure {
  const found = pickGroup(book, input.group);
  if (isFailure(found)) return found;
  const principal = found.members[input.from];
  const target = found.members[input.to];
  if (principal === undefined) {
    return failure(
      "member_not_found",
      `组里没有主方「${input.from}」`,
      `现有成员：${membersOf(found).join(", ")}`,
    );
  }
  if (target === undefined) {
    return failure(
      "member_not_found",
      `组里没有从方「${input.to}」`,
      `现有成员：${membersOf(found).join(", ")}`,
    );
  }
  if (principal.name === target.name) {
    return failure(
      "self_link",
      `不能把「${target.name}」连到它自己`,
      "from 与 to 用两个不同成员",
    );
  }
  if (target.role === "manager") {
    return failure(
      "level_violation",
      `管理者「${MANAGER_NAME}」等级固定为 0，不能作为从方（主等级 ${principal.level} ≥ 从等级 0）`,
      `把管理者作为主方：link from=${MANAGER_NAME} to=<成员>`,
    );
  }
  const holder = found.links[target.name];
  if (holder !== undefined) {
    return failure(
      "not_free_agent",
      `「${target.name}」已有主方「${holder.from}」，不是自由代理`,
      "本设计不允许解除连接（决策项 10）：改用另一个自由成员",
    );
  }
  const followers = subordinatesOf(found, target.name);
  if (followers.length > 0) {
    return failure(
      "not_free_agent",
      `「${target.name}」名下还有从代理：${followers.join(", ")}，不是自由代理`,
      `自由代理须无从：先逐层移除它的从代理（${followers
        .map((name) => `remove name=${name}`)
        .join(" / ")}），再连它`,
    );
  }
  if (target.level !== 0) {
    return failure(
      "not_free_agent",
      `「${target.name}」等级为 ${target.level}（自由代理须为 0）`,
      "改用等级 0 的成员，或先移除它名下连接（本设计不允许解除连接，见决策项 10）",
    );
  }
  const level = principal.level + 1;
  // 等级守卫（决策项 8）：主→从必须严格递增。自由代理恒为 0、主方恒 ≥ 0，故正常路径上
  // 由「自由代理」那几条挡住；这里保留断言式守卫，防状态被外部改动后连出环。
  if (principal.level >= level) {
    return failure(
      "level_violation",
      `连接后从方等级 ${level} 不大于主方等级 ${principal.level}，违反等级严格递增`,
      "检查组状态（status）是否被外部改动；必要时重建组",
    );
  }
  const link: GroupLink = {
    from: principal.name,
    to: target.name,
    level,
    createdAt: input.now,
  };
  const group: AgentGroupState = {
    ...found,
    members: {
      ...found.members,
      [target.name]: { ...target, level },
    },
    links: { ...found.links, [target.name]: link },
  };
  return {
    book: { ...book, groups: { ...book.groups, [found.name]: group } },
    group,
    link,
  };
}

/**
 * 打开一条未结指令（不投递）：校验主从连接存在、该连接上没有别的未结指令。
 * 投递由动作层做，成功后用 `assignTaskId` 补任务 id（决策项 14）。
 */
export function openInstruction(
  book: AgentGroupBook,
  input: {
    group: string;
    to: string;
    text: string;
    timeoutMs: number;
    now: number;
    id: string;
    maxRecords: number;
  },
):
  | {
      book: AgentGroupBook;
      group: AgentGroupState;
      instruction: GroupInstruction;
    }
  | GroupFailure {
  const found = pickGroup(book, input.group);
  if (isFailure(found)) return found;
  const target = found.members[input.to];
  if (target === undefined) {
    return failure(
      "member_not_found",
      `组里没有成员「${input.to}」`,
      `现有成员：${membersOf(found).join(", ")}`,
    );
  }
  if (target.role === "manager") {
    return failure(
      "no_principal",
      `管理者「${MANAGER_NAME}」是组的根，没有主方可以给它发指令`,
      `to 用某个从方（先 link from=${MANAGER_NAME} to=<成员>）`,
    );
  }
  const link = found.links[target.name];
  if (link === undefined) {
    return failure(
      "no_principal",
      `「${target.name}」还没有主方（主从连接未建立）`,
      `先 link from=<主方> to=${target.name}`,
    );
  }
  const open = openInstructionOf(found, target.name);
  if (open !== undefined) {
    return failure(
      "instruction_open",
      `「${target.name}」的连接上已有一条未结指令（${open.id}，${input.now - open.sentAt} ms 前发出）`,
      "先 check 结算该指令（或等它超时），再发下一条（决策项 14：每连接同时只允许一条）",
    );
  }
  const text = input.text.trim();
  if (text === "") {
    return failure(
      "invalid_argument",
      "指令正文不能为空",
      "text 写清要该成员做什么；成员回报会原样带回（本包不解析正文）",
    );
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    return failure(
      "invalid_argument",
      `timeoutMs 须为正数（收到 ${String(input.timeoutMs)}）`,
      "缺省由配置 defaultTimeoutMs 给（30 分钟）；显式给毫秒数即可",
    );
  }
  const timeoutMs = Math.floor(input.timeoutMs);
  const principal = found.members[link.from];
  const fromSessionId =
    principal !== undefined && principal.sessionId !== ""
      ? principal.sessionId
      : found.managerSessionId;
  const instruction: GroupInstruction = {
    id: input.id,
    from: link.from,
    to: target.name,
    text,
    fromSessionId,
    timeoutMs,
    sentAt: input.now,
    deadline: input.now + timeoutMs,
    status: "open",
  };
  const group: AgentGroupState = {
    ...found,
    instructions: trimInstructions(
      [...found.instructions, instruction],
      input.maxRecords,
    ),
  };
  return {
    book: { ...book, groups: { ...book.groups, [found.name]: group } },
    group,
    instruction,
  };
}

/** 给未结指令补任务 id（投递成功后调用；找不到 / 已结算 → 拒绝）。 */
export function assignTaskId(
  book: AgentGroupBook,
  input: { group: string; instructionId: string; taskId: string },
): { book: AgentGroupBook; group: AgentGroupState } | GroupFailure {
  const found = pickGroup(book, input.group);
  if (isFailure(found)) return found;
  const current = found.instructions.find((i) => i.id === input.instructionId);
  if (current === undefined) {
    return failure(
      "instruction_not_found",
      `找不到指令 ${input.instructionId}`,
      "指令记录可能已被裁剪（maxInstructionRecords）；用 status 看最近回报",
    );
  }
  if (current.status !== "open") {
    return failure(
      "instruction_settled",
      `指令 ${input.instructionId} 已结算（${current.status}）`,
      "无需再写任务 id；用 status 查看最近回报",
    );
  }
  const group: AgentGroupState = {
    ...found,
    instructions: found.instructions.map((instruction) =>
      instruction.id === input.instructionId
        ? { ...instruction, taskId: input.taskId }
        : instruction,
    ),
  };
  return {
    book: { ...book, groups: { ...book.groups, [found.name]: group } },
    group,
  };
}

/** 结算一条未结指令（懒判定由动作层做，这里只落状态）。 */
export function settleInstruction(
  book: AgentGroupBook,
  input: {
    group: string;
    instructionId: string;
    status: InstructionOutcome;
    result?: string;
    cause?: string;
    now: number;
  },
):
  | {
      book: AgentGroupBook;
      group: AgentGroupState;
      instruction: GroupInstruction;
    }
  | GroupFailure {
  const found = pickGroup(book, input.group);
  if (isFailure(found)) return found;
  const current = found.instructions.find((i) => i.id === input.instructionId);
  if (current === undefined) {
    return failure(
      "instruction_not_found",
      `找不到指令 ${input.instructionId}`,
      "指令记录可能已被裁剪（maxInstructionRecords）；用 status 看最近回报",
    );
  }
  if (current.status !== "open") {
    return failure(
      "instruction_settled",
      `指令 ${input.instructionId} 已结算（${current.status}）`,
      "无需重复结算；用 status 查看最近回报",
    );
  }
  const instruction: GroupInstruction = {
    ...current,
    status: input.status,
    settledAt: input.now,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
  const group: AgentGroupState = {
    ...found,
    instructions: found.instructions.map((item) =>
      item.id === instruction.id ? instruction : item,
    ),
  };
  return {
    book: { ...book, groups: { ...book.groups, [found.name]: group } },
    group,
    instruction,
  };
}

/**
 * 移除成员（决策项 10：逐层下推，不做级联）。非叶子被拒，并在提示里列出剩余从代理；
 * 被移除成员连接上的未结指令结算为 `removed`（失败成因，决策项 14）。
 */
export function removeMember(
  book: AgentGroupBook,
  input: { group: string; name: string; now: number },
):
  | {
      book: AgentGroupBook;
      group: AgentGroupState;
      removed: GroupMember;
      settled: GroupInstruction | undefined;
    }
  | GroupFailure {
  const found = pickGroup(book, input.group);
  if (isFailure(found)) return found;
  if (input.name === MANAGER_NAME) {
    return failure(
      "manager_reserved",
      `管理者「${MANAGER_NAME}」是组的根，不能移除`,
      "要换管理者就另建一个组（create_group），或移除它的从代理",
    );
  }
  const member = found.members[input.name];
  if (member === undefined) {
    return failure(
      "member_not_found",
      `组里没有成员「${input.name}」`,
      `现有成员：${membersOf(found).join(", ")}`,
    );
  }
  const followers = subordinatesOf(found, member.name);
  if (followers.length > 0) {
    return failure(
      "not_leaf",
      `「${member.name}」名下还有从代理：${followers.join(", ")}（非叶子不能直接移除）`,
      `先逐层移除它的从代理：${followers
        .map((name) => `remove name=${name}`)
        .join(" / ")}，再移除「${member.name}」`,
      { subordinates: followers },
    );
  }
  const open = openInstructionOf(found, member.name);
  const settled: GroupInstruction | undefined =
    open === undefined
      ? undefined
      : {
          ...open,
          status: "removed",
          cause: "成员已被移除",
          settledAt: input.now,
        };
  const members = { ...found.members };
  delete members[member.name];
  const links = { ...found.links };
  delete links[member.name];
  const group: AgentGroupState = {
    ...found,
    members,
    links,
    instructions:
      settled === undefined
        ? [...found.instructions]
        : found.instructions.map((item) =>
            item.id === settled.id ? settled : item,
          ),
  };
  return {
    book: { ...book, groups: { ...book.groups, [found.name]: group } },
    group,
    removed: member,
    settled,
  };
}

/**
 * 只读视图（`status` 动作与镜像正文共用）：成员（含主方 / 从代理）、连接、指令记录、计数。
 * 可选字段按需拼装 —— 返回体必须是 lossless JSON。
 */
export function groupView(
  group: AgentGroupState,
  options: { instructionLimit?: number } = {},
): GroupView {
  const limit = options.instructionLimit ?? 20;
  const members = Object.values(group.members)
    .map((member) => ({
      name: member.name,
      target: member.target,
      sessionId: member.sessionId,
      level: member.level,
      role: member.role,
      principal: group.links[member.name]?.from ?? null,
      subordinates: subordinatesOf(group, member.name),
    }))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  const links = Object.values(group.links)
    .map((link) => ({
      from: link.from,
      to: link.to,
      level: link.level,
      createdAt: link.createdAt,
    }))
    .sort((a, b) => a.level - b.level || a.to.localeCompare(b.to));
  const instructions = [...group.instructions]
    .sort((a, b) => b.sentAt - a.sentAt)
    .slice(0, limit)
    .map((instruction) => ({
      id: instruction.id,
      from: instruction.from,
      to: instruction.to,
      status: instruction.status,
      text: instruction.text,
      ...(instruction.taskId === undefined
        ? {}
        : { taskId: instruction.taskId }),
      sentAt: instruction.sentAt,
      deadline: instruction.deadline,
      ...(instruction.settledAt === undefined
        ? {}
        : { settledAt: instruction.settledAt }),
      ...(instruction.result === undefined
        ? {}
        : { result: instruction.result }),
      ...(instruction.cause === undefined ? {} : { cause: instruction.cause }),
    }));
  const count = (status: InstructionOutcome | "open"): number =>
    group.instructions.filter((item) => item.status === status).length;
  return {
    name: group.name,
    id: group.id,
    manager: {
      name: MANAGER_NAME,
      sessionId: group.managerSessionId,
    },
    createdAt: group.createdAt,
    members,
    links,
    instructions,
    summary: {
      members: members.length,
      links: links.length,
      open: count("open"),
      success: count("success"),
      failure: count("failure"),
      blocked: count("blocked"),
      timeout: count("timeout"),
      removed: count("removed"),
    },
  };
}

/**
 * 不变量自检（返回违规清单；空数组 = 一致）。用于「状态被外部改动」的防御与单测：
 * 等级严格递增、连接两端存在、每 agent 至多一主、自由代理等级 0、无环。
 */
export function invariantViolations(group: AgentGroupState): string[] {
  const problems: string[] = [];
  for (const [name, link] of Object.entries(group.links)) {
    const principal = group.members[link.from];
    const target = group.members[link.to];
    if (link.to !== name) {
      problems.push(`连接键「${name}」与从方「${link.to}」不一致`);
    }
    if (principal === undefined) {
      problems.push(`连接 ${link.from} → ${link.to} 的主方不存在`);
      continue;
    }
    if (target === undefined) {
      problems.push(`连接 ${link.from} → ${link.to} 的从方不存在`);
      continue;
    }
    if (target.role === "manager") {
      problems.push(`管理者不能作为从方（连接 ${link.from} → ${link.to}）`);
    }
    if (link.level !== principal.level + 1) {
      problems.push(
        `连接 ${link.from}(${principal.level}) → ${link.to}(${link.level}) 等级不严格递增`,
      );
    }
    if (target.level !== link.level) {
      problems.push(
        `从方「${link.to}」等级 ${target.level} 与连接等级 ${link.level} 不一致`,
      );
    }
  }
  for (const member of Object.values(group.members)) {
    const principal = group.links[member.name];
    if (principal === undefined && member.level !== 0) {
      problems.push(
        `自由代理「${member.name}」等级为 ${member.level}（应为 0）`,
      );
    }
  }
  // 环检测：从每个成员沿「主方」上溯，步数超过成员数即视为环。
  for (const name of Object.keys(group.members)) {
    let cursor = name;
    let steps = 0;
    while (group.links[cursor] !== undefined) {
      cursor = group.links[cursor]!.from;
      steps += 1;
      if (steps > Object.keys(group.members).length) {
        problems.push(`主从连接成环（从「${name}」上溯超过成员数）`);
        break;
      }
    }
  }
  return problems;
}
