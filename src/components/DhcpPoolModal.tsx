import { useState } from 'react';
import { Allocation } from '../lib/model';
import { longToIpv4, parseCidr } from '../lib/ip';
import {
  IpRange,
  computeDhcpPool,
  formatRange,
  parseExclusions,
  rangeSize,
  usableRangeOf,
} from '../lib/dhcp';

interface Props {
  alloc: Allocation;
  onClose: () => void;
}

/**
 * 生成 DHCP 地址池弹窗：纯本地计算，不修改规划与历史。
 * 逐行输入需排除的单个 IPv4 地址或 CIDR，任一行非法或越界则不生成结果。
 */
export default function DhcpPoolModal({ alloc, onClose }: Props) {
  const subnet = parseCidr(alloc.cidr)!;
  const usable = usableRangeOf(subnet);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [pool, setPool] = useState<IpRange[] | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = () => {
    const { ranges, errors: errs } = parseExclusions(subnet, text);
    setErrors(errs);
    setCopied(false);
    if (errs.length > 0) {
      setPool(null);
      return;
    }
    setPool(computeDhcpPool(subnet, ranges));
  };

  const resultText = pool ? pool.map(formatRange).join('\n') : '';
  const totalAddrs = pool ? pool.reduce((n, r) => n + rangeSize(r), 0) : 0;

  const copyResult = async () => {
    try {
      await navigator.clipboard.writeText(resultText);
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时回退
      const ta = document.createElement('textarea');
      ta.value = resultText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>生成 DHCP 地址池：{alloc.name}</h3>
        <p className="muted">
          子网 <code>{alloc.cidr}</code>，可用范围{' '}
          <code>
            {longToIpv4(usable.start)} - {longToIpv4(usable.end)}
          </code>
          {subnet.prefix <= 30
            ? '（已自动排除网络地址与广播地址）'
            : '（/' + subnet.prefix + ' 按可用主机规则不排除任何地址）'}
          。每行输入一个需排除的 IPv4 地址或 CIDR，排除项必须完整位于子网内。
        </p>
        <label className="field">
          <span>排除项（每行一个，可留空）</span>
          <textarea
            autoFocus
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'例如：\n10.0.0.1\n10.0.0.10\n10.0.0.64/26'}
            spellCheck={false}
          />
        </label>
        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((er, i) => (
              <li key={i}>{er}</li>
            ))}
          </ul>
        )}
        {pool && (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              <span>
                地址池共 {pool.length} 段 · {totalAddrs.toLocaleString()} 个地址
              </span>
              <button className="btn small" onClick={copyResult}>
                {copied ? '已复制 ✓' : '复制结果'}
              </button>
            </div>
            <textarea readOnly rows={Math.min(Math.max(pool.length, 2), 10)} value={resultText} />
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={generate}>
            生成地址池
          </button>
        </div>
      </div>
    </div>
  );
}
