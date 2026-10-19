import React, {
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  DialogStackModel,
  type DialogKind,
  type DialogPresentation,
} from '../../experience/dialogStackModel';
import type { NotificationCenterModel } from '../../experience/notificationCenterModel';
import './experience-ui.css';
import './experience-ux-layer-modern.css';
import { ExperienceNotificationCenter } from './ExperienceNotificationCenter';
import { ExperienceOverlayStack } from './ExperienceOverlayStack';

interface ExperienceUXLayerProps {
  readonly notificationModel: NotificationCenterModel;
}

interface ExperienceCommandDetail {
  readonly name?: string;
}

const HELP_DIALOG_ID = 'experience-help';
const NOTIFICATION_DIALOG_ID = 'experience-notification-center';
const SEARCH_INPUT_ID = 'kentrehberi-global-search';

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

const InfoIcon = ({ size = 16 }: { readonly size?: number }): ReactNode => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 10v6M12 7h.01" />
  </svg>
);

export const dispatchExperienceCommand = (
  name: string,
  detail: Readonly<Record<string, unknown>> = {},
): void => {
  window.dispatchEvent(new CustomEvent('kentrehberi:command', {
    detail: { name, ...detail },
  }));
};

export function ExperienceUXLayer({
  notificationModel,
}: ExperienceUXLayerProps): ReactNode {
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
    openSurface(HELP_DIALOG_ID, 'modal', 'Hızlı kullanım', SEARCH_INPUT_ID);
  }, [openSurface]);

  const openNotifications = useCallback((): void => {
    openSurface(
      NOTIFICATION_DIALOG_ID,
      'drawer',
      'Bildirim merkezi',
      SEARCH_INPUT_ID,
    );
  }, [openSurface]);

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
        document.getElementById(SEARCH_INPUT_ID)?.focus();
      }
    };

    window.addEventListener('kentrehberi:command', onCommand);
    return () => window.removeEventListener('kentrehberi:command', onCommand);
  }, [openHelp, openNotifications]);

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
          Adres, cadde, mahalle veya yer adını üstteki arama alanına yazın. Harita kayıtları doğrudan resmi PlanASKI hizmetinden alınır.
        </p>
        <div className="experience-help__grid">
          <button
            className="experience-shortcut experience-shortcut--action"
            type="button"
            onClick={() => {
              dialogStack.close(dialog.id);
              document.getElementById(SEARCH_INPUT_ID)?.focus();
            }}
          >
            <span>Adres veya yer ara</span><strong>Aç</strong>
          </button>
        </div>
        <footer className="experience-help__footer">
          <InfoIcon />
          <span>
            Gösterilen veriler bilgilendirme amaçlıdır. Haritadaki kayıtlar resmi işlem belgesi değildir.
          </span>
        </footer>
      </div>
    );
  }, [dialogStack, notificationModel]);

  return (
    <>
      <ExperienceNotificationCenter
        model={notificationModel}
        mode="toasts"
        label="Anlık bildirimler"
        returnFocusId={SEARCH_INPUT_ID}
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
