import { useState } from 'react';
import { Allocation } from '../lib/model';
import { cidrToString, parseCidr } from '../lib/ip';
import {
  PolicyMatch,
  evaluatePrefixPolicy,
  formatPolicyReport,
  parsePrefixPolicy,
} from '../lib/prefixPolicy';

interface Props {
  allocations: Allocation[];
  onClose: () => void;
}

const VERDICT_LABEL: Record<PolicyMatch['verdict'], string> = {
  permit: 'permit',
  deny: 'deny',
  unmatched: 'unmatched',
};

/**
 * 前缀策略校验弹窗：对当前所有子网分配（kind === 'subnet'）有序执行 prefix-list。
 * 纯本地计算，不修改规划、不产生历史记录。
 * 任一非空规则行非法时按行报错且不生成结果。
 */
export default function PrefixPolicyModal({ allocations, onClose }: Props) {
  const subnets = allocations
    .map((alloc) => ({ alloc, cidr: parseCidr(alloc.cidr)! }))
    .filter((x) => x.alloc.kind === 'subnet' && x.cidr)
    .sort((a, b) => a.cidr.base - b.cidr.base || a.cidr.prefix - b.cidr.prefix);

  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [matches, setMatches] = useState<PolicyMatch[] | null>(null);
  const [copied, setCopied] = useState(false);

  const run = () => {
    const { rules, errors: errs } = parsePrefixPolicy(text);
    setErrors(errs);
    setCopied(false);
    if (errs.length > 0) {
      setMatches(null);
      return;
    }
    setMatches(evaluatePrefixPolicy(subnets, rules));
  };

  const report = matches ? formatPolicyReport(matches) : '';
  const permitCount = matches?.filter((m) => m.verdict === 'permit').length ?? 0;
  const denyCount = matches?.filter((m) => m.verdict === 'deny').length ?? 0;
  const unmatchedCount = matches ? matches.length - permitCount - denyCount : 0;

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时回退
      const ta = document.createElement('textarea');
      ta.value = report;
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
        <h3>前缀策略校验</h3>
        <p className="muted">
          对当前 <strong>{subnets.length}</strong> 个子网分配（命名保留段不参与）按顺序执行
          prefix-list：逐行 <code>permit|deny CIDR [ge n le m]</code>。CIDR 必须对齐；范围必须同时写为{' '}
          <code>ge n le m</code> 且满足 CIDR 前缀 ≤ n ≤ m ≤ 32；省略时仅匹配同前缀。
          分配须完整位于规则 CIDR 内且自身前缀落入范围才命中，<strong>首条命中</strong>决定
          permit/deny，未命中记为 unmatched。纯本地计算，不修改规划与历史。
        </p>
        <label className="field">
          <span>prefix-list 规则（每行一条，空行跳过；可留空则全部 unmatched）</span>
          <textarea
            autoFocus
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'例如：\npermit 10.0.0.0/8 ge 16 le 24\ndeny 10.0.0.0/8\npermit 192.168.0.0/16 le 24'}
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
        {matches && (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              <span>
                permit {permitCount} · deny {denyCount} · unmatched {unmatchedCount}
              </span>
              <button className="btn small" onClick={copyReport}>
                {copied ? '已复制 ✓' : '复制文本报告'}
              </button>
            </div>
            {matches.length === 0 ? (
              <p className="muted">当前没有可校验的子网分配。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>分配 CIDR</th>
                      <th>结论</th>
                      <th>命中行</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matches.map((m) => (
                      <tr key={m.alloc.id} className={`policy-${m.verdict}`}>
                        <td>
                          <strong>{m.alloc.name}</strong>
                        </td>
                        <td>
                          <code>{cidrToString(m.cidr)}</code>
                        </td>
                        <td>
                          <span className={`badge policy-${m.verdict}`}>
                            {VERDICT_LABEL[m.verdict]}
                          </span>
                        </td>
                        <td>
                          {m.rule ? (
                            <code>
                              第 {m.rule.lineNo} 行：{m.rule.raw}
                            </code>
                          ) : (
                            <span className="muted">未命中任何规则</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={run}>
            执行校验
          </button>
        </div>
      </div>
    </div>
  );
}
