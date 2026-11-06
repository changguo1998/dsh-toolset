/**
 * 测试替身：memory-base 的结构面（`registerKind` + 会话层读面）、宿主 agent / inbox / pre-step。
 * 口径照 memory-base 的真实行为：`listRows` 按登记时间**倒序**返回、`openExisting` 只开不建。
 */

import type {
  BundleLike,
  KindSpecLike,
  MemoryFaceLike,
  PutResultLike,
  ScopeLike,
  StoreRowLike,
  TierStoreLike,
} from "../src/store.ts";
import type { PinMessageLike } from "../src/inject.ts";

/** 一个假的 memory-base：按会话 id 存行。 */
export interface FakeMemory {
  memory: MemoryFaceLike;
  /** 各会话的行（写入顺序即登记顺序）。 */
  rows: Map<string, StoreRowLike[]>;
  /** 收到的注册声明。 */
  specs: KindSpecLike[];
  /** 下一次 `registerKind` 抛错（模拟同名重复注册）。 */
  failNextRegister?: boolean;
}

export function makeMemory(): FakeMemory {
  const rows = new Map<string, StoreRowLike[]>();
  const specs: KindSpecLike[] = [];
  let nextId = 1;
  const fake: FakeMemory = {
    rows,
    specs,
    memory: {
      registerKind(spec: KindSpecLike): ScopeLike {
        if (fake.failNextRegister === true)
          throw new Error("分类「pin」已注册");
        specs.push(spec);
        return {
          kind: spec.kind,
          async put(input): Promise<PutResultLike> {
            const verdict = spec.preWrite?.({
              content: input.content,
              project: "proj",
              kind: spec.kind,
              ...(input.title === undefined ? {} : { title: input.title }),
            });
            if (verdict !== undefined && !verdict.accept) {
              return { ids: [], skipped: verdict.reason ?? "preWrite" };
            }
            const sessionId = input.sessionId ?? "";
            const id = nextId;
            nextId += 1;
            const list = rows.get(sessionId) ?? [];
            list.push({
              id,
              content: input.content,
              title: input.title ?? null,
              createdAt: Date.now() + id,
            });
            rows.set(sessionId, list);
            return { ids: [id] };
          },
        };
      },
      async whenReady(): Promise<BundleLike> {
        return {
          tiers: {
            async openExisting(
              tier: string,
              sessionId?: string,
            ): Promise<TierStoreLike | undefined> {
              if (tier !== "session" || sessionId === undefined)
                return undefined;
              const list = rows.get(sessionId);
              if (list === undefined) return undefined;
              return {
                kb: {
                  listRows(opts: {
                    kind: string;
                    limit?: number;
                  }): StoreRowLike[] {
                    const limit = opts.limit ?? 50;
                    return [...list].reverse().slice(0, limit);
                  },
                  evict(refs: readonly { kind: string; id: number }[]): number {
                    let removed = 0;
                    for (const ref of refs) {
                      const index = list.findIndex((row) => row.id === ref.id);
                      if (index < 0) continue;
                      list.splice(index, 1);
                      removed += 1;
                    }
                    return removed;
                  },
                },
              };
            },
          },
        };
      },
    },
  };
  return fake;
}

/** 宿主 inbox 的替身（记录动作，供断言）。 */
export interface FakeInbox {
  nextStep: PinMessageLike[];
  prepended: PinMessageLike[];
  replaced: Array<{ id: string; message: PinMessageLike }>;
  removed: string[];
}

/** 宿主 agent 的替身：会话投影 + inbox。 */
export interface FakeAgent {
  session: {
    id: string;
    surface: { nodes: number[] };
    events: Map<number, { type: string; data?: unknown }>;
    /** 当前上下文派生消息（按投影节点取事件数据, 照宿主 deriveMessages 口径）。 */
    deriveMessages(): unknown[];
    eventAt(seq: number): { type: string; data?: unknown } | undefined;
  };
  inbox: FakeInbox & {
    remove?(id: string): void;
    prepend?(where: "next-step", message: PinMessageLike): void;
    replace?(id: string, message: PinMessageLike): void;
  };
}

export function makeAgent(sessionId = "s1"): FakeAgent {
  const events = new Map<number, { type: string; data?: unknown }>();
  const surface = { nodes: [] as number[] };
  const inbox: FakeAgent["inbox"] = {
    nextStep: [],
    prepended: [],
    replaced: [],
    removed: [],
    remove(id: string) {
      inbox.removed.push(id);
      inbox.nextStep = inbox.nextStep.filter((message) => message.id !== id);
    },
    prepend(_where: "next-step", message: PinMessageLike) {
      inbox.prepended.push(message);
      inbox.nextStep.unshift(message);
    },
    replace(id: string, message: PinMessageLike) {
      inbox.replaced.push({ id, message });
      inbox.nextStep = inbox.nextStep.map((item) =>
        item.id === id ? message : item,
      );
    },
  };
  return {
    session: {
      id: sessionId,
      surface,
      events,
      deriveMessages() {
        const out: unknown[] = [];
        for (const seq of surface.nodes) {
          const event = events.get(seq);
          if (event?.type === "user/message" && event.data !== undefined)
            out.push(event.data);
        }
        return out;
      },
      eventAt(seq: number) {
        return events.get(seq);
      },
    },
    inbox,
  };
}

/** 把一条消息登记成指定 seq 的会话事件（模拟它已落进投影）。 */
export function commitToSurface(
  agent: FakeAgent,
  message: PinMessageLike,
): void {
  const seq = agent.session.events.size + 1;
  agent.session.events.set(seq, { type: "user/message", data: message });
  agent.session.surface.nodes.push(seq);
}

/** 模拟压缩：投影节点被整体替换（本插件的消息不再在上下文里）。 */
export function compactSurface(agent: FakeAgent): void {
  agent.session.surface.nodes = [];
  agent.session.events.clear();
}
