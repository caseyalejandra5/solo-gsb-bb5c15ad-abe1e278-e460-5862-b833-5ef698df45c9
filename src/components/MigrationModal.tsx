import { MigrationPlan } from '../lib/planner';

interface Props {
  title: string;
  plan: MigrationPlan;
  onConfirm: () => void;
  onCancel: () => void;
}

const STATUS_LABEL = {
  kept: '原位保留',
  moved: '迁移',
  failed: '无法安置',
} as const;

export default function MigrationModal({ title, plan, onConfirm, onCancel }: Props) {
  const kept = plan.items.filter((i) => i.status === 'kept').length;
  const moved = plan.items.filter((i) => i.status === 'moved').length;
  const failed = plan.items.filter((i) => i.status === 'failed').length;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>迁移预演：{title}</h3>
        <p className="muted">
          保留 {kept} 项 · 迁移 {moved} 项 · 无法安置 {failed} 项。
          {plan.ok
            ? '确认后将整批原子应用。'
            : '存在无法安置的分配，禁止确认；请调整方案或先释放空间。'}
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>容量</th>
                <th>原位置</th>
                <th>新位置</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {plan.items.map((item) => (
                <tr key={item.allocId} className={`mig-${item.status}`}>
                  <td><strong>{item.name}</strong></td>
                  <td>{item.kind === 'reserved' ? '保留段' : '子网'}</td>
                  <td>/{item.prefix}</td>
                  <td><code>{item.from}</code></td>
                  <td>
                    {item.to ? <code>{item.to}</code> : <span className="muted">{item.reason}</span>}
                  </td>
                  <td>
                    <span className={`badge mig-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!plan.ok} onClick={onConfirm}>
            确认并整批应用
          </button>
        </div>
      </div>
    </div>
  );
}
