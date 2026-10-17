/**
 * 测试替身：memory-base 的冻结句柄面（结构面实现，不引上游代码）。
 * 只实现本包用到的成员：registerKind / checkPrivacy / list，句柄 put / forget。
 */
import type {
  KindSpec,
  MemoryFace,
  PutResult,
  ScopePutInput,
  StoreRow,
} from "../src/apply.ts";

export interface FakePut {
  kind: string;
  input: ScopePutInput;
}

export interface FakeForget {
  kind: string;
  refs: readonly { tier: string; ids: readonly number[] }[];
}

export interface FakeMemory {
  face: MemoryFace;
  puts: FakePut[];
  forgets: FakeForget[];
  rows: StoreRow[];
  specs: KindSpec[];
}

/** 造一份假 memory 服务；`memoryPrivacy` 模拟上游内置隐私闸。 */
export function fakeMemory(
  options: { memoryPrivacy?: (text: string) => string | null } = {},
): FakeMemory {
  const puts: FakePut[] = [];
  const forgets: FakeForget[] = [];
  const rows: StoreRow[] = [];
  const specs: KindSpec[] = [];
  let nextId = 1;
  const face: MemoryFace = {
    registerKind(spec: KindSpec) {
      specs.push(spec);
      const writable = spec.writableTiers ?? ["session"];
      return {
        kind: spec.kind,
        writableTiers: writable,
        async put(input: ScopePutInput): Promise<PutResult> {
          const tier = input.tier ?? "session";
          if (!writable.includes(tier)) {
            throw new Error(`kind ${spec.kind} 不可写 ${tier} 层`);
          }
          const verdict = await spec.preWrite?.({
            content: input.content,
            project: input.project ?? "",
            kind: spec.kind,
            ...(input.title === undefined ? {} : { title: input.title }),
          });
          if (verdict !== undefined && !verdict.accept) {
            return {
              ids: [],
              sourceId: 0,
              created: 0,
              skipped: { reason: verdict.reason ?? "hook" },
            };
          }
          const id = nextId++;
          puts.push({ kind: spec.kind, input });
          rows.push({
            id,
            kind: spec.kind,
            tier,
            project: input.project ?? "",
            title: input.title ?? null,
            content: input.content,
            importance: input.importance ?? 3,
            sessionId: input.sessionId ?? null,
            createdAt: 0,
          });
          return { ids: [id], sourceId: 1, created: 1 };
        },
        async forget(refs) {
          forgets.push({ kind: spec.kind, refs });
          return refs.reduce((total, ref) => total + ref.ids.length, 0);
        },
      };
    },
    checkPrivacy(text: string) {
      return options.memoryPrivacy?.(text) ?? null;
    },
    async list() {
      return [...rows];
    },
  };
  return { face, puts, forgets, rows, specs };
}

/** 造一条 user/message 会话事件。 */
export function userEvent(
  text: string,
  options: { time?: number; sourceKind?: string } = {},
): Record<string, unknown> {
  return {
    type: "user/message",
    time: options.time ?? Date.now(),
    data: {
      message: {
        content: [{ type: "text", text }],
        ...(options.sourceKind === undefined
          ? {}
          : { source: { kind: options.sourceKind } }),
      },
    },
  };
}
