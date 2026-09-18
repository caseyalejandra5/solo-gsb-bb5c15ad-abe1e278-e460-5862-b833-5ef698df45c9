import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Plan } from './model';
import {
  MAX_REVISIONS,
  RevisionStore,
  advanceHead,
  ancestorClosure,
  classifyRemote,
  clearStored,
  isAncestor,
  isRevisionShape,
  makeRevision,
  persistRevision,
  restoreHead,
  storeRevision,
  validateRevision,
} from './sync';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

function validPlan(): Plan {
  return {
    version: 1,
    roots: [{ id: 'root_1', name: '生产骨干', cidr: '10.0.0.0/8' }],
    allocations: [
      { id: 'alloc_1', name: '数据中心-A', kind: 'subnet', prefix: 16, cidr: '10.0.0.0/16' },
    ],
  };
}

function newStore(): RevisionStore {
  return { revisions: new Map(), headId: null };
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('makeRevision', () => {
  it('生成 UUID id、复制父列表并记录 clientId 与完整 Plan', () => {
    const plan = validPlan();
    const rev = makeRevision(['p1', 'p2'], 'client-a', plan);
    expect(rev.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rev.parentIds).toEqual(['p1', 'p2']);
    expect(rev.clientId).toBe('client-a');
    expect(rev.plan).toBe(plan);
    expect(typeof rev.createdAt).toBe('number');
    const parents = ['p1'];
    const rev2 = makeRevision(parents, 'c', plan);
    parents.push('mutated');
    expect(rev2.parentIds).toEqual(['p1']);
  });
});

describe('validateRevision / isRevisionShape', () => {
  it('接受合法 revision', () => {
    const rev = makeRevision([], 'c', validPlan());
    expect(isRevisionShape(rev)).toBe(true);
    expect(validateRevision(rev)).toEqual([]);
  });

  it('拒绝结构非法的快照', () => {
    expect(isRevisionShape(null)).toBe(false);
    expect(isRevisionShape({})).toBe(false);
    expect(isRevisionShape({ id: 'x', parentIds: 'no', clientId: 'c', createdAt: 1, plan: {} })).toBe(false);
    expect(validateRevision({ id: 1 })).not.toEqual([]);
  });

  it('拒绝 Plan 未通过现有校验的快照', () => {
    const bad: Plan = {
      version: 1,
      roots: [{ id: 'r1', name: 'a', cidr: '10.0.0.0/8' }],
      allocations: [
        { id: 'a1', name: '越界', kind: 'subnet', prefix: 16, cidr: '11.0.0.0/16' },
      ],
    };
    const errors = validateRevision(makeRevision([], 'c', bad));
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('isAncestor / ancestorClosure', () => {
  // a → b → c，d 以 b、c 为父的合并
  function chain() {
    const store = newStore();
    const a = makeRevision([], 'c1', validPlan());
    const b = makeRevision([a.id], 'c1', validPlan());
    const c = makeRevision([b.id], 'c2', validPlan());
    const d = makeRevision([b.id, c.id], 'c1', validPlan());
    for (const r of [a, b, c, d]) store.revisions.set(r.id, r);
    return { store, a, b, c, d };
  }

  it('识别直接与传递祖先', () => {
    const { store, a, b, c } = chain();
    expect(isAncestor(store.revisions, b.id, c.id)).toBe(true);
    expect(isAncestor(store.revisions, a.id, c.id)).toBe(true);
    expect(isAncestor(store.revisions, c.id, a.id)).toBe(false);
    expect(isAncestor(store.revisions, a.id, a.id)).toBe(false);
  });

  it('合并 revision 同时是两个版本的祖先闭包成员', () => {
    const { store, b, c, d } = chain();
    expect(isAncestor(store.revisions, b.id, d.id)).toBe(true);
    expect(isAncestor(store.revisions, c.id, d.id)).toBe(true);
    expect(isAncestor(store.revisions, d.id, c.id)).toBe(false);
  });

  it('分叉双方互不为祖先', () => {
    const store = newStore();
    const base = makeRevision([], 'c1', validPlan());
    const left = makeRevision([base.id], 'c1', validPlan());
    const right = makeRevision([base.id], 'c2', validPlan());
    for (const r of [base, left, right]) store.revisions.set(r.id, r);
    expect(isAncestor(store.revisions, left.id, right.id)).toBe(false);
    expect(isAncestor(store.revisions, right.id, left.id)).toBe(false);
  });

  it('缺失内容的父引用仍构成祖先边，完全未引用的 id 不可达', () => {
    const store = newStore();
    const orphan = makeRevision(['missing-id'], 'c1', validPlan());
    store.revisions.set(orphan.id, orphan);
    // 父引用本身就是祖先边：即使节点内容缺失（如被裁剪），也认定其为祖先
    expect(isAncestor(store.revisions, 'missing-id', orphan.id)).toBe(true);
    // 完全未被引用的 id 不是祖先
    expect(isAncestor(store.revisions, 'unrelated-id', orphan.id)).toBe(false);
    expect(ancestorClosure(store.revisions, orphan.id).has(orphan.id)).toBe(true);
  });
});

describe('classifyRemote', () => {
  it('本地 head 是外部版本的祖先（或本地无版本）→ fast-forward', () => {
    const store = newStore();
    const r1 = makeRevision([], 'A', validPlan());
    const r2 = makeRevision([r1.id], 'B', validPlan());
    for (const r of [r1, r2]) store.revisions.set(r.id, r);
    expect(classifyRemote(store.revisions, r1.id, r2.id)).toBe('fast-forward');
    expect(classifyRemote(store.revisions, null, r2.id)).toBe('fast-forward');
  });

  it('外部版本是本地 head 的祖先（或与 head 相同）→ stale', () => {
    const store = newStore();
    const r1 = makeRevision([], 'A', validPlan());
    const r2 = makeRevision([r1.id], 'B', validPlan());
    for (const r of [r1, r2]) store.revisions.set(r.id, r);
    expect(classifyRemote(store.revisions, r2.id, r1.id)).toBe('stale');
    expect(classifyRemote(store.revisions, r2.id, r2.id)).toBe('stale');
  });

  it('双方互不为祖先 → conflict；合并后双方均为祖先 → fast-forward', () => {
    const store = newStore();
    const base = makeRevision([], 'A', validPlan());
    const left = makeRevision([base.id], 'A', validPlan());
    const right = makeRevision([base.id], 'B', validPlan());
    for (const r of [base, left, right]) store.revisions.set(r.id, r);
    expect(classifyRemote(store.revisions, left.id, right.id)).toBe('conflict');
    expect(classifyRemote(store.revisions, right.id, left.id)).toBe('conflict');
    // 合并 revision 同时引用两个版本
    const merge = makeRevision([left.id, right.id], 'A', validPlan());
    store.revisions.set(merge.id, merge);
    expect(classifyRemote(store.revisions, left.id, merge.id)).toBe('fast-forward');
    expect(classifyRemote(store.revisions, right.id, merge.id)).toBe('fast-forward');
    expect(classifyRemote(store.revisions, merge.id, left.id)).toBe('stale');
    expect(classifyRemote(store.revisions, merge.id, right.id)).toBe('stale');
  });
});

describe('双标签页协同流程模拟', () => {
  it('发布 → 快进 → 分叉冲突 → 合并 → 收敛', () => {
    // 两个标签页共享同一 localStorage（同一 origin）
    const tabA = newStore();
    const tabB = newStore();

    // A 发布 r1 → B 收到：fast-forward
    const r1 = makeRevision([], 'client-A', validPlan());
    persistRevision(tabA, r1);
    storeRevision(tabB, r1);
    expect(classifyRemote(tabB.revisions, tabB.headId, r1.id)).toBe('fast-forward');
    advanceHead(tabB, r1.id);

    // B 发布 r2 → A 收到：fast-forward
    const r2 = makeRevision([r1.id], 'client-B', validPlan());
    persistRevision(tabB, r2);
    storeRevision(tabA, r2);
    expect(classifyRemote(tabA.revisions, tabA.headId, r2.id)).toBe('fast-forward');
    advanceHead(tabA, r2.id);

    // 双方基于 r2 同时分叉：A 发布 a3，B 发布 b3
    const a3 = makeRevision([r2.id], 'client-A', validPlan());
    persistRevision(tabA, a3);
    const b3 = makeRevision([r2.id], 'client-B', validPlan());
    persistRevision(tabB, b3);

    // 互收：双方都判定冲突，且两份版本都保留在图中
    storeRevision(tabA, b3);
    expect(classifyRemote(tabA.revisions, tabA.headId, b3.id)).toBe('conflict');
    storeRevision(tabB, a3);
    expect(classifyRemote(tabB.revisions, tabB.headId, a3.id)).toBe('conflict');

    // A 解决冲突：合并 revision 同时引用 a3 与 b3
    const merge = makeRevision([a3.id, b3.id], 'client-A', validPlan());
    persistRevision(tabA, merge);

    // B 收到合并：fast-forward，双方收敛到同一 head
    storeRevision(tabB, merge);
    expect(classifyRemote(tabB.revisions, tabB.headId, merge.id)).toBe('fast-forward');
    advanceHead(tabB, merge.id);
    expect(isAncestor(tabB.revisions, a3.id, merge.id)).toBe(true);
    expect(isAncestor(tabB.revisions, b3.id, merge.id)).toBe(true);

    // 合并后任一旧版本再次广播都视为过期，不会被时间戳覆盖
    expect(classifyRemote(tabA.revisions, tabA.headId, b3.id)).toBe('stale');
    expect(classifyRemote(tabB.revisions, tabB.headId, a3.id)).toBe('stale');

    // 共享存储中的 head 一致，新标签页可恢复
    expect(restoreHead().store.headId).toBe(merge.id);
  });
});

describe('persistRevision / restoreHead', () => {
  it('写入 localStorage 并更新 head，可完整恢复', () => {
    const store = newStore();
    const r1 = makeRevision([], 'c1', validPlan());
    const r2 = makeRevision([r1.id], 'c1', validPlan());
    persistRevision(store, r1);
    persistRevision(store, r2);
    expect(storage.getItem('ipv4-subnet-planner:head')).toBe(r2.id);

    const restored = restoreHead();
    expect(restored.corrupt).toBe(false);
    expect(restored.store.headId).toBe(r2.id);
    expect(restored.store.revisions.get(r2.id)?.plan).toEqual(validPlan());
    expect(restored.store.revisions.get(r1.id)).toBeDefined();
  });

  it('无快照时不视为损坏', () => {
    const restored = restoreHead();
    expect(restored.corrupt).toBe(false);
    expect(restored.store.headId).toBeNull();
  });

  it('JSON 损坏时报告 corrupt 并可清除', () => {
    storage.setItem('ipv4-subnet-planner:revisions', '{oops');
    storage.setItem('ipv4-subnet-planner:head', 'x');
    expect(restoreHead().corrupt).toBe(true);
    clearStored();
    expect(restoreHead().corrupt).toBe(false);
  });

  it('head 指向缺失或非法 revision 时报告 corrupt', () => {
    storage.setItem('ipv4-subnet-planner:revisions', JSON.stringify({}));
    storage.setItem('ipv4-subnet-planner:head', 'missing');
    expect(restoreHead().corrupt).toBe(true);

    storage.clear();
    const bad = makeRevision([], 'c', validPlan());
    storage.setItem('ipv4-subnet-planner:revisions', JSON.stringify({ [bad.id]: { ...bad, plan: null } }));
    storage.setItem('ipv4-subnet-planner:head', bad.id);
    expect(restoreHead().corrupt).toBe(true);
  });

  it('head 的 Plan 未通过校验时报告 corrupt', () => {
    const bad: Plan = {
      version: 1,
      roots: [{ id: 'r1', name: 'a', cidr: '10.0.0.0/8' }],
      allocations: [{ id: 'a1', name: '越界', kind: 'subnet', prefix: 16, cidr: '11.0.0.0/16' }],
    };
    const rev = makeRevision([], 'c', bad);
    storage.setItem('ipv4-subnet-planner:revisions', JSON.stringify({ [rev.id]: rev }));
    storage.setItem('ipv4-subnet-planner:head', rev.id);
    expect(restoreHead().corrupt).toBe(true);
  });

  it('读-合并-写：不覆盖其他标签页已写入的 revision', () => {
    const tabA = newStore();
    const tabB = newStore();
    const r1 = makeRevision([], 'A', validPlan());
    persistRevision(tabA, r1);
    // B 基于 r1 写入 r2（B 的内存表独立，从共享存储合并不到 r1 之外的条目）
    const r2 = makeRevision([r1.id], 'B', validPlan());
    persistRevision(tabB, r2);
    // A 再写 r3：共享存储中 B 的 r2 不得丢失
    const r3 = makeRevision([r1.id], 'A', validPlan());
    persistRevision(tabA, r3);
    const raw = JSON.parse(storage.getItem('ipv4-subnet-planner:revisions')!) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(3);
    expect(raw[r2.id]).toBeDefined();
    expect(tabA.revisions.has(r2.id)).toBe(true);
  });

  it('storeRevision 入库但不移动 head，advanceHead 仅更新 head 指针', () => {
    const store = newStore();
    const r1 = makeRevision([], 'A', validPlan());
    persistRevision(store, r1);
    // 模拟收到外部 revision：入库后本地 head 不变
    const external = makeRevision([r1.id], 'B', validPlan());
    storeRevision(store, external);
    expect(store.revisions.has(external.id)).toBe(true);
    expect(store.headId).toBe(r1.id);
    expect(storage.getItem('ipv4-subnet-planner:head')).toBe(r1.id);
    // 快进后推进 head
    advanceHead(store, external.id);
    expect(store.headId).toBe(external.id);
    expect(storage.getItem('ipv4-subnet-planner:head')).toBe(external.id);
    expect(restoreHead().store.headId).toBe(external.id);
  });

  it('超出上限时裁剪掉 head 祖先之外的 revision', () => {
    const store = newStore();
    let parent: string[] = [];
    let headId = '';
    for (let i = 0; i < MAX_REVISIONS + 10; i++) {
      const rev = makeRevision(parent, 'c', validPlan());
      persistRevision(store, rev);
      parent = [rev.id];
      headId = rev.id;
    }
    expect(store.revisions.size).toBeLessThanOrEqual(MAX_REVISIONS);
    expect(store.revisions.has(headId)).toBe(true);
    // 保留的每条 revision 都是 head 的祖先（或 head 自身）
    for (const id of store.revisions.keys()) {
      expect(id === headId || isAncestor(store.revisions, id, headId)).toBe(true);
    }
  });
});
