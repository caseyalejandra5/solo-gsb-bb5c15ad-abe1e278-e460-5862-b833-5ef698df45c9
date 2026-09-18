import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Allocation,
  Plan,
  RootBlock,
  emptyPlan,
  newId,
  parsePlanJson,
  serializePlan,
  validateAllocation,
  validateRoots,
} from './lib/model';
import {
  MigrationPlan,
  applyMigration,
  findLowestSlot,
  planMigration,
} from './lib/planner';
import {
  CHANNEL_NAME,
  Revision,
  RevisionStore,
  advanceHead,
  classifyRemote,
  clearStored,
  getClientId,
  isAncestor,
  makeRevision,
  persistRevision,
  restoreHead,
  storeRevision,
  validateRevision,
} from './lib/sync';
import { cidrToString, parseCidr, prefixForHosts } from './lib/ip';
import Toolbar from './components/Toolbar';
import RootsPanel from './components/RootsPanel';
import TreeView from './components/TreeView';
import AllocationsPanel from './components/AllocationsPanel';
import NewAllocationForm from './components/NewAllocationForm';
import MigrationModal from './components/MigrationModal';
import PrefixPolicyModal from './components/PrefixPolicyModal';
import ConflictModal from './components/ConflictModal';

interface MigrationRequest {
  title: string;
  plan: MigrationPlan;
  /** 确认后整批原子应用的下一个规划 */
  next: Plan;
}

/** 未解决的协同冲突：本页 head 与外部分叉版本各执一份 */
interface ConflictState {
  local: Revision;
  remote: Revision;
}

function demoPlan(): Plan {
  const roots: RootBlock[] = [
    { id: newId('root'), name: '生产骨干', cidr: '10.0.0.0/8' },
    { id: newId('root'), name: '办公网', cidr: '192.168.0.0/16' },
  ];
  const mk = (name: string, cidr: string, kind: Allocation['kind'], note?: string): Allocation => ({
    id: newId('alloc'),
    name,
    kind,
    prefix: parseCidr(cidr)!.prefix,
    cidr,
    note,
  });
  return {
    version: 1,
    roots,
    allocations: [
      mk('核心交换区', '10.0.0.0/16', 'reserved', '预留扩容'),
      mk('数据中心-A', '10.1.0.0/18', 'subnet'),
      mk('数据中心-B', '10.1.64.0/18', 'subnet'),
      mk('办公有线', '192.168.0.0/22', 'subnet'),
      mk('办公无线', '192.168.4.0/22', 'subnet'),
      mk('访客网络', '192.168.8.0/24', 'subnet'),
    ],
  };
}

export default function App() {
  const [clientId] = useState(getClientId);
  /** 启动时从 localStorage 恢复 head 指向的 revision（损坏则忽略并提示） */
  const [restore] = useState(restoreHead);
  const [plan, setPlan] = useState<Plan>(() => {
    if (restore.corrupt || !restore.store.headId) return emptyPlan();
    return restore.store.revisions.get(restore.store.headId)!.plan;
  });
  const [past, setPast] = useState<Plan[]>([]);
  const [future, setFuture] = useState<Plan[]>([]);
  const [migration, setMigration] = useState<MigrationRequest | null>(null);
  const [resizeTarget, setResizeTarget] = useState<Allocation | null>(null);
  const [prefixPolicyOpen, setPrefixPolicyOpen] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const storeRef = useRef<RevisionStore>(
    restore.corrupt ? { revisions: new Map(), headId: null } : restore.store,
  );
  const headRef = useRef<string | null>(restore.corrupt ? null : restore.store.headId);
  const planRef = useRef(plan);
  const conflictRef = useRef(conflict);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    planRef.current = plan;
  }, [plan]);
  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 5000);
  }, []);

  /** 损坏快照：忽略并清除，避免每次启动重复提示 */
  useEffect(() => {
    if (restore.corrupt) {
      clearStored();
      showToast('本地快照已损坏，已忽略并从空白规划开始');
    }
  }, [restore.corrupt, showToast]);

  /** 本地变更发布为 revision：入库、更新 head、广播（撤销/重做/导入/清空同走此路） */
  const publish = useCallback(
    (next: Plan) => {
      const rev = makeRevision(headRef.current ? [headRef.current] : [], clientId, next);
      try {
        persistRevision(storeRef.current, rev);
      } catch {
        showToast('本地持久化失败：浏览器存储不可用或已满');
      }
      headRef.current = rev.id;
      channelRef.current?.postMessage({ type: 'revision', revision: rev });
    },
    [clientId, showToast],
  );

  /** 处理其他标签页广播来的 revision：按修订图决定快进 / 忽略 / 冲突 */
  const handleRemote = useCallback(
    (rev: Revision) => {
      const store = storeRef.current;
      if (store.revisions.has(rev.id)) return; // 已处理过的重复消息
      try {
        storeRevision(store, rev); // 先入库，保证修订图完整（不移动本地 head）
      } catch {
        showToast('本地持久化失败：浏览器存储不可用或已满');
      }
      const head = headRef.current;
      const verdict = classifyRemote(store.revisions, head, rev.id);
      if (verdict === 'fast-forward') {
        // 当前版本是其祖先：自动快进，并作为一次可撤销变更
        setPast((p) => [...p, planRef.current]);
        setFuture([]);
        setPlan(rev.plan);
        headRef.current = rev.id;
        try {
          advanceHead(store, rev.id);
        } catch {
          /* head 指针发送方已写入，本地写失败不影响同步 */
        }
        // 若该 revision 已合并冲突对方（其他标签页先解决了冲突），自动关闭冲突弹窗
        const c = conflictRef.current;
        if (c && isAncestor(store.revisions, c.remote.id, rev.id)) setConflict(null);
        showToast('已同步其他标签页的修改');
      } else if (verdict === 'stale') {
        // 外部版本是当前版本的祖先：过期消息，忽略
      } else if (!conflictRef.current) {
        // 双方互不为祖先：保留两份并弹窗，绝不按时间戳覆盖
        const local = head ? store.revisions.get(head) : undefined;
        if (local) setConflict({ local, remote: rev });
      }
      // 已有冲突在审时：保留首个冲突；新 revision 已入库，解决后按图继续收敛
    },
    [showToast],
  );

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; revision?: unknown } | null;
      if (!data || data.type !== 'revision') return;
      const errors = validateRevision(data.revision);
      if (errors.length > 0) {
        showToast('收到损坏的协同快照，已忽略');
        return;
      }
      handleRemote(data.revision as Revision);
    };
    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, [handleRemote, showToast]);

  /** 冲突解决：生成同时引用两个版本的合并 revision 并继续广播 */
  const resolveConflict = useCallback(
    (choice: 'keep' | 'adopt') => {
      const c = conflictRef.current;
      if (!c) return;
      const next = choice === 'keep' ? planRef.current : c.remote.plan;
      const merge = makeRevision([headRef.current ?? c.local.id, c.remote.id], clientId, next);
      try {
        persistRevision(storeRef.current, merge);
      } catch {
        showToast('本地持久化失败：浏览器存储不可用或已满');
      }
      headRef.current = merge.id;
      channelRef.current?.postMessage({ type: 'revision', revision: merge });
      if (choice === 'adopt') {
        // 采用外部：Plan 发生变化，作为一次可撤销变更
        setPast((p) => [...p, planRef.current]);
        setFuture([]);
        setPlan(c.remote.plan);
      }
      setConflict(null);
      showToast(
        choice === 'keep'
          ? '已保留本页内容，合并 revision 已广播'
          : '已采用外部版本，合并 revision 已广播',
      );
    },
    [clientId, showToast],
  );

  /** 所有状态变更的唯一入口：记录历史、清空重做栈、发布 revision。冲突期间拒绝并返回 false */
  const commit = useCallback(
    (next: Plan): boolean => {
      if (conflictRef.current) {
        showToast('存在未解决的协同冲突，请先在弹窗中处理');
        return false;
      }
      setPast((p) => [...p, plan]);
      setFuture([]);
      setPlan(next);
      publish(next);
      return true;
    },
    [plan, publish, showToast],
  );

  const undo = useCallback(() => {
    if (conflictRef.current) {
      showToast('存在未解决的协同冲突，请先在弹窗中处理');
      return;
    }
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture((f) => [plan, ...f]);
    setPlan(prev);
    publish(prev);
  }, [past, plan, publish, showToast]);

  const redo = useCallback(() => {
    if (conflictRef.current) {
      showToast('存在未解决的协同冲突，请先在弹窗中处理');
      return;
    }
    if (future.length === 0) return;
    const next = future[0];
    setFuture(future.slice(1));
    setPast((p) => [...p, plan]);
    setPlan(next);
    publish(next);
  }, [future, plan, publish, showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  /** 根网段或容量变更的统一入口：先预演，全部可保留则直接应用，否则弹窗确认 */
  const requestMigration = useCallback(
    (title: string, nextRoots: RootBlock[], nextAllocs: Allocation[]) => {
      const mig = planMigration(nextRoots, nextAllocs);
      const next: Plan = {
        ...plan,
        roots: nextRoots,
        allocations: applyMigration(nextAllocs, mig),
      };
      if (mig.ok && mig.items.every((i) => i.status === 'kept')) {
        if (commit(next)) showToast('已应用：所有分配均可原位保留');
      } else {
        setMigration({ title, plan: mig, next });
      }
    },
    [plan, commit, showToast],
  );

  // ---- 根网段 ----
  const addRoot = useCallback(
    (name: string, cidr: string): string[] => {
      const root: RootBlock = { id: newId('root'), name: name.trim(), cidr: cidr.trim() };
      const errors = validateRoots([...plan.roots, root]);
      if (errors.length > 0) return errors;
      const normalized = { ...root, cidr: cidrToString(parseCidr(root.cidr)!) };
      commit({ ...plan, roots: [...plan.roots, normalized] });
      return [];
    },
    [plan, commit],
  );

  const editRoot = useCallback(
    (id: string, name: string, cidr: string): string[] => {
      const nextRoots = plan.roots.map((r) =>
        r.id === id ? { ...r, name: name.trim(), cidr: cidr.trim() } : r,
      );
      const errors = validateRoots(nextRoots);
      if (errors.length > 0) return errors;
      const normalized = nextRoots.map((r) => ({
        ...r,
        cidr: cidrToString(parseCidr(r.cidr)!),
      }));
      requestMigration(`调整根网段「${name.trim()}」`, normalized, plan.allocations);
      return [];
    },
    [plan, requestMigration],
  );

  const removeRoot = useCallback(
    (id: string) => {
      const root = plan.roots.find((r) => r.id === id);
      if (!root) return;
      const nextRoots = plan.roots.filter((r) => r.id !== id);
      requestMigration(`删除根网段「${root.name}」(${root.cidr})`, nextRoots, plan.allocations);
    },
    [plan, requestMigration],
  );

  // ---- 分配 ----
  const addReservation = useCallback(
    (name: string, cidr: string, note: string): string[] => {
      const candidate = { name: name.trim(), cidr: cidr.trim() };
      const errors = validateAllocation(plan, candidate);
      if (errors.length > 0) return errors;
      const parsed = parseCidr(candidate.cidr)!;
      const alloc: Allocation = {
        id: newId('alloc'),
        name: candidate.name,
        kind: 'reserved',
        prefix: parsed.prefix,
        cidr: cidrToString(parsed),
        note: note.trim() || undefined,
      };
      commit({ ...plan, allocations: [...plan.allocations, alloc] });
      return [];
    },
    [plan, commit],
  );

  const requestSubnet = useCallback(
    (name: string, hosts: number, rootId: string, note: string): string[] => {
      const errors: string[] = [];
      if (!name.trim()) errors.push('名称不能为空');
      if (!Number.isInteger(hosts) || hosts < 1) errors.push('主机数必须为不小于 1 的整数');
      if (errors.length > 0) return errors;
      let prefix: number;
      try {
        prefix = prefixForHosts(hosts);
      } catch (e) {
        return [(e as Error).message];
      }
      const roots = plan.roots
        .filter((r) => rootId === 'auto' || r.id === rootId)
        .map((r) => parseCidr(r.cidr)!);
      if (roots.length === 0) return ['尚未定义任何根网段'];
      const occupied = plan.allocations.map((a) => parseCidr(a.cidr)!);
      const slot = findLowestSlot(roots, occupied, prefix);
      if (!slot) {
        return [`地址空间不足：没有可容纳 ${hosts} 台主机（/${prefix}）的空闲块`];
      }
      const alloc: Allocation = {
        id: newId('alloc'),
        name: name.trim(),
        kind: 'subnet',
        prefix,
        cidr: cidrToString(slot),
        note: note.trim() || undefined,
      };
      commit({ ...plan, allocations: [...plan.allocations, alloc] });
      return [];
    },
    [plan, commit],
  );

  const releaseAllocation = useCallback(
    (id: string) => {
      if (commit({ ...plan, allocations: plan.allocations.filter((a) => a.id !== id) })) {
        showToast('已释放，相邻空闲伙伴块已自动合并');
      }
    },
    [plan, commit, showToast],
  );

  const resizeAllocation = useCallback(
    (id: string, hosts: number): string[] => {
      const alloc = plan.allocations.find((a) => a.id === id);
      if (!alloc) return ['分配不存在'];
      if (!Number.isInteger(hosts) || hosts < 1) return ['主机数必须为不小于 1 的整数'];
      const prefix = prefixForHosts(hosts);
      if (prefix === alloc.prefix) return [`新容量与当前相同（/${prefix}），无需调整`];
      const nextAllocs = plan.allocations.map((a) => (a.id === id ? { ...a, prefix } : a));
      setResizeTarget(null);
      requestMigration(
        `调整「${alloc.name}」容量：/${alloc.prefix} → /${prefix}（${hosts} 台主机）`,
        plan.roots,
        nextAllocs,
      );
      return [];
    },
    [plan, requestMigration],
  );

  // ---- 导入导出 ----
  const exportPlan = useCallback(() => {
    const blob = new Blob([serializePlan(plan)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subnet-plan-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [plan]);

  const importPlan = useCallback(
    (text: string) => {
      try {
        const imported = parsePlanJson(text);
        if (commit(imported)) showToast('规划导入成功');
      } catch (e) {
        showToast((e as Error).message);
      }
    },
    [commit, showToast],
  );

  const loadDemo = useCallback(() => commit(demoPlan()), [commit]);
  const resetPlan = useCallback(() => commit(emptyPlan()), [commit]);

  return (
    <div className="app">
      <Toolbar
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        editingDisabled={conflict !== null}
        onUndo={undo}
        onRedo={redo}
        onExport={exportPlan}
        onImport={importPlan}
        onLoadDemo={loadDemo}
        onReset={resetPlan}
        onPrefixPolicy={() => setPrefixPolicyOpen(true)}
      />

      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast.split('\n').map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      <main className="layout">
        <aside className="sidebar">
          <RootsPanel
            roots={plan.roots}
            allocations={plan.allocations}
            onAdd={addRoot}
            onEdit={editRoot}
            onRemove={removeRoot}
          />
          <NewAllocationForm
            roots={plan.roots}
            onAddReservation={addReservation}
            onRequestSubnet={requestSubnet}
          />
        </aside>

        <section className="content">
          <TreeView
            roots={plan.roots}
            allocations={plan.allocations}
            onRelease={releaseAllocation}
            onResize={(a) => setResizeTarget(a)}
          />
          <AllocationsPanel
            plan={plan}
            onRelease={releaseAllocation}
            onResize={(a) => setResizeTarget(a)}
          />
        </section>
      </main>

      {resizeTarget && (
        <div className="modal-backdrop" onClick={() => setResizeTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>调整容量：{resizeTarget.name}</h3>
            <p className="muted">
              当前 {resizeTarget.cidr}。输入新的可用主机数，系统将预演迁移。
            </p>
            <ResizeForm
              onSubmit={(hosts) => resizeAllocation(resizeTarget.id, hosts)}
              onCancel={() => setResizeTarget(null)}
            />
          </div>
        </div>
      )}

      {migration && (
        <MigrationModal
          title={migration.title}
          plan={migration.plan}
          onConfirm={() => {
            if (commit(migration.next)) {
              setMigration(null);
              showToast('迁移已整批原子应用');
            }
          }}
          onCancel={() => setMigration(null)}
        />
      )}

      {prefixPolicyOpen && (
        <PrefixPolicyModal
          allocations={plan.allocations}
          onClose={() => setPrefixPolicyOpen(false)}
        />
      )}

      {conflict && (
        <ConflictModal
          local={conflict.local}
          remote={conflict.remote}
          onResolve={resolveConflict}
        />
      )}
    </div>
  );
}

function ResizeForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (hosts: number) => string[];
  onCancel: () => void;
}) {
  const [hosts, setHosts] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const errs = onSubmit(Number(hosts));
        setErrors(errs);
      }}
    >
      <label className="field">
        <span>新主机数</span>
        <input
          autoFocus
          type="number"
          min={1}
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
          placeholder="例如 500"
        />
      </label>
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((er, i) => (
            <li key={i}>{er}</li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn primary">
          预演迁移
        </button>
      </div>
    </form>
  );
}
