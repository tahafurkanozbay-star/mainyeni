import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ExperienceDialog } from './ExperienceDialog';
import {
  getCommandByName,
  mapModeAnnouncement,
  type ExperienceDensity,
  type ExperienceMapMode,
  type ExperienceMotion,
  type ExperiencePanelPlacement,
  type ExperiencePreferences,
  type ExperienceTheme,
  type ExperienceViewport,
} from '../../experience/experienceRuntime';
import {
  experienceBus,
  patchExperiencePreferences,
  resetExperiencePreferences,
} from '../../experience/experienceSession';
import {
  deriveWorkspacePresentation,
  completeMapModeTransition,
  createInitialMapModeTransition,
  describeMotion,
  describePanelPlacement,
  failMapModeTransition,
  requestMapModeTransition,
  workspaceStatusDescriptors,
  type MapModeTransitionState,
  type WorkspaceTone,
} from '../../experience/workspace/experienceWorkspaceModel';
import {
  focusExperienceTarget,
  useExperienceAnnouncements,
  useExperienceConnectivity,
  useExperienceDocumentContract,
  useExperienceGlobalShortcuts,
  useExperienceMediaPreferences,
  useExperiencePreferences,
  useExperienceRuntimeSnapshot,
  useExperienceViewport,
} from '../../experience/workspace/useExperienceEnvironment';
import './experience-workspace.css';

interface StatusItemProps {
  readonly label: string;
  readonly value: string;
  readonly tone?: WorkspaceTone;
}

const StatusItem = ({ label, value, tone = 'neutral' }: StatusItemProps): ReactNode => (
  <span className={`experience-workspace__status experience-workspace__status--${tone}`}>
    <span className="experience-workspace__status-label">{label}</span>
    <strong>{value}</strong>
  </span>
);

const ExperienceSkipLinks = (): ReactNode => {
  const focusTarget = useCallback((event: MouseEvent<HTMLAnchorElement>, selector: string): void => {
    event.preventDefault();
    focusExperienceTarget(selector);
  }, []);

  return (
    <nav className="experience-skip-links" aria-label="Hızlı atlama bağlantıları">
      <a href="#esri-map-container" onClick={(event) => focusTarget(event, '#esri-map-container')}>
        Haritaya geç
      </a>
      <a href="#sidebar" onClick={(event) => focusTarget(event, '#sidebar')}>
        Araç paneline geç
      </a>
      <a
        href="#experience-workspace-controls"
        onClick={(event) => focusTarget(event, '#experience-workspace-controls')}
      >
        Görünüm kontrollerine geç
      </a>
    </nav>
  );
};

interface MapModeControlProps {
  readonly mode: ExperienceMapMode;
  readonly pendingMode: ExperienceMapMode | null;
  readonly onChange: (mode: ExperienceMapMode) => void;
}

const MAP_MODES = Object.freeze([
  { value: '2d', short: '2B', label: '2 boyutlu harita' },
  { value: '3d', short: '3B', label: '3 boyutlu sahne' },
] satisfies readonly {
  value: ExperienceMapMode;
  short: string;
  label: string;
}[]);

const MapModeControl = ({ mode, pendingMode, onChange }: MapModeControlProps): ReactNode => {
  const busy = pendingMode !== null;
  return (
    <div
      className="experience-map-mode"
      role="group"
      aria-label="Harita görünümü"
      aria-busy={busy || undefined}
    >
      {MAP_MODES.map((option) => {
        const selected = mode === option.value;
        const pending = pendingMode === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`experience-map-mode__button ${selected ? 'is-active' : ''}`}
            aria-pressed={selected}
            aria-label={`${option.label}${selected ? ', etkin' : ''}${pending ? ', hazırlanıyor' : ''}`}
            disabled={busy}
            onClick={() => onChange(option.value)}
          >
            <span aria-hidden="true">{option.short}</span>
            <span className="experience-map-mode__long-label">{option.label}</span>
            {pending ? <span className="experience-map-mode__pending" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
};

interface SettingSelectProps<T extends string> {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly children: ReactNode;
}

function SettingSelect<T extends string>({
  id,
  label,
  description,
  value,
  onChange,
  children,
}: SettingSelectProps<T>): ReactNode {
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className="experience-setting-row">
      <div className="experience-setting-row__copy">
        <label htmlFor={id}>{label}</label>
        {description ? <p id={descriptionId}>{description}</p> : null}
      </div>
      <select
        id={id}
        value={value}
        aria-describedby={descriptionId}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value as T)}
      >
        {children}
      </select>
    </div>
  );
}

interface SettingSwitchProps {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

const SettingSwitch = ({
  id,
  label,
  description,
  checked,
  onChange,
}: SettingSwitchProps): ReactNode => {
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className="experience-setting-row">
      <div className="experience-setting-row__copy">
        <span id={`${id}-label`} className="experience-setting-row__label">{label}</span>
        {description ? <p id={descriptionId}>{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-labelledby={`${id}-label`}
        aria-checked={checked}
        aria-describedby={descriptionId}
        className={`experience-switch ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="experience-switch__track" aria-hidden="true">
          <span className="experience-switch__thumb" />
        </span>
        <span className="experience-sr-only">{checked ? 'Açık' : 'Kapalı'}</span>
      </button>
    </div>
  );
};

interface SettingsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly preferences: ExperiencePreferences;
  readonly media: ReturnType<typeof useExperienceMediaPreferences>;
  readonly viewport: ExperienceViewport;
}

const ExperienceSettingsDialog = ({
  open,
  onClose,
  preferences,
  media,
  viewport,
}: SettingsDialogProps): ReactNode => {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const summary = deriveWorkspacePresentation({
    preferences,
    media,
    viewport,
    online: true,
    mapMode: preferences.lastMapMode,
    pendingMode: null,
  });

  return (
    <ExperienceDialog
      open={open}
      onClose={onClose}
      labelledBy="experience-settings-title"
      describedBy="experience-settings-description"
      initialFocusRef={closeRef as RefObject<HTMLElement>}
      backdropClassName="experience-settings-backdrop"
      dialogClassName="experience-settings"
      testId="experience-settings"
    >
      <header className="experience-settings__header">
        <div>
          <span className="experience-eyebrow">DENEYİM AYARLARI</span>
          <h2 id="experience-settings-title">Çalışma alanını kişiselleştir</h2>
          <p id="experience-settings-description">
            Tercihler yalnız bu tarayıcıdaki arayüzü etkiler; harita verisini veya sorgu sonuçlarını değiştirmez.
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="experience-close"
          onClick={onClose}
          aria-label="Deneyim ayarlarını kapat"
        >
          ×
        </button>
      </header>

      <div className="experience-settings__summary" role="status" aria-label="Etkin deneyim özeti">
        <span>Tema <strong>{summary.theme === 'dark' ? 'Koyu' : 'Açık'}</strong></span>
        <span>Panel <strong>{describePanelPlacement(summary.panelPlacement)}</strong></span>
        <span>Hareket <strong>{describeMotion(summary.reducedMotion)}</strong></span>
      </div>

      <div className="experience-settings__body">
        <fieldset className="experience-settings__group">
          <legend>Görünüm</legend>
          <SettingSelect<ExperienceTheme>
            id="experience-theme-setting"
            label="Tema"
            description="Sistem temasını izleyebilir veya açık/koyu görünümü sabitleyebilirsiniz."
            value={preferences.theme}
            onChange={(theme) => patchExperiencePreferences({ theme })}
          >
            <option value="system">Sistem</option>
            <option value="light">Açık</option>
            <option value="dark">Koyu</option>
          </SettingSelect>
          <SettingSelect<ExperienceDensity>
            id="experience-density-setting"
            label="Arayüz yoğunluğu"
            description="Kompakt mod, geniş ekranlarda haritaya daha fazla alan bırakır."
            value={preferences.density}
            onChange={(density) => patchExperiencePreferences({ density })}
          >
            <option value="comfortable">Rahat</option>
            <option value="compact">Kompakt</option>
          </SettingSelect>
          <SettingSelect<ExperiencePanelPlacement>
            id="experience-panel-setting"
            label="Panel yerleşimi"
            description="Otomatik mod, küçük ekranlarda erişilebilir alt panel düzenini seçer."
            value={preferences.panelPlacement}
            onChange={(panelPlacement) => patchExperiencePreferences({ panelPlacement })}
          >
            <option value="auto">Otomatik</option>
            <option value="left">Sol</option>
            <option value="right">Sağ</option>
            <option value="bottom">Alt</option>
          </SettingSelect>
        </fieldset>

        <fieldset className="experience-settings__group">
          <legend>Erişilebilirlik</legend>
          <SettingSelect<ExperienceMotion>
            id="experience-motion-setting"
            label="Hareket tercihi"
            description="Azaltılmış hareket, geçiş ve animasyonları minimuma indirir."
            value={preferences.motion}
            onChange={(motion) => patchExperiencePreferences({ motion })}
          >
            <option value="system">Sistem tercihi</option>
            <option value="reduced">Azaltılmış</option>
            <option value="full">Standart</option>
          </SettingSelect>
          <SettingSwitch
            id="experience-high-contrast-setting"
            label="Harita kontrollerinde yüksek kontrast"
            description="Kontrol sınırlarını, seçili durumları ve odak vurgusunu güçlendirir."
            checked={preferences.highContrastMapControls}
            onChange={(highContrastMapControls) => patchExperiencePreferences({ highContrastMapControls })}
          />
          <SettingSwitch
            id="experience-coordinate-setting"
            label="Koordinat durumunu göster"
            description="Desteklenen görünümde koordinat durum bilgisini açık tutar."
            checked={preferences.showCoordinateReadout}
            onChange={(showCoordinateReadout) => patchExperiencePreferences({ showCoordinateReadout })}
          />
        </fieldset>
      </div>

      <footer className="experience-settings__footer">
        <button
          type="button"
          className="experience-btn experience-btn--secondary"
          onClick={() => resetExperiencePreferences()}
        >
          Varsayılanlara dön
        </button>
        <button type="button" className="experience-btn experience-btn--primary" onClick={onClose}>
          Tamam
        </button>
      </footer>
    </ExperienceDialog>
  );
};

export const ExperienceWorkspace = (): ReactNode => {
  const preferences = useExperiencePreferences();
  const viewport = useExperienceViewport();
  const online = useExperienceConnectivity();
  const media = useExperienceMediaPreferences();
  const announce = useExperienceAnnouncements();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [transition, setTransition] = useState<MapModeTransitionState>(() => (
    createInitialMapModeTransition(preferences.lastMapMode)
  ));
  const transitionRef = useRef(transition);

  const setTransitionState = useCallback((next: MapModeTransitionState): void => {
    transitionRef.current = next;
    setTransition(next);
  }, []);

  const presentation = useMemo(() => deriveWorkspacePresentation({
    preferences,
    media,
    viewport,
    online,
    mapMode: transition.committed,
    pendingMode: transition.pending,
  }), [media, online, preferences, transition.committed, transition.pending, viewport]);

  useExperienceDocumentContract(presentation);
  useExperienceRuntimeSnapshot({ preferences, viewport, media, online });
  useExperienceGlobalShortcuts();

  useEffect(() => {
    const release = experienceBus.on('kentrehberi:map-mode-changed', (detail) => {
      if (detail.mode !== '2d' && detail.mode !== '3d') return;
      const result = completeMapModeTransition(transitionRef.current, detail.mode);
      setTransitionState(result.state);
      patchExperiencePreferences({ lastMapMode: detail.mode });
      announce(mapModeAnnouncement(detail.mode));
    });
    return release;
  }, [announce, setTransitionState]);

  useEffect(() => {
    if (transition.pending === null) return undefined;
    const requestId = transition.requestId;
    const timer = window.setTimeout(() => {
      if (transitionRef.current.requestId !== requestId) return;
      const result = failMapModeTransition(transitionRef.current);
      setTransitionState(result.state);
      if (result.announcement) announce(result.announcement, result.politeness);
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [announce, setTransitionState, transition.pending, transition.requestId]);

  const requestMapMode = useCallback((nextMode: ExperienceMapMode): void => {
    const result = requestMapModeTransition(transitionRef.current, nextMode);
    if (!result.accepted) return;
    setTransitionState(result.state);
    experienceBus.command({
      name: 'map-mode',
      mode: nextMode,
      source: 'experience-workspace',
    });
    if (result.announcement) announce(result.announcement, result.politeness);
  }, [announce, setTransitionState]);

  const commandPalette = useMemo(() => getCommandByName('command-palette'), []);
  const statuses = useMemo(() => workspaceStatusDescriptors(presentation), [presentation]);

  return (
    <>
      <ExperienceSkipLinks />
      <aside
        id="experience-workspace-controls"
        className="experience-workspace"
        aria-label="Harita çalışma alanı durumu ve görünüm kontrolleri"
        tabIndex={-1}
        data-viewport={viewport}
        data-online={online ? 'true' : 'false'}
      >
        <div className="experience-workspace__status-group" aria-label="Çalışma alanı durumu">
          {statuses.map((status) => (
            <StatusItem
              key={status.key}
              label={status.label}
              value={status.value}
              tone={status.tone}
            />
          ))}
        </div>

        <div className="experience-workspace__actions">
          <MapModeControl
            mode={transition.committed}
            pendingMode={transition.pending}
            onChange={requestMapMode}
          />
          <button
            type="button"
            className="experience-workspace__action"
            aria-keyshortcuts="Control+K"
            onClick={() => experienceBus.command({
              name: 'command-palette',
              source: 'experience-workspace',
            })}
            aria-label={`Komut merkezini aç${commandPalette?.shortcut ? `, ${commandPalette.shortcut.join(' artı ')}` : ''}`}
          >
            <span aria-hidden="true">Komutlar</span>
            <kbd aria-hidden="true">Ctrl K</kbd>
          </button>
          <button
            type="button"
            className="experience-workspace__action"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          >
            Deneyim ayarları
          </button>
        </div>

        {!online ? (
          <p className="experience-sr-only" role="status">
            Ağ bağlantısı kesildi. Haritada daha önce yüklenen içerik kullanılabilir; yeni sorgular bağlantı geri geldiğinde çalışacaktır.
          </p>
        ) : null}
      </aside>

      <ExperienceSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        preferences={preferences}
        media={media}
        viewport={viewport}
      />
    </>
  );
};

export default ExperienceWorkspace;
