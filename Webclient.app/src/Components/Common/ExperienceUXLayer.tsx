import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  DialogStackModel,
  type DialogKind,
  type DialogPresentation,
} from '../../experience/dialogStackModel';
import type { NotificationCenterModel } from '../../experience/notificationCenterModel';
import './experience-ui.css';
import './experience-ux-layer-modern.css';
import { useExperienceTheme } from './ExperienceDesignSystem';
import { ExperienceNotificationCenter } from './ExperienceNotificationCenter';
import { ExperienceOverlayStack } from './ExperienceOverlayStack';

type ActionIconType =
  | 'sun'
  | 'moon'
  | 'search'
  | 'info';

interface ActionIconProps {
  readonly type: ActionIconType;
  readonly size?: number;
}

interface ExperienceUXLayerProps {
  readonly windowManager: Pick<WindowManagerApi, 'ShowWindow'>;
  readonly notificationModel: NotificationCenterModel;
}

interface ExperienceCommandDetail {
  readonly name?: string;
}

const HELP_DIALOG_ID = 'experience-help';
const NOTIFICATION_DIALOG_ID = 'experience-notification-center';
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
    case 'search':
      return (
        <svg {...common}>
          <circle cx="10.8" cy="10.8" r="6.6" />
          <path d="m16 16 4.2 4.2" />
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
  notificationModel,
}: ExperienceUXLayerProps): ReactNode {
  const { theme, toggleTheme } = useExperienceTheme();
  const [collapsed, setCollapsed] = useState(false);
  const dialogStack = useMemo(() => new DialogStackModel({
    onObserverError: error => reportUxRuntimeError(
      error,
      'experience.ux-layer.dialog-observer',
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
    openSurface(HELP_DIALOG_ID, 'modal', 'Hızlı kullanım', 'experience-utility');
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
    notificationModel.push({
      id: 'experience-theme-feedback',
      dedupeKey: 'experience-theme-feedback',
      title: theme === 'dark' ? 'Açık tema seçildi' : 'Koyu tema seçildi',
      message: 'Arayüz tercihiniz bu tarayıcı için güncellendi.',
      category: 'Görünüm',
      expiresAt: Date.now() + 7_000,
    });
  }, [notificationModel, theme, toggleTheme]);

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

      if (name === 'search') {
        windowManager.ShowWindow('genelarama-query-window');
      }
    };

    window.addEventListener('kentrehberi:command', onCommand);
    return () => window.removeEventListener('kentrehberi:command', onCommand);
  }, [openHelp, openNotifications, windowManager]);

  const themeLabel = useMemo(
    () => theme === 'dark' ? 'Açık temaya geç' : 'Koyu temaya geç',
    [theme],
  );

  const renderOverlayContent = useCallback((dialog: DialogPresentation): ReactNode => {
    if (dialog.id === NOTIFICATION_DIALOG_ID) {
      return (
        <ExperienceNotificationCenter
          model={notificationModel}
          mode="center"
          label="Bildirim merkezi"
        />
      );
    }

    if (dialog.id !== HELP_DIALOG_ID) return null;
    return (
      <div className="experience-help__stack-content">
        <p className="experience-help__intro">
          Kent Rehberi hizmetlerini soldaki kurum kategorilerinden seçin. Kayıtları üst arama alanından bulun.
          Kent Rehberi kayıtları doğrudan resmi PlanASKI hizmetinden alınır.
        </p>
        <div className="experience-help__grid">
          <button
            className="experience-shortcut experience-shortcut--action"
            type="button"
            onClick={() => {
              dialogStack.close(dialog.id);
              windowManager.ShowWindow('genelarama-query-window');
            }}
          >
            <span>Genel arama</span><strong>Aç</strong>
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
            Bu sürüm eski API üzerinden gelen katman kataloğu ve lejand özelliklerini kullanmaz.
          </span>
        </footer>
      </div>
    );
  }, [dialogStack, notificationModel, theme, toggleThemeWithFeedback, windowManager]);

  return (
    <>
      <aside
        id="experience-utility"
        className={`experience-utility ${collapsed ? 'is-collapsed' : ''}`}
        aria-label="Kent Rehberi yardımcı araçları"
        tabIndex={-1}
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

      <ExperienceNotificationCenter
        model={notificationModel}
        mode="toasts"
        label="Anlık bildirimler"
        returnFocusId={NOTIFICATION_TRIGGER_ID}
        onOpenCenter={openNotifications}
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
