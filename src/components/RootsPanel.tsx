import { useState } from 'react';
import { Allocation, RootBlock } from '../lib/model';
import { blockSize, contains, parseCidr } from '../lib/ip';

interface Props {
  roots: RootBlock[];
  allocations: Allocation[];
  onAdd: (name: string, cidr: string) => string[];
  onEdit: (id: string, name: string, cidr: string) => string[];
  onRemove: (id: string) => void;
}

export default function RootsPanel({ roots, allocations, onAdd, onEdit, onRemove }: Props) {
  const [name, setName] = useState('');
  const [cidr, setCidr] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [editing, setEditing] = useState<RootBlock | null>(null);
  const [editErrors, setEditErrors] = useState<string[]>([]);

  const usedIn = (root: RootBlock) => {
    const rc = parseCidr(root.cidr);
    if (!rc) return 0;
    return allocations.reduce((sum, a) => {
      const ac = parseCidr(a.cidr);
      return ac && contains(rc, ac) ? sum + blockSize(ac.prefix) : sum;
    }, 0);
  };

  return (
    <section className="panel">
      <h2>根网段</h2>
      {roots.length === 0 && <p className="muted">尚未定义根网段，请先添加互不重叠的根 CIDR。</p>}
      <ul className="root-list">
        {roots.map((r) => {
          const rc = parseCidr(r.cidr);
          const used = usedIn(r);
          const total = rc ? blockSize(rc.prefix) : 0;
          const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
          return (
            <li key={r.id} className="root-item">
              <div className="root-head">
                <strong>{r.name}</strong>
                <code>{r.cidr}</code>
              </div>
              <div className="usage-bar" title={`已用 ${pct.toFixed(2)}%`}>
                <div className="usage-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="root-meta muted">
                共 {total.toLocaleString()} 地址 · 已用 {used.toLocaleString()}（{pct.toFixed(2)}%）
              </div>
              <div className="row-actions">
                <button className="btn small" onClick={() => { setEditing({ ...r }); setEditErrors([]); }}>
                  编辑
                </button>
                <button
                  className="btn small danger"
                  onClick={() => {
                    if (window.confirm(`删除根网段「${r.name}」？其内分配将进入迁移预演。`)) onRemove(r.id);
                  }}
                >
                  删除
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const errs = onAdd(name, cidr);
          setErrors(errs);
          if (errs.length === 0) {
            setName('');
            setCidr('');
          }
        }}
      >
        <div className="field-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="名称，如 生产骨干"
            aria-label="根网段名称"
          />
          <input
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            placeholder="CIDR，如 10.0.0.0/8"
            aria-label="根网段 CIDR"
          />
        </div>
        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((er, i) => (
              <li key={i}>{er}</li>
            ))}
          </ul>
        )}
        <button type="submit" className="btn primary block">
          添加根网段
        </button>
      </form>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>编辑根网段</h3>
            <p className="muted">若影响既有分配，将先进行迁移预演。</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const errs = onEdit(editing.id, editing.name, editing.cidr);
                setEditErrors(errs);
                if (errs.length === 0) setEditing(null);
              }}
            >
              <label className="field">
                <span>名称</span>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>CIDR</span>
                <input
                  value={editing.cidr}
                  onChange={(e) => setEditing({ ...editing, cidr: e.target.value })}
                />
              </label>
              {editErrors.length > 0 && (
                <ul className="errors">
                  {editErrors.map((er, i) => (
                    <li key={i}>{er}</li>
                  ))}
                </ul>
              )}
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button type="submit" className="btn primary">
                  预演并应用
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
