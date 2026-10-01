// 顶部播报：技能发动 / 提示 / 错误。
import { useStore } from '../store';

const ICON: Record<string, string> = { skill: '⚡', info: '💬', error: '⚠️' };

export default function Toast() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <span className="toast-icon">{ICON[t.kind]}</span>
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}
