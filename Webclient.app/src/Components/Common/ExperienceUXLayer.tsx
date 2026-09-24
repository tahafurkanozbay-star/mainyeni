import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
} from 'react';
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  DialogStackModel,
  type DialogKind,
  type DialogPresentation,
} from '../../experience/dialogStackModel';
import { NotificationCenterModel } from '../../experience/notificationCenterModel';
import { createShortcutRuntime } from '../../experience/shortcutRuntime';
import './experience-ui.css';
import { useExperienceTheme } from './ExperienceDesignSystem';
import { ExperienceNotificationCenter } from './ExperienceNotificationCenter';
import { ExperienceOverlayStack } from './ExperienceOverlayStack';
import { LayerListWidget } from '../Widget/LayerList/LayerListWidget';

type ActionIconType =
  | 'sun'
  | 'moon'
  | 'keyboard'
  | 'search'
  | 'layers'
  | 'legend'
  | 'info';

interface ActionIconProps {
  readonly type: ActionIconType;
  readonly size?: number;
}

interface ExperienceUXLayerProps {
  readonly windowManager: Pick<WindowManagerApi, 'ShowWindow'>;
}

interface ExperienceCommandDetail {
  readonly name?: string;
}

interface LayerListHandle {
  readonly OnShow?: (mode?: 'layers' | 'legend') => void;
}

interface LayerListProps {
  readonly id: string;
  readonly windowManager: Pick<
    WindowManagerApi,
    'RegisterWindow' | 'ShowWindow' | 'UnregisterWindow'
  >;
}

const ManagedLayerListWidget = LayerListWidget as unknown as ForwardRefExoticComponent<
  LayerListProps & RefAttributes<LayerListHandle>
>;

const HELP_DIALOG_ID = 'experience-help';
const NOTIFICATION_DIALOG_ID = 'experience-notification-center';
const HELP_TRIGGER_ID = 'experience-utility-help';
const NOTIFICATION_TRIGGER_ID = 'experience-utility-notifications';

const reportUxRuntimeError = (
  error: unknown,
  source: string,
): void => {
  runtimeDiagnostics.captureError(
    error,
    { source },
    'warn',
  );
};

const ActionIcon = ({
  type,
  size = 18,
}: ActionIconProps): ReactNode => {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (type) {
    case 'sun':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
        </svg>
      );
    case 'moon':
      return <svg {...common}><path d="M20.5 15.6A8.5 8.5 0 0 1 8.4 3.5 8.5 8.5 0 1 0 20.5 15.6Z" /></svg>;
    case 'keyboard':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 9h1M11 9h1M15 9h1M7 13h5M15 13h2" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle cx="10.8" cy="10.8" r="6.6" />
          <path d="m16 16 4.2 4.2" />
        </svg>
      );
    case 'layers':
      return (
        <svg {...common}>
          <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
          <path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" />
        </svg>
      );
    case 'legend':
      return (
        <svg {...common}>
          <path d="M4 5h16M4 12h10M4 19h7" />
          <circle cx="18" cy="12" r="2" />
          <circle cx="15" cy="19" r="2" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 10v6M12 7h.01" />
        </svg>
      );
  }
};

export const dispatchExperienceCommand = (
  name: string,
  detail: Readonly<Record<string, unknown>> = {},
): void => {
  window.dispatchEvent(new CustomEvent('kentrehberi:command', {
    detail: { name, ...detail },
  }));
};

export function ExperienceUXLayer({
  windowManager,
}: ExperienceUXLayerProps): ReactNode {
  const { theme, toggleTheme } = useExperienceTheme();
  const [collapsed, setCollapsed] = useState(false);
  const layerListRef = useRef<LayerListHandle | null>(null);
  const dialogStack = useMemo(() => new DialogStackModel({
    onObserverError: error => reportUxRuntimeError(
      error,
      'experience.ux-layer.dialog-observer',
    ),
  }), []);
  const notifications = useMemo(() => new NotificationCenterModel({
    capacity: 48,
    onObserverError: error => reportUxRuntimeError(
      error,
      'experience.ux-layer.notification-observer',
    ),
  }), []);
  const backgroundRoots = useMemo<readonly HTMLElement[]>(() => {
    if (typeof document === 'undefined') return [];
    const applicationRoot = document.getElementById('root');
    return applicationRoot ? [applicationRoot] : [];
  }, []);

  const openSurface = useCallback((
    id: string,
    kind: DialogKind,
    label: string,
    restoreFocusTo: string,
  ): void => {
    if (dialogStack.snapshot().dialogs.some(dialog => dialog.id === id)) return;
    dialogStack.open({
      id,
      kind,
      label,
      restoreFocusTo,
    });
  }, [dialogStack]);

  const openHelp = useCallback((): void => {
    openSurface(HELP_DIALOG_ID, 'modal', 'Hızlı kullanım', HELP_TRIGGER_ID);
  }, [openSurface]);

  const openNotifications = useCallback((): void => {
    openSurface(
      NOTIFICATION_DIALOG_ID,
      'drawer',
      'Bildirim merkezi',
      NOTIFICATION_TRIGGER_ID,
    );
  }, [openSurface]);

  const toggleThemeWithFeedback = useCallback((): void => {
    toggleTheme();
    notifications.push({
      id: 'experience-theme-feedback',
      dedupeKey: 'experience-theme-feedback',
      title: theme === 'dark' ? 'Açık tema seçildi' : 'Koyu tema seçildi',
      message: 'Arayüz tercihiniz bu tarayıcı için güncellendi.',
      category: 'Görünüm',
      expiresAt: Date.now() + 7_000,
    });
  }, [notifications, theme, toggleTheme]);

  useEffect(() => {
    document.documentElement.dataset.experienceTheme = theme;
    try {
      window.localStorage.setItem('kent-rehberi-experience-theme', theme);
    } catch (error) {
      reportUxRuntimeError(error, 'experience.ux-layer.theme-persistence');
    }
  }, [theme]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forcedColors = window.matchMedia('(forced-colors: active)');
    const coarsePointer = window.matchMedia('(pointer: coarse)');
    const synchronize = (): void => dialogStack.setPreferences({
      reducedMotion: reducedMotion.matches,
      forcedColors: forcedColors.matches,
      coarsePointer: coarsePointer.matches,
    });

    synchronize();
    reducedMotion.addEventListener('change', synchronize);
    forcedColors.addEventListener('change', synchronize);
    coarsePointer.addEventListener('change', synchronize);
    return () => {
      reducedMotion.removeEventListener('change', synchronize);
      forcedColors.removeEventListener('change', synchronize);
      coarsePointer.removeEventListener('change', synchronize);
    };
  }, [dialogStack]);

  useEffect(() => {
    const onCommand = (event: Event): void => {
      const detail = (event as CustomEvent<ExperienceCommandDetail>).detail;
      const name = detail?.name;

      if (name === 'help') {
        openHelp();
        return;
      }

      if (name === 'notifications') {
        openNotifications();
        return;
      }

      if (name === 'layers' || name === 'legend') {
        layerListRef.current?.OnShow?.(name);
        return;
      }

      if (name === 'search') {
        windowManager.ShowWindow('genelarama-query-window');
      }
    };

    window.addEventListener('kentrehberi:command', onCommand);
    return () => window.removeEventListener('kentrehberi:command', onCommand);
  }, [openHelp, openNotifications, windowManager]);

  useEffect(() => {
    const shortcuts = createShortcutRuntime({
      document,
      onHandlerError(error, shortcut) {
        reportUxRuntimeError(
          error,
          `experience.ux-layer.shortcut.${shortcut.id}`,
        );
      },
      shortcuts: [
        {
          id: 'command-palette',
          key: 'k',
          ctrlOrMeta: true,
          allowInEditable: true,
          handler: () => dispatchExperienceCommand('command-palette'),
        },
        {
          id: 'help',
          key: '?',
          handler: openHelp,
        },
      ],
    });

    return () => shortcuts.dispose();
  }, [openHelp]);

  const themeLabel = useMemo(
    () => theme === 'dark' ? 'Açık temaya geç' : 'Koyu temaya geç',
    [theme],
  );

  const closeSurfaceAndDispatch = useCallback((
    dialogId: string,
    command: 'layers' | 'legend',
  ): void => {
    dialogStack.close(dialogId);
    dispatchExperienceCommand(command);
  }, [dialogStack]);

  const renderOverlayContent = useCallback((dialog: DialogPresentation): ReactNode => {
    if (dialog.id === NOTIFICATION_DIALOG_ID) {
      return (
        <ExperienceNotificationCenter
          model={notifications}
          mode="center"
          label="Bildirim merkezi"
        />
      );
    }

    if (dialog.id !== HELP_DIALOG_ID) return null;
    return (
      <div className="experience-help__stack-content">
        <p className="experience-help__intro">
          Harita ve veri araçlarına klavye ile hızlı erişin. Odak, Escape kapatma ve
          arka plan yalıtımı ortak erişilebilir overlay runtime tarafından yönetilir.
        </p>
        <div className="experience-help__grid">
          <div className="experience-shortcut">
            <span>Komut merkezi</span>
            <kbd>Ctrl</kbd><b>+</b><kbd>K</kbd>
          </div>
          <div className="experience-shortcut">
            <span>Yardım</span><kbd>?</kbd>
          </div>
          <div className="experience-shortcut">
            <span>Pencereyi kapat</span><kbd>Esc</kbd>
          </div>

          <button
            className="experience-shortcut experience-shortcut--action"
            type="button"
            onClick={() => closeSurfaceAndDispatch(dialog.id, 'layers')}
          >
            <span>Katmanlar</span><strong>Aç</strong>
          </button>

          <button
            className="experience-shortcut experience-shortcut--action"
            type="button"
            onClick={() => closeSurfaceAndDispatch(dialog.id, 'legend')}
          >
            <span>Lejand</span><strong>Aç</strong>
          </button>

          <button
            className="experience-shortcut experience-shortcut--action"
            type="button"
            onClick={toggleThemeWithFeedback}
          >
            <span>Tema</span>
            <strong>{theme === 'dark' ? 'Açık' : 'Koyu'}</strong>
          </button>
        </div>

        <footer className="experience-help__footer">
          <ActionIcon type="info" size={16} />
          <span>
            Mevcut GIS sorgu, katman ve popup işlevleri korunur; bu yüzey
            yalnızca keşif, erişilebilirlik ve hızlı erişim sağlar.
          </span>
        </footer>
      </div>
    );
  }, [closeSurfaceAndDispatch, notifications, theme, toggleThemeWithFeedback]);

  return (
    <>
      <aside
        className={`experience-utility ${collapsed ? 'is-collapsed' : ''}`}
        aria-label="Kent Rehberi yardımcı araçları"
      >
        <div className="experience-utility__brand">
          <span className="experience-utility__status" aria-hidden="true" />
          {!collapsed ? <span>Çalışma alanı</span> : null}
        </div>

        <nav className="experience-utility__actions" aria-label="Hızlı araçlar">
          <button
            className="experience-utility__button"
            type="button"
            onClick={() => dispatchExperienceCommand('search')}
            aria-label="Genel aramayı aç"
            title="Genel arama"
          >
            <ActionIcon type="search" />
            {!collapsed ? <span>Arama</span> : null}
          </button>

          <button
            className="experience-utility__button"
            type="button"
            onClick={() => dispatchExperienceCommand('layers')}
            aria-label="Katman yönetimini aç"
            title="Katmanlar"
          >
            <ActionIcon type="layers" />
            {!collapsed ? <span>Katmanlar</span> : null}
          </button>

          <button
            className="experience-utility__button"
            type="button"
            onClick={() => dispatchExperienceCommand('legend')}
            aria-label="Lejandı aç"
            title="Lejand"
          >
            <ActionIcon type="legend" />
            {!collapsed ? <span>Lejand</span> : null}
          </button>

          <button
            id={NOTIFICATION_TRIGGER_ID}
            className="experience-utility__button"
            type="button"
            onClick={openNotifications}
            aria-label="Bildirim merkezini aç"
            title="Bildirimler"
          >
            <ActionIcon type="info" />
            {!collapsed ? <span>Bildirimler</span> : null}
          </button>

          <button
            id={HELP_TRIGGER_ID}
            className="experience-utility__button"
            type="button"
            onClick={openHelp}
            aria-label="Kısayolları ve yardım bilgisini aç"
            title="Kısayollar"
          >
            <ActionIcon type="keyboard" />
            {!collapsed ? <span>Kısayollar</span> : null}
          </button>

          <button
            className="experience-utility__button"
            type="button"
            onClick={toggleThemeWithFeedback}
            aria-label={themeLabel}
            title={themeLabel}
          >
            <ActionIcon type={theme === 'dark' ? 'sun' : 'moon'} />
            {!collapsed ? (
              <span>{theme === 'dark' ? 'Açık tema' : 'Koyu tema'}</span>
            ) : null}
          </button>
        </nav>

        <button
          className="experience-utility__collapse"
          type="button"
          onClick={() => setCollapsed(value => !value)}
          aria-expanded={!collapsed}
          aria-label={
            collapsed
              ? 'Yardımcı araçları genişlet'
              : 'Yardımcı araçları daralt'
          }
          title={collapsed ? 'Genişlet' : 'Daralt'}
        >
          <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
        </button>
      </aside>

      <ManagedLayerListWidget
        id="layerlist-widget"
        windowManager={windowManager as LayerListProps['windowManager']}
        ref={layerListRef}
      />

      <ExperienceNotificationCenter
        model={notifications}
        mode="toasts"
        label="Anlık bildirimler"
      />

      <ExperienceOverlayStack
        model={dialogStack}
        backgroundRoots={backgroundRoots}
        renderContent={renderOverlayContent}
        closeLabel="Kapat"
        onObserverError={error => reportUxRuntimeError(
          error,
          'experience.ux-layer.overlay-runtime',
        )}
      />
    </>
  );
}

export default ExperienceUXLayer;
