import { ReactNode, useMemo, useState } from 'react';
import { Allocation, RootBlock } from '../lib/model';
import { TreeNode, buildTree } from '../lib/planner';
import {
  blockSize,
  broadcastOf,
  cidrToString,
  longToIpv4,
  parseCidr,
  usableHosts,
} from '../lib/ip';

interface Props {
  roots: RootBlock[];
  allocations: Allocation[];
  onRelease: (id: string) => void;
  onResize: (alloc: Allocation) => void;
}

export default function TreeView({ roots, allocations, onRelease, onResize }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const trees = useMemo(() => {
    return roots
      .map((root) => {
        const rc = parseCidr(root.cidr);
        if (!rc) return null;
        const inside = allocations
          .map((a) => ({ alloc: a, cidr: parseCidr(a.cidr)! }))
          .filter(({ cidr }) => cidr && cidr.base >= rc.base && cidr.prefix >= rc.prefix &&
            cidr.base + blockSize(cidr.prefix) <= rc.base + blockSize(rc.prefix));
        return { root, tree: buildTree(rc, inside) };
      })
      .filter((t): t is { root: RootBlock; tree: TreeNode } => t !== null);
  }, [roots, allocations]);

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (roots.length === 0) {
    return (
      <section className="panel">
        <h2>地址空间树</h2>
        <p className="muted">添加根网段后，这里将展示树形地址空间。</p>
      </section>
    );
  }

  const renderNode = (node: TreeNode): ReactNode => {
    const isCollapsed = collapsed.has(node.key);
    const c = node.cidr;
    const range = `${longToIpv4(c.base)} – ${longToIpv4(broadcastOf(c))}`;
    return (
      <div key={node.key} className="tree-node">
        <div
          className={`tree-row status-${node.status}`}
          style={{ paddingLeft: `${node.depth * 18 + 8}px` }}
        >
          {node.status === 'partial' ? (
            <button className="twisty" onClick={() => toggle(node.key)} aria-label="展开/折叠">
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="twisty-placeholder" />
          )}
          <code className="cidr">{cidrToString(c)}</code>
          {node.status === 'free' && (
            <>
              <span className="badge free">空闲</span>
              <span className="muted range">{range}</span>
              <span className="muted">可用主机 {usableHosts(c.prefix).toLocaleString()}</span>
            </>
          )}
          {node.status === 'partial' && (
            <>
              <span className="badge partial">部分占用</span>
              <span className="muted range">{range}</span>
            </>
          )}
          {node.status === 'allocated' && node.alloc && (
            <>
              <span className={`badge ${node.alloc.kind}`}>
                {node.alloc.kind === 'reserved' ? '保留段' : '子网'}
              </span>
              <strong className="alloc-name">{node.alloc.name}</strong>
              <span className="muted range">{range}</span>
              <span className="muted">可用主机 {usableHosts(c.prefix).toLocaleString()}</span>
              {node.alloc.note && <span className="muted note">· {node.alloc.note}</span>}
              <span className="row-actions inline">
                <button className="btn small" onClick={() => onResize(node.alloc!)}>
                  调整容量
                </button>
                <button
                  className="btn small danger"
                  onClick={() => {
                    if (window.confirm(`释放「${node.alloc!.name}」(${node.alloc!.cidr})？`))
                      onRelease(node.alloc!.id);
                  }}
                >
                  释放
                </button>
              </span>
            </>
          )}
        </div>
        {node.children && !isCollapsed && (
          <div className="tree-children">
            {renderNode(node.children[0])}
            {renderNode(node.children[1])}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="panel">
      <h2>地址空间树</h2>
      {trees.map(({ root, tree }) => (
        <div key={root.id} className="tree-root">
          <div className="tree-root-head">
            <strong>{root.name}</strong>
            <code>{root.cidr}</code>
          </div>
          {renderNode(tree)}
        </div>
      ))}
    </section>
  );
}
