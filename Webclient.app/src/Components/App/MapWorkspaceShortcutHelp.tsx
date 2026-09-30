import React, { useEffect, useId, useRef, useState } from 'react';
import { chordMatches, createShortcutChord, evaluateShortcutPolicy } from './mapWorkspaceShortcutPolicy';
import { MAP_WORKSPACE_SHORTCUTS } from './mapWorkspaceShortcuts';
import { createMapWorkspaceDialogSession } from './mapWorkspaceDialogRuntime';
import './MapWorkspaceShortcutHelp.css';
import './MapWorkspaceShortcutHelpLauncher.css';

export interface MapWorkspaceShortcutHelpProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const HELP_SHORTCUT = Object.freeze({ key: '?', shift: true });

export const MapWorkspaceShortcutHelp = ({ open, onClose }: MapWorkspaceShortcutHelpProps) => {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const session = createMapWorkspaceDialogSession(dialogRef.current, onClose);
    session.focusInitial();
    const onKeyDown = (event: KeyboardEvent): void => { session.handleKeyDown(event); };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      session.dispose();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="map-shortcut-help-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} className="map-shortcut-help" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
        <header className="map-shortcut-help__header">
          <div>
            <p className="map-shortcut-help__eyebrow">Klavye erişimi</p>
            <h2 id={titleId}>Harita kısayolları</h2>
            <p id={descriptionId}>Sık kullanılan harita araçlarına fare kullanmadan ulaşın.</p>
          </div>
          <button type="button" className="map-shortcut-help__close" onClick={onClose} aria-label="Kısayol yardımını kapat"><span aria-hidden="true">×</span></button>
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

export const MapWorkspaceShortcutHelpLauncher = () => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onHelpShortcut = (event: KeyboardEvent): void => {
      if (!evaluateShortcutPolicy(event).allowed) return;
      if (!chordMatches(createShortcutChord(event), HELP_SHORTCUT)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onHelpShortcut);
    return () => window.removeEventListener('keydown', onHelpShortcut);
  }, []);

  return (
    <>
      <button type="button" className="map-shortcut-help__launcher" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span aria-hidden="true">?</span>
        <span className="map-shortcut-help__launcher-label">Kısayollar</span>
      </button>
      <MapWorkspaceShortcutHelp open={open} onClose={() => setOpen(false)} />
    </>
  );
};
