export type AppToastTone = "info" | "error";

export type AppToastItem = {
  id: number;
  tone: AppToastTone;
  message: string;
};

type AppToastStackProps = {
  toasts: AppToastItem[];
  onDismiss: (id: number) => void;
};

export function AppToastStack({ toasts, onDismiss }: AppToastStackProps) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} role="status">
          <span className="toast__message">{toast.message}</span>
          <button type="button" className="toast__close" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}