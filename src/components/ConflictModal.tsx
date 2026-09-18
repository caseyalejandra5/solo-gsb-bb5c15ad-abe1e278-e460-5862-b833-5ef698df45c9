import { Plan } from '../lib/model';

interface Props {
  local: Plan;
  remote: Plan;
  onChooseLocal: () => void;
  onChooseRemote: () => void;
}

/** 修订图分叉冲突：保留两份，由用户显式选择；禁止按时间戳自动覆盖。 */
export default function ConflictModal({ local, remote, onChooseLocal, onChooseRemote }: Props) {
  return (
    <div className="modal-backdrop conflict-backdrop">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title">
        <h3 id="conflict-title">检测到分叉更新</h3>
        <p className="muted">
          其他标签页与本页在同一基础上做了互不包含的修改。两份规划都已保留，系统不会按时间自动覆盖。
          请选择保留哪一份：被选中的内容将生成一个<strong>同时引用两个版本</strong>的合并修订并继续同步。
        </p>
        <div className="conflict-sides">
          <div className="conflict-side">
            <div className="conflict-side-title">本页版本</div>
            <ul>
              <li>根网段：{local.roots.length} 个</li>
              <li>分配：{local.allocations.length} 条</li>
            </ul>
          </div>
          <div className="conflict-side remote">
            <div className="conflict-side-title">外部标签页版本</div>
            <ul>
              <li>根网段：{remote.roots.length} 个</li>
              <li>分配：{remote.allocations.length} 条</li>
            </ul>
          </div>
        </div>
        <p className="muted conflict-hint">
          冲突解决前规划编辑已锁定；导出等只读操作仍可用，放弃的那份仍可在修订历史中找到。
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onChooseLocal}>
            保留本页
          </button>
          <button type="button" className="btn primary" onClick={onChooseRemote}>
            采用外部
          </button>
        </div>
      </div>
    </div>
  );
}
