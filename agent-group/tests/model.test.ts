/**
 * 数据模型单测（纯函数层）：建组 / 加成员 / 建连接（含等级与自由代理规则）/ 未结指令 /
 * 结算 / 移除下推 / 只读视图 / 不变量自检。全部不碰传输、不落盘、不读时钟。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addMember,
  assignTaskId,
  createGroup,
  emptyBook,
  groupView,
  invariantViolations,
  isFailure,
  linkMembers,
  linkPeer,
  MANAGER_NAME,
  openInstruction,
  openInstructionOf,
  peerPairKey,
  peerLinksOf,
  removeMember,
  settleInstruction,
} from "../src/model.ts";
import type {
  AgentGroupBook,
  AgentGroupState,
  GroupFailure,
} from "../src/types.ts";

const NOW = 1_000_000;
const MANAGER = "sess-manager";

/** 建一个「管理者 + 两个成员（alice / bob）」的组，供各用例起手。 */
function fixture(): { book: AgentGroupBook; group: AgentGroupState } {
  const created = createGroup(emptyBook(MANAGER), {
    name: "team",
    managerSessionId: MANAGER,
    now: NOW,
    id: "g-1",
  });
  assert.ok(!isFailure(created));
  let book = created.book;
  for (const [name, sessionId] of [
    ["alice", "sess-alice"],
    ["bob", "sess-bob"],
  ] as const) {
    const added = addMember(book, {
      group: "team",
      name,
      target: sessionId,
      sessionId,
      now: NOW,
    });
    assert.ok(!isFailure(added));
    book = added.book;
  }
  const group = book.groups["team"];
  assert.ok(group);
  return { book, group };
}

function expectFailure(value: unknown): GroupFailure {
  assert.ok(isFailure(value), `应为拒绝，实际：${JSON.stringify(value)}`);
  assert.equal(typeof value.reason, "string");
  assert.notEqual(value.reason, "");
  assert.equal(typeof value.next, "string");
  assert.notEqual(value.next, "");
  return value;
}

test("建组：缺省组名自增、管理者是固定成员（等级 0）、重名与非法名被拒", () => {
  const first = createGroup(emptyBook(MANAGER), {
    managerSessionId: MANAGER,
    now: NOW,
    id: "g-1",
  });
  assert.ok(!isFailure(first));
  assert.equal(first.group.name, "group-1");
  assert.deepEqual(Object.keys(first.group.members), [MANAGER_NAME]);
  const manager = first.group.members[MANAGER_NAME];
  assert.equal(manager?.level, 0);
  assert.equal(manager?.role, "manager");
  assert.equal(manager?.sessionId, MANAGER);

  const second = createGroup(first.book, {
    managerSessionId: MANAGER,
    now: NOW,
    id: "g-2",
  });
  assert.ok(!isFailure(second));
  assert.equal(second.group.name, "group-2");

  expectFailure(
    createGroup(first.book, {
      name: "group-1",
      managerSessionId: MANAGER,
      now: NOW,
      id: "g-3",
    }),
  );
  expectFailure(
    createGroup(first.book, {
      name: "带空格 的名字",
      managerSessionId: MANAGER,
      now: NOW,
      id: "g-4",
    }),
  );
});

test("加成员：一次一个；manager 是保留名；重名与重复会话被拒", () => {
  const { book } = fixture();
  expectFailure(
    addMember(book, {
      group: "team",
      name: MANAGER_NAME,
      target: "sess-x",
      sessionId: "sess-x",
      now: NOW,
    }),
  );
  expectFailure(
    addMember(book, {
      group: "team",
      name: "alice",
      target: "sess-other",
      sessionId: "sess-other",
      now: NOW,
    }),
  );
  const dup = expectFailure(
    addMember(book, {
      group: "team",
      name: "carol",
      target: "sess-alice",
      sessionId: "sess-alice",
      now: NOW,
    }),
  );
  assert.equal(dup.error, "member_duplicate_target");
  expectFailure(
    addMember(book, {
      group: "team",
      name: "carol",
      target: "",
      sessionId: "sess-carol",
      now: NOW,
    }),
  );
  expectFailure(
    addMember(book, {
      group: "team",
      name: "carol",
      target: "sess-carol",
      sessionId: "",
      now: NOW,
    }),
  );
  const added = addMember(book, {
    group: "team",
    name: "carol",
    target: "carol-alias",
    sessionId: "sess-carol",
    now: NOW,
  });
  assert.ok(!isFailure(added));
  assert.equal(added.member.level, 0);
  assert.equal(added.member.target, "carol-alias");
});

test("建连接：从方等级 = 主方 + 1；等级沿链递增；环构造不出来", () => {
  const { book } = fixture();
  const first = linkMembers(book, {
    group: "team",
    from: MANAGER_NAME,
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(first));
  assert.equal(first.link.level, 1);
  assert.equal(first.group.members["alice"]?.level, 1);

  // alice（等级 1）可以再收 bob（等级 2）
  const second = linkMembers(first.book, {
    group: "team",
    from: "alice",
    to: "bob",
    now: NOW,
  });
  assert.ok(!isFailure(second));
  assert.equal(second.link.level, 2);
  assert.equal(second.group.members["bob"]?.level, 2);
  assert.deepEqual(invariantViolations(second.group), []);
});

test("建连接拒绝：自由代理规则逐条可查（自连 / 管理者 / 已有主 / 已有从 / 等级非 0）", () => {
  const { book } = fixture();
  const linked = linkMembers(book, {
    group: "team",
    from: MANAGER_NAME,
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(linked));

  assert.equal(
    expectFailure(
      linkMembers(linked.book, {
        group: "team",
        from: "alice",
        to: "alice",
        now: NOW,
      }),
    ).error,
    "self_link",
  );
  // 管理者等级 0，作为从方违反「主等级 < 从等级」
  const toManager = expectFailure(
    linkMembers(book, {
      group: "team",
      from: "alice",
      to: MANAGER_NAME,
      now: NOW,
    }),
  );
  assert.equal(toManager.error, "level_violation");
  assert.match(toManager.reason, /等级/);
  // alice 已有主
  assert.equal(
    expectFailure(
      linkMembers(linked.book, {
        group: "team",
        from: "bob",
        to: "alice",
        now: NOW,
      }),
    ).error,
    "not_free_agent",
  );
  // 无主但名下已有从代理 → 不能当从方；提示里要列出剩余从代理
  const withCarol = addMember(linked.book, {
    group: "team",
    name: "carol",
    target: "sess-carol",
    sessionId: "sess-carol",
    now: NOW,
  });
  assert.ok(!isFailure(withCarol));
  const carolLeads = linkMembers(withCarol.book, {
    group: "team",
    from: "carol",
    to: "bob",
    now: NOW,
  });
  assert.ok(!isFailure(carolLeads));
  const hasFollowers = expectFailure(
    linkMembers(carolLeads.book, {
      group: "team",
      from: MANAGER_NAME,
      to: "carol",
      now: NOW,
    }),
  );
  assert.equal(hasFollowers.error, "not_free_agent");
  assert.match(hasFollowers.reason, /bob/);
  // 等级非 0（外部改过的状态）
  const tweaked: AgentGroupBook = {
    ...linked.book,
    groups: {
      team: {
        ...linked.group,
        members: {
          ...linked.group.members,
          bob: { ...linked.group.members["bob"]!, level: 3 },
        },
      },
    },
  };
  assert.equal(
    expectFailure(
      linkMembers(tweaked, {
        group: "team",
        from: MANAGER_NAME,
        to: "bob",
        now: NOW,
      }),
    ).error,
    "not_free_agent",
  );
  expectFailure(
    linkMembers(book, {
      group: "team",
      from: "nobody",
      to: "alice",
      now: NOW,
    }),
  );
});

test("未结指令：须先有主从连接；每连接同时只允许一条；超时上限校验", () => {
  const { book } = fixture();
  const unlinked = expectFailure(
    openInstruction(book, {
      group: "team",
      to: "alice",
      text: "做点事",
      timeoutMs: 60_000,
      now: NOW,
      id: "i-0",
      maxRecords: 50,
    }),
  );
  assert.equal(unlinked.error, "no_principal");
  assert.match(unlinked.next, /link/);

  const linked = linkMembers(book, {
    group: "team",
    from: MANAGER_NAME,
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(linked));

  const first = openInstruction(linked.book, {
    group: "team",
    to: "alice",
    text: "  写一份设计  ",
    timeoutMs: 60_000,
    now: NOW,
    id: "i-1",
    maxRecords: 50,
  });
  assert.ok(!isFailure(first));
  assert.equal(first.instruction.text, "写一份设计");
  assert.equal(first.instruction.status, "open");
  assert.equal(first.instruction.from, MANAGER_NAME);
  assert.equal(first.instruction.fromSessionId, MANAGER);
  assert.equal(first.instruction.deadline, NOW + 60_000);

  const second = expectFailure(
    openInstruction(first.book, {
      group: "team",
      to: "alice",
      text: "再做一件",
      timeoutMs: 60_000,
      now: NOW + 1,
      id: "i-2",
      maxRecords: 50,
    }),
  );
  assert.equal(second.error, "instruction_open");
  assert.match(second.next, /check/);

  expectFailure(
    openInstruction(first.book, {
      group: "team",
      to: "bob",
      text: "  ",
      timeoutMs: 60_000,
      now: NOW,
      id: "i-3",
      maxRecords: 50,
    }),
  );
  expectFailure(
    openInstruction(first.book, {
      group: "team",
      to: "bob",
      text: "x",
      timeoutMs: 0,
      now: NOW,
      id: "i-4",
      maxRecords: 50,
    }),
  );
  // 管理者没有主方
  assert.equal(
    expectFailure(
      openInstruction(first.book, {
        group: "team",
        to: MANAGER_NAME,
        text: "x",
        timeoutMs: 1000,
        now: NOW,
        id: "i-5",
        maxRecords: 50,
      }),
    ).error,
    "no_principal",
  );
});

test("指令记录按上限裁剪（保留最新），未结指令仍可定位", () => {
  const { book } = fixture();
  let current = linkMembers(book, {
    group: "team",
    from: MANAGER_NAME,
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(current));
  let working = current.book;
  for (let i = 0; i < 4; i += 1) {
    const opened = openInstruction(working, {
      group: "team",
      to: "alice",
      text: `第 ${i} 条`,
      timeoutMs: 1000,
      now: NOW + i,
      id: `i-${i}`,
      maxRecords: 2,
    });
    assert.ok(!isFailure(opened));
    const settled = settleInstruction(opened.book, {
      group: "team",
      instructionId: `i-${i}`,
      status: "success",
      result: `回报 ${i}`,
      now: NOW + i,
    });
    assert.ok(!isFailure(settled));
    working = settled.book;
  }
  const group = working.groups["team"];
  assert.equal(group?.instructions.length, 2);
  assert.deepEqual(
    group?.instructions.map((item) => item.id),
    ["i-2", "i-3"],
  );
});

test("指令记录裁剪不裁未结指令（裁掉未结会让连接凭空可再发）", () => {
  const { book } = fixture();
  const alice = linkMembers(book, {
    group: "team",
    from: MANAGER_NAME,
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(alice));
  const bob = linkMembers(alice.book, {
    group: "team",
    from: MANAGER_NAME,
    to: "bob",
    now: NOW,
  });
  assert.ok(!isFailure(bob));

  const first = openInstruction(bob.book, {
    group: "team",
    to: "alice",
    text: "给 alice",
    timeoutMs: 60_000,
    now: NOW,
    id: "i-1",
    maxRecords: 1,
  });
  assert.ok(!isFailure(first));
  const second = openInstruction(first.book, {
    group: "team",
    to: "bob",
    text: "给 bob",
    timeoutMs: 60_000,
    now: NOW,
    id: "i-2",
    maxRecords: 1,
  });
  assert.ok(!isFailure(second));
  assert.deepEqual(
    second.group.instructions.map((item) => item.id).sort(),
    ["i-1", "i-2"],
    "两条未结指令都不该被裁",
  );
});

test("结算：补任务 id → 结算落状态 → 重复结算被拒", () => {
  const { book } = fixture();
  const linked = linkMembers(book, {
    group: "team",
    from: MANAGER_NAME,
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(linked));
  const opened = openInstruction(linked.book, {
    group: "team",
    to: "alice",
    text: "任务",
    timeoutMs: 60_000,
    now: NOW,
    id: "i-1",
    maxRecords: 50,
  });
  assert.ok(!isFailure(opened));

  const attached = assignTaskId(opened.book, {
    group: "team",
    instructionId: "i-1",
    taskId: "task-1",
  });
  assert.ok(!isFailure(attached));
  assert.equal(openInstructionOf(attached.group, "alice")?.taskId, "task-1");

  const settled = settleInstruction(attached.book, {
    group: "team",
    instructionId: "i-1",
    status: "success",
    result: "做完了",
    now: NOW + 10,
  });
  assert.ok(!isFailure(settled));
  assert.equal(settled.instruction.status, "success");
  assert.equal(settled.instruction.result, "做完了");
  assert.equal(settled.instruction.settledAt, NOW + 10);
  assert.equal(openInstructionOf(settled.group, "alice"), undefined);

  expectFailure(
    settleInstruction(settled.book, {
      group: "team",
      instructionId: "i-1",
      status: "failure",
      now: NOW + 20,
    }),
  );
  expectFailure(
    assignTaskId(settled.book, {
      group: "team",
      instructionId: "i-1",
      taskId: "task-2",
    }),
  );
});

test("移除：非叶子被拒并列出剩余从代理；叶子可移除；连接与未结指令一并收尾", () => {
  const { book } = fixture();
  const chain = linkMembers(book, {
    group: "team",
    from: MANAGER_NAME,
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(chain));
  const extended = linkMembers(chain.book, {
    group: "team",
    from: "alice",
    to: "bob",
    now: NOW,
  });
  assert.ok(!isFailure(extended));
  const opened = openInstruction(extended.book, {
    group: "team",
    to: "alice",
    text: "给 alice 的任务",
    timeoutMs: 60_000,
    now: NOW,
    id: "i-1",
    maxRecords: 50,
  });
  assert.ok(!isFailure(opened));

  const notLeaf = expectFailure(
    removeMember(opened.book, { group: "team", name: "alice", now: NOW }),
  );
  assert.equal(notLeaf.error, "not_leaf");
  assert.match(notLeaf.reason, /bob/);
  assert.deepEqual(notLeaf["subordinates"], ["bob"]);
  assert.match(notLeaf.next, /remove name=bob/);

  expectFailure(
    removeMember(opened.book, {
      group: "team",
      name: MANAGER_NAME,
      now: NOW,
    }),
  );

  // 逐层下推：先移除 bob（叶子），alice 才成为叶子
  const removedBob = removeMember(opened.book, {
    group: "team",
    name: "bob",
    now: NOW + 1,
  });
  assert.ok(!isFailure(removedBob));
  const removed = removeMember(removedBob.book, {
    group: "team",
    name: "alice",
    now: NOW + 2,
  });
  assert.ok(!isFailure(removed));
  assert.equal(removed.settled?.status, "removed");
  assert.equal(removed.settled?.cause, "成员已被移除");
  assert.equal(removed.group.members["alice"], undefined);
  assert.equal(removed.group.links["alice"], undefined);
  assert.equal(openInstructionOf(removed.group, "alice"), undefined);

  // 逐层推完只剩管理者；新成员可被管理者直接收编（等级 1，命名空间回收）
  assert.deepEqual(Object.keys(removed.group.members), [MANAGER_NAME]);
  const added = addMember(removed.book, {
    group: "team",
    name: "dave",
    target: "sess-dave",
    sessionId: "sess-dave",
    now: NOW + 3,
  });
  assert.ok(!isFailure(added));
  const relink = linkMembers(added.book, {
    group: "team",
    from: MANAGER_NAME,
    to: "dave",
    now: NOW + 3,
  });
  assert.ok(!isFailure(relink));
  assert.equal(relink.link.level, 1);
});

test("只读视图：成员 / 连接 / 指令 / 计数齐备，且是 lossless JSON（不留 undefined 键）", () => {
  const { book } = fixture();
  const linked = linkMembers(book, {
    group: "team",
    from: MANAGER_NAME,
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(linked));
  const opened = openInstruction(linked.book, {
    group: "team",
    to: "alice",
    text: "任务",
    timeoutMs: 60_000,
    now: NOW,
    id: "i-1",
    maxRecords: 50,
  });
  assert.ok(!isFailure(opened));
  const settled = settleInstruction(opened.book, {
    group: "team",
    instructionId: "i-1",
    status: "blocked",
    cause: "缺少凭据",
    now: NOW + 5,
  });
  assert.ok(!isFailure(settled));

  const view = groupView(settled.group);
  assert.equal(view.name, "team");
  assert.equal(view.manager.sessionId, MANAGER);
  assert.equal(view.summary.members, 3);
  assert.equal(view.summary.links, 1);
  assert.equal(view.summary.blocked, 1);
  const alice = view.members.find((member) => member.name === "alice");
  assert.equal(alice?.level, 1);
  assert.equal(alice?.principal, MANAGER_NAME);
  const manager = view.members.find((member) => member.name === MANAGER_NAME);
  assert.deepEqual(manager?.subordinates, ["alice"]);
  assert.equal(manager?.principal, null);
  assert.equal(view.instructions[0]?.status, "blocked");
  assert.equal(view.instructions[0]?.cause, "缺少凭据");

  // lossless JSON：递归不得出现 undefined（宿主会拒收）
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") {
      assert.notEqual(value, undefined, `${path} 是 undefined`);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      assert.notEqual(item, undefined, `${path}.${key} 是 undefined`);
      walk(item, `${path}.${key}`);
    }
  };
  walk(view, "view");
  assert.equal(JSON.parse(JSON.stringify(view)).name, "team");
});

test("不变量自检：正常状态为空表，被改坏的状态逐条报出", () => {
  const { book } = fixture();
  const linked = linkMembers(book, {
    group: "team",
    from: MANAGER_NAME,
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(linked));
  assert.deepEqual(invariantViolations(linked.group), []);

  const broken: AgentGroupState = {
    ...linked.group,
    links: {
      alice: { from: "ghost", to: "alice", level: 7, createdAt: NOW },
      bob: { from: MANAGER_NAME, to: MANAGER_NAME, level: 3, createdAt: NOW },
    },
    members: {
      ...linked.group.members,
      bob: { ...linked.group.members["bob"]!, level: 4 },
      carol: {
        name: "carol",
        target: "sess-carol",
        sessionId: "sess-carol",
        level: 2,
        role: "member",
        addedAt: NOW,
      },
    },
  };
  const problems = invariantViolations(broken);
  assert.ok(problems.length >= 3, `应报出多条违规：${problems.join(" | ")}`);
  assert.ok(problems.some((item) => item.includes("主方不存在")));
  assert.ok(problems.some((item) => item.includes("管理者不能作为从方")));
  assert.ok(problems.some((item) => item.includes("自由代理")));
});

test("平等连接：对键与参与者查询", () => {
  assert.equal(peerPairKey("bob", "alice"), "alice.bob");
  assert.equal(peerPairKey("alice", "bob"), "alice.bob");
  const { group } = fixture();
  assert.deepEqual(peerLinksOf(group, "alice"), []);
});

test("平等连接：linkPeer 建立双向记录、无等级、不进 links、每对至多一条", () => {
  const { book } = fixture();
  const linked = linkPeer(book, {
    group: "team",
    from: "alice",
    to: "bob",
    now: NOW,
  });
  assert.ok(!isFailure(linked), JSON.stringify(linked));
  assert.equal(linked.group.peerLinks["alice.bob"]?.from, "alice");
  assert.equal(linked.group.peerLinks["alice.bob"]?.to, "bob");
  assert.equal(
    linked.group.links["alice"],
    undefined,
    "平等连接不进主从 links",
  );
  assert.equal(linked.group.members["alice"]?.level, 0, "平等连接不改等级");
  assert.deepEqual(peerLinksOf(linked.group, "bob"), ["alice.bob"]);
  // 每对至多一条：重复建立被拒
  const dup = linkPeer(linked.book, {
    group: "team",
    from: "bob",
    to: "alice",
    now: NOW,
  });
  const dupFail = expectFailure(dup);
  assert.equal(dupFail.error, "peer_link_exists");
  // 不同对可以各自建（互不影响）
  const linked2 = linkPeer(linked.book, {
    group: "team",
    from: "manager",
    to: "alice",
    now: NOW,
  });
  assert.ok(!isFailure(linked2));
  assert.equal(linked2.group.peerLinks["alice.manager"]?.from, "alice");
});

test("平等连接：拒绝路径（成员不存在 / 自连）", () => {
  const { book } = fixture();
  const missing = expectFailure(
    linkPeer(book, { group: "team", from: "alice", to: "nobody", now: NOW }),
  );
  assert.equal(missing.error, "member_not_found");
  const self = expectFailure(
    linkPeer(book, { group: "team", from: "alice", to: "alice", now: NOW }),
  );
  assert.equal(self.error, "self_link");
});

test("平等连接：移除成员联动删除其全部平等连接", () => {
  const { book } = fixture();
  const l1 = linkPeer(book, {
    group: "team",
    from: "alice",
    to: "bob",
    now: NOW,
  });
  assert.ok(!isFailure(l1));
  const l2 = linkPeer(l1.book, {
    group: "team",
    from: "manager",
    to: "bob",
    now: NOW,
  });
  assert.ok(!isFailure(l2));
  const removed = removeMember(l2.book, {
    group: "team",
    name: "bob",
    now: NOW,
  });
  assert.ok(!isFailure(removed), JSON.stringify(removed));
  assert.deepEqual(
    Object.keys(removed.group.peerLinks),
    [],
    "bob 的平等连接应一并删除",
  );
  assert.equal(removed.group.members["bob"], undefined);
});

test("平等连接：不变量自检（两端不存在 / 键与两端不一致各报一条）", () => {
  const { group } = fixture();
  const withPeer = linkPeer(
    { ...emptyBook(MANAGER), groups: { team: group } },
    { group: "team", from: "alice", to: "bob", now: NOW },
  );
  assert.ok(!isFailure(withPeer));
  const broken: AgentGroupState = {
    ...withPeer.group,
    peerLinks: {
      "alice.bob": { from: "alice", to: "ghost", createdAt: NOW },
      "zzz.team": { from: "zzz", to: "team", createdAt: NOW },
    },
  };
  const problems = invariantViolations(broken);
  assert.ok(
    problems.some((p) => p.includes("平等连接") && p.includes("ghost")),
  );
  assert.ok(
    problems.some((p) => p.includes("平等连接") && p.includes("形态不合法")),
  );
});

test("只读视图：平等连接进 view 与 summary 计数", () => {
  const { group } = fixture();
  const withPeer = linkPeer(
    { ...emptyBook(MANAGER), groups: { team: group } },
    { group: "team", from: "alice", to: "bob", now: NOW },
  );
  assert.ok(!isFailure(withPeer));
  const view = groupView(withPeer.group);
  assert.equal(view.summary.peerLinks, 1);
  assert.deepEqual(view.peerLinks, [
    { from: "alice", to: "bob", createdAt: NOW },
  ]);
});
