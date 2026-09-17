import { useState } from 'react';
import { RootBlock } from '../lib/model';
import { prefixForHosts, usableHosts } from '../lib/ip';

interface Props {
  roots: RootBlock[];
  onAddReservation: (name: string, cidr: string, note: string) => string[];
  onRequestSubnet: (name: string, hosts: number, rootId: string, note: string) => string[];
}

export default function NewAllocationForm({ roots, onAddReservation, onRequestSubnet }: Props) {
  const [tab, setTab] = useState<'subnet' | 'reserved'>('subnet');

  // 按主机数申请
  const [sName, setSName] = useState('');
  const [sHosts, setSHosts] = useState('');
  const [sRoot, setSRoot] = useState('auto');
  const [sNote, setSNote] = useState('');
  const [sErrors, setSErrors] = useState<string[]>([]);

  // 命名保留段
  const [rName, setRName] = useState('');
  const [rCidr, setRCidr] = useState('');
  const [rNote, setRNote] = useState('');
  const [rErrors, setRErrors] = useState<string[]>([]);

  const hostsNum = Number(sHosts);
  let preview = '';
  if (Number.isInteger(hostsNum) && hostsNum >= 1) {
    const p = prefixForHosts(hostsNum);
    preview = `将分配 /${p}（可用主机 ${usableHosts(p).toLocaleString()}）`;
  }

  return (
    <section className="panel">
      <h2>新建分配</h2>
      <div className="tabs">
        <button
          className={tab === 'subnet' ? 'tab active' : 'tab'}
          onClick={() => setTab('subnet')}
          type="button"
        >
          按主机数申请
        </button>
        <button
          className={tab === 'reserved' ? 'tab active' : 'tab'}
          onClick={() => setTab('reserved')}
          type="button"
        >
          命名保留段
        </button>
      </div>

      {tab === 'subnet' ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const errs = onRequestSubnet(sName, Number(sHosts), sRoot, sNote);
            setSErrors(errs);
            if (errs.length === 0) {
              setSName('');
              setSHosts('');
              setSNote('');
            }
          }}
        >
          <input
            value={sName}
            onChange={(e) => setSName(e.target.value)}
            placeholder="名称，如 数据中心-C"
            aria-label="子网名称"
          />
          <input
            value={sHosts}
            onChange={(e) => setSHosts(e.target.value)}
            placeholder="需要的主机数，如 500"
            type="number"
            min={1}
            aria-label="主机数"
          />
          {preview && <div className="hint">{preview}（网络/广播地址不计入容量）</div>}
          <select value={sRoot} onChange={(e) => setSRoot(e.target.value)} aria-label="目标根网段">
            <option value="auto">自动选择（全部根网段中最低可用地址）</option>
            {roots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}（{r.cidr}）
              </option>
            ))}
          </select>
          <input
            value={sNote}
            onChange={(e) => setSNote(e.target.value)}
            placeholder="备注（可选）"
            aria-label="备注"
          />
          {sErrors.length > 0 && (
            <ul className="errors">
              {sErrors.map((er, i) => (
                <li key={i}>{er}</li>
              ))}
            </ul>
          )}
          <button type="submit" className="btn primary block">
            申请最小可用子网
          </button>
        </form>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const errs = onAddReservation(rName, rCidr, rNote);
            setRErrors(errs);
            if (errs.length === 0) {
              setRName('');
              setRCidr('');
              setRNote('');
            }
          }}
        >
          <input
            value={rName}
            onChange={(e) => setRName(e.target.value)}
            placeholder="名称，如 核心交换区"
            aria-label="保留段名称"
          />
          <input
            value={rCidr}
            onChange={(e) => setRCidr(e.target.value)}
            placeholder="CIDR，如 10.0.0.0/16"
            aria-label="保留段 CIDR"
          />
          <input
            value={rNote}
            onChange={(e) => setRNote(e.target.value)}
            placeholder="备注（可选）"
            aria-label="备注"
          />
          {rErrors.length > 0 && (
            <ul className="errors">
              {rErrors.map((er, i) => (
                <li key={i}>{er}</li>
              ))}
            </ul>
          )}
          <button type="submit" className="btn primary block">
            创建保留段
          </button>
        </form>
      )}
    </section>
  );
}
