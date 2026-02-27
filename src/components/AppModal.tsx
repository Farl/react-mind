import { useEffect } from "react";
import type { ReactNode } from "react";

type AppModalProps = {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
};

export function AppModal({ isOpen, title, onClose, children, footer }: AppModalProps) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="app-modal" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="app-modal__backdrop" aria-label="Close dialog" onClick={onClose} />
      <section className="app-modal__panel">
        <header className="app-modal__header">
          <h3>{title}</h3>
          <button type="button" className="app-modal__close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>

        <div className="app-modal__content">{children}</div>

        {footer ? <footer className="app-modal__footer">{footer}</footer> : null}
      </section>
    </div>
  );
}
