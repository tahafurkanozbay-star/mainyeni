import React, { useEffect, useId, useRef } from 'react';
import { MAP_WORKSPACE_SHORTCUTS } from './mapWorkspaceShortcuts';
import './MapWorkspaceShortcutHelp.css';

export interface MapWorkspaceShortcutHelpProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const getFocusableElements = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');

export const MapWorkspaceShortcutHelp = ({ open, onClose }: MapWorkspaceShortcutHelpProps) => {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusables = dialog ? getFocusableElements(dialog) : [];
    (focusables[0] ?? dialog)?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const currentFocusable = getFocusableElements(dialogRef.current);
      if (currentFocusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus({ preventScroll: true });
        return;
      }
      const first = currentFocusable[0];
      const last = currentFocusable[currentFocusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const restoreTarget = restoreFocusRef.current;
      if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
      restoreFocusRef.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="map-shortcut-help-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className="map-shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className="map-shortcut-help__header">
          <div>
            <p className="map-shortcut-help__eyebrow">Klavye erişimi</p>
            <h2 id={titleId}>Harita kısayolları</h2>
            <p id={descriptionId}>Sık kullanılan harita araçlarına fare kullanmadan ulaşın.</p>
          </div>
          <button type="button" className="map-shortcut-help__close" onClick={onClose} aria-label="Kısayol yardımını kapat">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="map-shortcut-help__body">
          <ul className="map-shortcut-help__list" aria-label="Kullanılabilir klavye kısayolları">
            {MAP_WORKSPACE_SHORTCUTS.map((shortcut) => (
              <li key={shortcut.id} className="map-shortcut-help__item">
                <span className="map-shortcut-help__description">{shortcut.description}</span>
                <kbd className="map-shortcut-help__key">{shortcut.label}</kbd>
              </li>
            ))}
          </ul>
          <p className="map-shortcut-help__note">Form alanında yazarken, bir modal etkileşimi sürerken veya IME ile metin oluştururken global kısayollar devre dışı kalır.</p>
        </div>
        <footer className="map-shortcut-help__footer">
          <span><kbd>Esc</kbd> ile kapatabilirsiniz.</span>
          <button type="button" className="map-shortcut-help__done" onClick={onClose}>Tamam</button>
        </footer>
      </div>
    </div>
  );
};
