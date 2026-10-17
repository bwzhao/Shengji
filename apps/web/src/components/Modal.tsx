import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Native dialog provides focus trapping, Escape and focus restoration. */
export function Modal({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose?: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return createPortal(<dialog ref={ref} className={`sheet ${className}`} aria-label={title} onCancel={(e) => { e.preventDefault(); onClose?.(); }}>
    <div className="sheet-head"><h2 className="sheet-title">{title}</h2>{onClose && <button className="ghost small" aria-label="关闭弹窗" onClick={onClose}>关闭</button>}</div>
    {children}
  </dialog>, document.body);
}
