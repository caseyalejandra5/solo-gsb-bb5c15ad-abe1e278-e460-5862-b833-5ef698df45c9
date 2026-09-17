import { useState } from 'react';
import { Allocation, Plan } from '../lib/model';
import { broadcastOf, contains, longToIpv4, parseCidr, usableHosts } from '../lib/ip';
import DhcpPoolModal from './DhcpPoolModal';

interface Props {
  plan: Plan;
  onRelease: (id: string) => void;
  onResize: (alloc: Allocation) => void;
}

export default function AllocationsPanel({ plan, onRelease, onResize }: Props) {
  const [dhcpTarget, setDhcpTarget] = useState<Allocation | null>(null);
  const rootOf = (alloc: Allocation) => {
    const ac = parseCidr(alloc.cidr);
    if (!ac) return '—';
    const root = plan.roots.find((r) => {
      const rc = parseCidr(r.cidr);
      return rc && contains(rc, ac);
    });
    return root ? root.name : '—';
  };

  const sorted = [...plan.allocations].sort((a, b) => {
    const ca = parseCidr(a.cidr);
    const cb = parseCidr(b.cidr);
    return (ca?.base ?? 0) - (cb?.base ?? 0);
  });

  return (
    <section className="panel">
      <h2>分配清单（{plan.allocations.length}）</h2>
      {sorted.length === 0 ? (
        <p className="muted">暂无分配。可在左侧按主机数申请子网，或创建命名保留段。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>CIDR</th>
                <th>网络地址</th>
                <th>广播地址</th>
                <th>可用主机</th>
                <th>所属根网段</th>
                <th>备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => {
                const c = parseCidr(a.cidr)!;
                return (
                  <tr key={a.id}>
                    <td><strong>{a.name}</strong></td>
                    <td>
                      <span className={`badge ${a.kind}`}>
                        {a.kind === 'reserved' ? '保留段' : '子网'}
                      </span>
                    </td>
                    <td><code>{a.cidr}</code></td>
                    <td><code>{longToIpv4(c.base)}</code></td>
                    <td><code>{longToIpv4(broadcastOf(c))}</code></td>
                    <td>{usableHosts(c.prefix).toLocaleString()}</td>
                    <td>{rootOf(a)}</td>
                    <td className="muted">{a.note ?? '—'}</td>
                    <td>
                      <span className="row-actions inline">
                        {a.kind === 'subnet' && (
                          <button className="btn small" onClick={() => setDhcpTarget(a)}>
                            DHCP 池
                          </button>
                        )}
                        <button className="btn small" onClick={() => onResize(a)}>
                          调整容量
                        </button>
                        <button
                          className="btn small danger"
                          onClick={() => {
                            if (window.confirm(`释放「${a.name}」(${a.cidr})？`)) onRelease(a.id);
                          }}
                        >
                          释放
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {dhcpTarget && (
        <DhcpPoolModal alloc={dhcpTarget} onClose={() => setDhcpTarget(null)} />
      )}
    </section>
  );
}
