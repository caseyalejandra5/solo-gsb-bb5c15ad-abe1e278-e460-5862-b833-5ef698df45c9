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
import { cidrToString, parseCidr, prefixForHosts } from './lib/ip';
import {
  CHANNEL_NAME,
  Revision,
  RevisionSync,
} from './lib/revisionStore';
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
  const [conflict, setConflict] = useState<{ local: Revision; remote: Revision } | null>(null);
  const [ready, setReady] = useState(false);

  const syncRef = useRef<RevisionSync | null>(null);
  const planRef = useRef<Plan>(plan);
  planRef.current = plan;
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 6000);
  }, []);

  /** 所有状态变更的唯一入口：发布 revision、记录历史、清空重做栈。 */
  const commit = useCallback(
    (next: Plan) => {
      const sync = syncRef.current;
      if (sync?.inConflict) return; // 冲突期间禁止规划编辑
      const current = planRef.current;
      setPast((p) => [...p, current]);
      setFuture([]);
      setPlan(next);
      planRef.current = next;
      sync?.commit(next);
    },
    [],
  );

  const undo = useCallback(() => {
    const sync = syncRef.current;
    if (!sync || sync.inConflict) return;
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      const current = planRef.current;
      setFuture((f) => [current, ...f]);
      setPlan(prev);
      planRef.current = prev;
      sync.commit(prev); // 撤销同样发布为一个新修订
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    const sync = syncRef.current;
    if (!sync || sync.inConflict) return;
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      const current = planRef.current;
      setPast((p) => [...p, current]);
      setPlan(next);
      planRef.current = next;
      sync.commit(next); // 重做同样发布为一个新修订
      return f.slice(1);
    });
  }, []);

  // ---- 启动：恢复 head 修订并接入跨标签页广播 ----
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channel = null;
    }
    const uuid = (): string =>
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    // clientId 必须按标签页隔离：存在共享 localStorage 会让所有标签页误判为同一客户端。
    let clientId: string;
    try {
      clientId = window.sessionStorage.getItem('ipv4-subnet-planner/client-id') || uuid();
      window.sessionStorage.setItem('ipv4-subnet-planner/client-id', clientId);
    } catch {
      clientId = uuid();
    }

    const sync = RevisionSync.open(
      {
        onFastForward: (rev) => {
          // 外部更新可快进：作为一次可撤销变更并入本页历史。
          const current = planRef.current;
          setPast((p) => [...p, current]);
          setFuture([]);
          setPlan(rev.plan);
          planRef.current = rev.plan;
          setMigration(null); // 基于旧规划的待确认迁移已过期
          setConflict(null); // 可能是冲突期间收到双父合并修订后的自动消解
          showToast('已自动同步其他标签页的更新（可用撤销回到本页此前状态）');
        },
        onConflict: (rev) => {
          setConflict({ local: sync.head, remote: rev });
          setMigration(null);
          showToast('检测到与其他标签页的分叉更新，请选择合并方式；冲突期间编辑已锁定');
        },
        onWarning: (msg) => showToast(msg),
      },
      { storage, channel, clientId, uuid },
    );
    syncRef.current = sync;
    setPlan(sync.head.plan);
    planRef.current = sync.head.plan;
    setReady(true);

    return () => {
      sync.destroy();
      syncRef.current = null;
    };
  }, [showToast]);

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

  /** 冲突解决：生成同时引用本地与外部两个版本的合并修订并继续广播。 */
  const resolveConflict = useCallback(
    (choice: 'local' | 'remote') => {
      const sync = syncRef.current;
      const cur = conflictRef.current;
      if (!sync || !cur) return;
      const current = planRef.current;
      const chosen = choice === 'local' ? cur.local.plan : cur.remote.plan;
      sync.mergeAndHead(chosen, cur.remote.id);
      // 合并是一次显式变更：选择外部版本时合并前状态可一次撤销回来；
      // 选择保留本页时内容未变（仅合并修订图），不入历史栈。
      if (chosen !== current) {
        setPast((p) => [...p, current]);
        setFuture([]);
        setPlan(chosen);
        planRef.current = chosen;
      }
      setConflict(null);
      showToast(choice === 'local' ? '已保留本页版本并合并修订图' : '已采用外部版本并合并修订图');
      // 重新判定冲突期间挂起的其他外部修订（可能再次快进或再次冲突）。
      sync.resume();
    },
    [showToast],
  );

  /** 根网段或容量变更的统一入口：先预演，全部可保留则直接应用，否则弹窗确认 */
  const requestMigration = useCallback(
    (title: string, nextRoots: RootBlock[], nextAllocs: Allocation[]) => {
      if (syncRef.current?.inConflict) return;
      const plan = planRef.current;
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
    [commit, showToast],
  );

  // ---- 根网段 ----
  const addRoot = useCallback(
    (name: string, cidr: string): string[] => {
      const plan = planRef.current;
      const root: RootBlock = { id: newId('root'), name: name.trim(), cidr: cidr.trim() };
      const errors = validateRoots([...plan.roots, root]);
      if (errors.length > 0) return errors;
      const normalized = { ...root, cidr: cidrToString(parseCidr(root.cidr)!) };
      commit({ ...plan, roots: [...plan.roots, normalized] });
      return [];
    },
    [commit],
  );

  const editRoot = useCallback(
    (id: string, name: string, cidr: string): string[] => {
      const plan = planRef.current;
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
    [requestMigration],
  );

  const removeRoot = useCallback(
    (id: string) => {
      const plan = planRef.current;
      const root = plan.roots.find((r) => r.id === id);
      if (!root) return;
      const nextRoots = plan.roots.filter((r) => r.id !== id);
      requestMigration(`删除根网段「${root.name}」(${root.cidr})`, nextRoots, plan.allocations);
    },
    [requestMigration],
  );

  // ---- 分配 ----
  const addReservation = useCallback(
    (name: string, cidr: string, note: string): string[] => {
      const plan = planRef.current;
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
    [commit],
  );

  const requestSubnet = useCallback(
    (name: string, hosts: number, rootId: string, note: string): string[] => {
      const plan = planRef.current;
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
    [commit],
  );

  const releaseAllocation = useCallback(
    (id: string) => {
      const plan = planRef.current;
      commit({ ...plan, allocations: plan.allocations.filter((a) => a.id !== id) });
      showToast('已释放，相邻空闲伙伴块已自动合并');
    },
    [commit, showToast],
  );

  const resizeAllocation = useCallback(
    (id: string, hosts: number): string[] => {
      const plan = planRef.current;
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
    [requestMigration],
  );

  // ---- 导入导出 ----
  const exportPlan = useCallback(() => {
    const blob = new Blob([serializePlan(planRef.current)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subnet-plan-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

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

  const locked = conflict !== null;

  return (
    <div className="app">
      <Toolbar
        canUndo={past.length > 0 && !locked}
        canRedo={future.length > 0 && !locked}
        locked={locked}
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

      {locked && (
        <div className="lock-banner" role="status">
          ⚠ 检测到其他标签页的分叉更新，冲突解决前规划编辑已锁定（仍可导出与执行只读校验）。
        </div>
      )}

      <main className={`layout${locked ? ' locked' : ''}`} aria-busy={locked}>
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

      {resizeTarget && !locked && (
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

      {migration && !locked && (
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

      {conflict && (
        <ConflictModal
          local={conflict.local.plan}
          remote={conflict.remote.plan}
          onChooseLocal={() => resolveConflict('local')}
          onChooseRemote={() => resolveConflict('remote')}
        />
      )}

      {!ready && <div className="boot-veil">正在恢复本地规划…</div>}
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
