import { useRef } from 'react';

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onImport: (text: string) => void;
  onLoadDemo: () => void;
  onReset: () => void;
  onPrefixPolicy: () => void;
}

export default function Toolbar(props: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    props.onImport(text);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-icon">⌗</span>
        <h1>IPv4 子网规划台</h1>
      </div>
      <div className="toolbar-actions">
        <button className="btn" onClick={props.onUndo} disabled={!props.canUndo} title="Ctrl/Cmd+Z">
          ↩ 撤销
        </button>
        <button className="btn" onClick={props.onRedo} disabled={!props.canRedo} title="Ctrl/Cmd+Shift+Z">
          ↪ 重做
        </button>
        <span className="divider" />
        <button className="btn" onClick={props.onPrefixPolicy} title="对当前所有子网分配有序执行 prefix-list（不修改规划）">
          前缀策略校验
        </button>
        <span className="divider" />
        <button className="btn" onClick={props.onExport}>
          导出 JSON
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          导入 JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        <span className="divider" />
        <button className="btn" onClick={props.onLoadDemo}>
          载入示例
        </button>
        <button
          className="btn danger"
          onClick={() => {
            if (window.confirm('确定清空当前规划？（可撤销）')) props.onReset();
          }}
        >
          清空
        </button>
      </div>
    </header>
  );
}
