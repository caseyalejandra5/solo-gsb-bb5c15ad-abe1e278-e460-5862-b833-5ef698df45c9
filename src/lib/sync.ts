/**
 * 本机多标签页协同：revision 模型、localStorage 持久化、修订图祖先判断。
 *
 * 每个会改变 Plan 的操作都发布为一条 revision（id 由 crypto.randomUUID 生成），
 * 记录父 revision、来源标签页 clientId 与完整 Plan 快照。所有 revision 存入
 * localStorage，head 指针指向当前最新 revision，并通过 BroadcastChannel 广播。
 * 冲突判定只依据修订图的祖先关系，绝不按时间戳覆盖。
 */
import { Plan, validatePlan } from './model';

export interface Revision {
  /** crypto.randomUUID() */
  id: string;
  /** 父 revision id 列表；合并 revision 同时引用两个版本 */
  parentIds: string[];
  /** 产生该 revision 的标签页 id */
  clientId: string;
  /** 完整 Plan 快照 */
  plan: Plan;
  /** 仅用于展示，绝不参与冲突判定 */
  createdAt: number;
}

export const CHANNEL_NAME = 'ipv4-subnet-planner:sync';
const KEY_REVISIONS = 'ipv4-subnet-planner:revisions';
const KEY_HEAD = 'ipv4-subnet-planner:head';
const KEY_CLIENT = 'ipv4-subnet-planner:client';

/** 本地保留的 revision 上限；超出时裁剪掉 head 的祖先之外的条目 */
export const MAX_REVISIONS = 200;

/** localStorage 不可用（隐私模式 / SSR / 测试环境）时的安全取值 */
function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 当前标签页的 clientId：优先复用 sessionStorage，否则新生成 */
export function getClientId(): string {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const cached = sessionStorage.getItem(KEY_CLIENT);
      if (cached) return cached;
      const id = crypto.randomUUID();
      sessionStorage.setItem(KEY_CLIENT, id);
      return id;
    }
  } catch {
    /* sessionStorage 不可用时退回临时 id */
  }
  return crypto.randomUUID();
}

export function makeRevision(parentIds: string[], clientId: string, plan: Plan): Revision {
  return {
    id: crypto.randomUUID(),
    parentIds: [...parentIds],
    clientId,
    plan,
    createdAt: Date.now(),
  };
}

/** 结构校验：字段形状合法（不校验 Plan 内容） */
export function isRevisionShape(x: unknown): x is Revision {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    Array.isArray(o.parentIds) &&
    o.parentIds.every((p) => typeof p === 'string') &&
    typeof o.clientId === 'string' &&
    typeof o.createdAt === 'number' &&
    typeof o.plan === 'object' &&
    o.plan !== null
  );
}

/** 完整校验：结构 + 复用现有 Plan 校验。返回错误列表，空为通过。 */
export function validateRevision(rev: unknown): string[] {
  if (!isRevisionShape(rev)) return ['快照结构非法'];
  return validatePlan(rev.plan);
}

export interface RevisionStore {
  revisions: Map<string, Revision>;
  headId: string | null;
}

/**
 * 从 localStorage 恢复 head 指向的 revision。
 * corrupt 为 true 表示快照存在但已损坏（调用方应提示并忽略），此时返回空表。
 */
export function restoreHead(): { store: RevisionStore; corrupt: boolean } {
  const empty: RevisionStore = { revisions: new Map(), headId: null };
  const storage = safeStorage();
  if (!storage) return { store: empty, corrupt: false };
  let headId: string | null = null;
  let raw: string | null = null;
  try {
    headId = storage.getItem(KEY_HEAD);
    raw = storage.getItem(KEY_REVISIONS);
  } catch {
    return { store: empty, corrupt: false };
  }
  if (headId === null && raw === null) return { store: empty, corrupt: false };

  let parsed: unknown;
  try {
    parsed = raw === null ? {} : JSON.parse(raw);
  } catch {
    return { store: empty, corrupt: true };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { store: empty, corrupt: true };
  }
  const revisions = new Map<string, Revision>();
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isRevisionShape(value) && value.id === id) revisions.set(id, value);
  }
  if (headId === null) return { store: { revisions, headId: null }, corrupt: false };
  const head = revisions.get(headId);
  if (!head) return { store: empty, corrupt: true };
  const errors = validateRevision(head);
  if (errors.length > 0) return { store: empty, corrupt: true };
  return { store: { revisions, headId }, corrupt: false };
}

/** 清除损坏的本地快照（忽略后不再重复提示） */
export function clearStored(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(KEY_REVISIONS);
    storage.removeItem(KEY_HEAD);
  } catch {
    /* 忽略 */
  }
}

/**
 * 计算 head 的全部祖先（含 head 自身）。
 * 父引用本身即祖先边：内容缺失的父 id 仍计入闭包（该路径到此为止），
 * 这样被裁剪掉的直接祖先依然能被识别为祖先。
 */
export function ancestorClosure(revisions: Map<string, Revision>, headId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [headId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const rev = revisions.get(id);
    if (!rev) continue; // 内容缺失：无法再向上追溯，但 id 本身已计入
    for (const p of rev.parentIds) stack.push(p);
  }
  return seen;
}

/**
 * 祖先判断：ancestorId 是否为 descendantId 的（严格）祖先。
 * 沿 parentIds 自 descendant 向根遍历；只凭 id 引用即可判定，节点内容缺失不影响直接边。
 */
export function isAncestor(
  revisions: Map<string, Revision>,
  ancestorId: string,
  descendantId: string,
): boolean {
  if (ancestorId === descendantId) return false;
  return ancestorClosure(revisions, descendantId).has(ancestorId);
}

/** 把共享存储里其他标签页写入的条目合并进内存表（不覆盖已有条目） */
function mergeSharedInto(store: RevisionStore, storage: Storage): void {
  try {
    const raw = storage.getItem(KEY_REVISIONS);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isRevisionShape(value) && value.id === id && !store.revisions.has(id)) {
        store.revisions.set(id, value);
      }
    }
  } catch {
    /* 共享表损坏时以内存为准，整体重写 */
  }
}

function writeSharedMap(store: RevisionStore, storage: Storage): void {
  const out: Record<string, Revision> = {};
  for (const [id, r] of store.revisions) out[id] = r;
  storage.setItem(KEY_REVISIONS, JSON.stringify(out));
}

/** 收到外部 revision 时的三种处置 */
export type RemoteVerdict = 'fast-forward' | 'stale' | 'conflict';

/**
 * 按修订图判断外部 revision 与本地 head 的关系（绝不参考时间戳）：
 * - fast-forward：本地 head 是其祖先（或本地尚无版本），应自动快进；
 * - stale：它是本地 head 的祖先，过期，应忽略；
 * - conflict：双方互不为祖先，应保留两份并交由用户解决。
 */
export function classifyRemote(
  revisions: Map<string, Revision>,
  headId: string | null,
  revId: string,
): RemoteVerdict {
  if (headId === null) return 'fast-forward';
  if (revId === headId || isAncestor(revisions, revId, headId)) return 'stale';
  if (isAncestor(revisions, headId, revId)) return 'fast-forward';
  return 'conflict';
}

/** 超出上限时裁剪：先去掉 head 祖先之外的条目；链太深再按时间裁掉最老的祖先 */
function prune(store: RevisionStore): void {
  if (store.revisions.size <= MAX_REVISIONS || !store.headId) return;
  const keep = ancestorClosure(store.revisions, store.headId);
  for (const id of [...store.revisions.keys()]) {
    if (!keep.has(id)) store.revisions.delete(id);
  }
  if (store.revisions.size > MAX_REVISIONS) {
    const byAge = [...store.revisions.values()].sort((a, b) => b.createdAt - a.createdAt);
    const keepIds = new Set(byAge.slice(0, MAX_REVISIONS).map((r) => r.id));
    keepIds.add(store.headId);
    for (const id of [...store.revisions.keys()]) {
      if (!keepIds.has(id)) store.revisions.delete(id);
    }
  }
}

/**
 * 入库一条 revision 并读-合并-写共享存储（避免覆盖其他标签页刚写入的条目）。
 * 不移动 head 指针——收到外部 revision 时本地 head 由修订图判断决定是否推进。
 * 存储失败（如配额不足）会抛错，由调用方提示。
 */
export function storeRevision(store: RevisionStore, rev: Revision): void {
  store.revisions.set(rev.id, rev);
  const storage = safeStorage();
  if (!storage) return;
  mergeSharedInto(store, storage);
  writeSharedMap(store, storage);
}

/** 将 head 指向指定 revision（仅更新 head 指针） */
export function advanceHead(store: RevisionStore, headId: string): void {
  store.headId = headId;
  safeStorage()?.setItem(KEY_HEAD, headId);
}

/**
 * 本地发布一条 revision：入库、合并共享表、裁剪、写回并更新 head。
 * 调用方随后通过 BroadcastChannel 广播。存储失败会抛错，由调用方提示。
 */
export function persistRevision(store: RevisionStore, rev: Revision): void {
  store.revisions.set(rev.id, rev);
  store.headId = rev.id;
  const storage = safeStorage();
  if (!storage) return;
  mergeSharedInto(store, storage);
  prune(store);
  writeSharedMap(store, storage);
  storage.setItem(KEY_HEAD, rev.id);
}
