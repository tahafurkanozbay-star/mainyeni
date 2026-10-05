import { useEffect, type ReactNode } from 'react';
import { resolveNotificationCommandIntent } from '../../experience/notificationCommandExperience';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';

interface ExperienceNotificationShortcutBridgeProps {
  readonly onOpen?: () => void;
}

const EMPTY_SNAPSHOT = Object.freeze({
  scope: 'all' as const,
  itemIds: Object.freeze([] as string[]),
  activeId: null,
  activeIndex: -1,
  count: 0,
  unreadCount: 0,
  importantCount: 0,
  canMarkActiveRead: false,
  canMarkAllRead: false,
  canClearRead: false,
  canDismissActive: false,
  summary: 'Bildirim yok.',
});

export const ExperienceNotificationShortcutBridge = ({
  onOpen,
}: ExperienceNotificationShortcutBridgeProps): ReactNode => {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement
        ? {
          tagName: event.target.tagName,
          isContentEditable: event.target.isContentEditable,
          role: event.target.getAttribute('role'),
        }
        : null;
      const intent = resolveNotificationCommandIntent({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        target,
      }, EMPTY_SNAPSHOT);
      if (intent.type !== 'open-center') return;
      event.preventDefault();
      try {
        if (onOpen) {
          onOpen();
          return;
        }
        window.dispatchEvent(new CustomEvent('kentrehberi:command', {
          detail: { name: 'notifications', source: 'keyboard' },
        }));
      } catch (error) {
        runtimeDiagnostics.captureError(error, {
          source: 'experience.notification-shortcut',
        }, 'warn');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onOpen]);

  return null;
};

export default ExperienceNotificationShortcutBridge;
