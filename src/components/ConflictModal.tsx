import { Revision } from '../lib/sync';

interface Props {
  /** 本页当前 head 的 revision */
  local: Revision;
  /** 其他标签页广播来的分叉 revision */
  remote: Revision;
  /** keep = 保留本页；adopt = 采用外部 */
  onResolve: (choice: 'keep' | 'adopt') => void;
}

function summarize(rev: Revision) {
  const roots = rev.plan.roots.length;
  const allocs = rev.plan.allocations.length;
  const time = new Date(rev.createdAt).toLocaleTimeString();
  return { roots, allocs, time };
}

/**
 * 协同冲突弹窗：双方互不为祖先时弹出，强制用户二选一。
 * 两个版本都保留在修订图中，选择后生成同时引用两者的合并 revision，
 * 绝不按时间戳静默覆盖。冲突未解决前规划编辑被禁用。
 */
export default function ConflictModal({ local, remote, onResolve }: Props) {
  const l = summarize(local);
  const r = summarize(remote);
  return (
    <div className="modal-backdrop">
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>检测到协同编辑冲突</h3>
        <p className="muted">
          另一个标签页基于不同版本发布了修改，双方互不为祖先，无法自动合并。
          两个版本均已保留在修订图中；请选择保留哪一份内容，选择后将生成同时引用两个版本的合并
          revision 并广播给其他标签页。解决前规划编辑已暂停。
        </p>
        <div className="conflict-columns">
          <div className="panel conflict-side">
            <h2>本页当前版本</h2>
            <p className="muted">
              根网段 {l.roots} 个 · 分配 {l.allocs} 条
              <br />
              更新于 {l.time}
            </p>
            <button className="btn primary block" onClick={() => onResolve('keep')}>
              保留本页
            </button>
          </div>
          <div className="panel conflict-side">
            <h2>外部版本（其他标签页）</h2>
            <p className="muted">
              根网段 {r.roots} 个 · 分配 {r.allocs} 条
              <br />
              更新于 {r.time} · 来源 {remote.clientId.slice(0, 8)}…
            </p>
            <button className="btn block" onClick={() => onResolve('adopt')}>
              采用外部
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
