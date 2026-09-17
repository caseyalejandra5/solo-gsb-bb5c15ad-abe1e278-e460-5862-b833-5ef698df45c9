import { useCallback, useEffect, useState } from 'react';
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
import { cidrToString, parseCidr, prefixForHosts } from './lib/ip';
import Toolbar from './components/Toolbar';
import RootsPanel from './components/RootsPanel';
import TreeView from './components/TreeView';
import AllocationsPanel from './components/AllocationsPanel';
import NewAllocationForm from './components/NewAllocationForm';
import MigrationModal from './components/MigrationModal';
import PrefixPolicyModal from './components/PrefixPolicyModal';

interface MigrationRequest {
  title: string;
  plan: MigrationPlan;
  /** 确认后整批原子应用的下一个规划 */
  next: Plan;
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
  const [plan, setPlan] = useState<Plan>(emptyPlan);
  const [past, setPast] = useState<Plan[]>([]);
  const [future, setFuture] = useState<Plan[]>([]);
  const [migration, setMigration] = useState<MigrationRequest | null>(null);
  const [resizeTarget, setResizeTarget] = useState<Allocation | null>(null);
  const [prefixPolicyOpen, setPrefixPolicyOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 5000);
  }, []);

  /** 所有状态变更的唯一入口：记录历史、清空重做栈 */
  const commit = useCallback(
    (next: Plan) => {
      setPast((p) => [...p, plan]);
      setFuture([]);
      setPlan(next);
    },
    [plan],
  );

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture((f) => [plan, ...f]);
    setPlan(prev);
  }, [past, plan]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture(future.slice(1));
    setPast((p) => [...p, plan]);
    setPlan(next);
  }, [future, plan]);

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
        commit(next);
        showToast('已应用：所有分配均可原位保留');
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
      commit({ ...plan, allocations: plan.allocations.filter((a) => a.id !== id) });
      showToast('已释放，相邻空闲伙伴块已自动合并');
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
        commit(imported);
        showToast('规划导入成功');
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
            commit(migration.next);
            setMigration(null);
            showToast('迁移已整批原子应用');
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
