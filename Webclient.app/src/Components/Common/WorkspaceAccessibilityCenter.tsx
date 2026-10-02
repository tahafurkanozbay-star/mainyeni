import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useWorkspaceAccessibility } from './WorkspaceAccessibilityProvider';
import { workspaceStatusToneLabel } from '../../experience/workspace/workspaceAccessibilityStatusModel';
import type { WorkspaceFocusZone } from '../../experience/workspace/workspaceAccessibilityModel';
import './workspace-accessibility-center.css';

interface FocusAction {
  readonly zone: WorkspaceFocusZone;
  readonly label: string;
  readonly description: string;
  readonly keyHint: string;
}

const FOCUS_ACTIONS: readonly FocusAction[] = Object.freeze([
  Object.freeze({
    zone: 'workspace',
    label: 'Çalışma alanı',
    description: 'Ana çalışma alanı kontrollerine geçin.',
    keyHint: 'F6',
  }),
  Object.freeze({
    zone: 'tools',
    label: 'Araçlar',
    description: 'Katman ve harita araçları paneline geçin.',
    keyHint: 'F6',
  }),
  Object.freeze({
    zone: 'map',
    label: 'Harita',
    description: 'Harita çalışma yüzeyine geçin.',
    keyHint: 'F6',
  }),
]);

const preferenceDescription = (
  title: string,
  description: string,
  checked: boolean,
  onChange: (next: boolean) => void,
): ReactNode => (
  <label className="workspace-accessibility-center__preference">
    <span className="workspace-accessibility-center__preference-copy">
      <strong>{title}</strong>
      <span>{description}</span>
    </span>
    <span className="workspace-accessibility-center__switch">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span aria-hidden="true" className="workspace-accessibility-center__switch-track" />
    </span>
  </label>
);

export const WorkspaceAccessibilityCenter = (): ReactNode => {
  const {
    snapshot,
    preferences,
    status,
    updatePreferences,
    resetPreferences,
    focusZone,
    announce,
  } = useWorkspaceAccessibility();
  const panelId = useId();
  const headingId = useId();
  const descriptionId = useId();
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const open = preferences.showStatusCenter;

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      updatePreferences({ showStatusCenter: false });
      requestAnimationFrame(() => launcherRef.current?.focus({ preventScroll: true }));
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, updatePreferences]);

  const close = (): void => {
    updatePreferences({ showStatusCenter: false });
    requestAnimationFrame(() => launcherRef.current?.focus({ preventScroll: true }));
  };

  const handleFocusAction = (zone: WorkspaceFocusZone): void => {
    const moved = focusZone(zone, 'landmark-cycle');
    if (moved) close();
  };

  const onLauncherKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    updatePreferences({ showStatusCenter: true });
  };

  return (
    <div
      className="workspace-accessibility-center"
      data-open={String(open)}
      data-online={String(snapshot.accessibility.online)}
      data-busy={String(snapshot.accessibility.mapBusy)}
      data-modality={snapshot.accessibility.modality}
    >
      <button
        ref={launcherRef}
        type="button"
        className="workspace-accessibility-center__launcher"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => updatePreferences({ showStatusCenter: !open })}
        onKeyDown={onLauncherKeyDown}
      >
        <span className="workspace-accessibility-center__launcher-copy">
          <strong>Erişilebilirlik</strong>
          <span>{status.hasCriticalIssue ? 'Dikkat gerekiyor' : status.hasAttentionIssue ? 'Durum izleniyor' : 'Hazır'}</span>
        </span>
        <span
          className="workspace-accessibility-center__launcher-indicator"
          data-tone={status.hasCriticalIssue ? 'critical' : status.hasAttentionIssue ? 'attention' : 'positive'}
          aria-hidden="true"
        />
      </button>

      {open && (
        <aside
          id={panelId}
          className="workspace-accessibility-center__panel"
          role="region"
          aria-labelledby={headingId}
          aria-describedby={descriptionId}
        >
          <header className="workspace-accessibility-center__header">
            <div>
              <p className="workspace-accessibility-center__eyebrow">Çalışma alanı erişimi</p>
              <h2 id={headingId}>Erişilebilirlik merkezi</h2>
              <p id={descriptionId}>{status.summary}</p>
            </div>
            <button
              ref={closeRef}
              type="button"
              className="workspace-accessibility-center__close"
              onClick={close}
              aria-label="Erişilebilirlik merkezini kapat"
            >
              Kapat
            </button>
          </header>

          <div className="workspace-accessibility-center__scroll">
            <section className="workspace-accessibility-center__section" aria-labelledby={`${headingId}-status`}>
              <div className="workspace-accessibility-center__section-heading">
                <div>
                  <h3 id={`${headingId}-status`}>{status.headline}</h3>
                  <p>Bu özet yalnız çalışma alanı durumunu açıklar; WCAG uygunluk puanı değildir.</p>
                </div>
                <span className="workspace-accessibility-center__surface-count">
                  {status.focusableSurfaceCount}/{status.availableSurfaceCount || status.surfaces.length} yüzey
                </span>
              </div>

              <dl className="workspace-accessibility-center__status-grid">
                {status.items.map((item) => (
                  <div key={item.id} className="workspace-accessibility-center__status-item" data-tone={item.tone}>
                    <dt>{item.label}</dt>
                    <dd>
                      <span>{item.value}</span>
                      <small>{workspaceStatusToneLabel(item.tone)}</small>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="workspace-accessibility-center__section" aria-labelledby={`${headingId}-focus`}>
              <div className="workspace-accessibility-center__section-heading">
                <div>
                  <h3 id={`${headingId}-focus`}>Hızlı odak geçişleri</h3>
                  <p>Fare kullanmadan ana çalışma yüzeylerinden birine geçin.</p>
                </div>
              </div>
              <div className="workspace-accessibility-center__focus-actions">
                {FOCUS_ACTIONS.map((action) => {
                  const surface = status.surfaces.find((candidate) => candidate.id === action.zone);
                  const unavailable = surface ? !surface.available : false;
                  return (
                    <button
                      key={action.zone}
                      type="button"
                      className="workspace-accessibility-center__focus-action"
                      disabled={unavailable}
                      onClick={() => handleFocusAction(action.zone)}
                    >
                      <span>
                        <strong>{action.label}</strong>
                        <small>{action.description}</small>
                      </span>
                      <kbd>{action.keyHint}</kbd>
                    </button>
                  );
                })}
              </div>
              <p className="workspace-accessibility-center__hint">
                F6 ve Shift+F6, sayfadaki kullanılabilir ana çalışma yüzeyleri arasında ileri ve geri geçiş için korunur.
              </p>
            </section>

            <section className="workspace-accessibility-center__section" aria-labelledby={`${headingId}-preferences`}>
              <div className="workspace-accessibility-center__section-heading">
                <div>
                  <h3 id={`${headingId}-preferences`}>Görsel rehber tercihleri</h3>
                  <p>Bu seçenekler yalnız yardımcı görsel sunumu değiştirir; ekran okuyucu duyurularını kapatmaz.</p>
                </div>
              </div>
              <div className="workspace-accessibility-center__preferences">
                {preferenceDescription(
                  'Klavye rehberini göster',
                  'Harita klavye ipuçlarının görünür kalmasını sağlar.',
                  preferences.showKeyboardGuide,
                  (checked) => updatePreferences({ showKeyboardGuide: checked }),
                )}
                {preferenceDescription(
                  'Bağlantı kesilince merkezi aç',
                  'Çevrimdışı durumu görünür olduğunda bu merkezi otomatik açar.',
                  preferences.autoRevealOnOffline,
                  (checked) => updatePreferences({ autoRevealOnOffline: checked }),
                )}
                {preferenceDescription(
                  'Harita güncellenirken merkezi aç',
                  'Uzun harita güncellemelerinde çalışma durumu özetini görünür hale getirir.',
                  preferences.autoRevealOnMapBusy,
                  (checked) => updatePreferences({ autoRevealOnMapBusy: checked }),
                )}
              </div>
            </section>

            <section className="workspace-accessibility-center__section workspace-accessibility-center__section--tips" aria-labelledby={`${headingId}-tips`}>
              <h3 id={`${headingId}-tips`}>Kullanım notları</h3>
              <ul>
                <li>Tab ile etkileşimli kontrollere ilerleyin; görünür odak halkası klavye kullanımında korunur.</li>
                <li>Harita üzerinde yön tuşlarıyla gezinme, artı ve eksi tuşlarıyla yakınlaştırma kullanılabilir.</li>
                <li>Komut merkezi için Ctrl+K, kısayol yardımı için Shift+? kullanılabilir.</li>
                <li>Zorunlu renkler ve azaltılmış hareket işletim sistemi tercihlerinden otomatik algılanır.</li>
              </ul>
            </section>
          </div>

          <footer className="workspace-accessibility-center__footer">
            <button
              type="button"
              className="workspace-accessibility-center__secondary"
              onClick={() => {
                resetPreferences();
                announce('Erişilebilirlik merkezi görsel tercihleri varsayılan değerlere döndürüldü.');
              }}
            >
              Görsel tercihleri sıfırla
            </button>
            <button type="button" className="workspace-accessibility-center__primary" onClick={close}>
              Tamam
            </button>
          </footer>
        </aside>
      )}
    </div>
  );
};

export default WorkspaceAccessibilityCenter;
