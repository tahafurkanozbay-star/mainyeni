import {
  useEffect,
  useRef,
  type AriaRole,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  FOCUSABLE_SELECTOR,
  createFocusTrap,
  getFocusableElements,
} from '../../experience/accessibilityRuntime';

export type ExperienceDialogCloseReason = 'escape' | 'backdrop' | 'button' | 'done' | 'programmatic';

export interface ExperienceDialogProps {
  readonly open: boolean;
  readonly onClose?: (reason: ExperienceDialogCloseReason) => void;
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly backdropClassName?: string;
  readonly dialogClassName?: string;
  readonly children: ReactNode;
  readonly closeOnBackdrop?: boolean;
  readonly restoreFocus?: boolean;
  readonly role?: AriaRole;
  readonly testId?: string;
}

let bodyLockCount = 0;
let bodyOverflowBeforeLock = '';

const lockBodyScroll = (): (() => void) => {
  if (typeof document === 'undefined') return () => undefined;

  if (bodyLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  bodyLockCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    bodyLockCount = Math.max(0, bodyLockCount - 1);
    if (bodyLockCount === 0) {
      document.body.style.overflow = bodyOverflowBeforeLock;
      bodyOverflowBeforeLock = '';
    }
  };
};

export const ExperienceDialog = ({
  open,
  onClose,
  labelledBy,
  describedBy,
  initialFocusRef,
  backdropClassName = '',
  dialogClassName = '',
  children,
  closeOnBackdrop = true,
  restoreFocus = true,
  role = 'dialog',
  testId,
}: ExperienceDialogProps): ReactNode => {
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const container = dialogRef.current;
    if (!container) return undefined;

    const releaseScrollLock = lockBodyScroll();
    const trap = createFocusTrap(container, {
      initialFocus: initialFocusRef?.current ?? null,
      closeOnEscape: true,
      onEscape: () => onClose?.('escape'),
    });
    trap.activate();

    return () => {
      trap.deactivate({ restore: restoreFocus });
      releaseScrollLock();
    };
  }, [initialFocusRef, onClose, open, restoreFocus]);

  if (!open) return null;

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (!closeOnBackdrop || event.target !== event.currentTarget) return;
    onClose?.('backdrop');
  };

  return (
    <div
      className={backdropClassName}
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
      data-experience-dialog-backdrop="true"
    >
      <section
        ref={dialogRef}
        className={dialogClassName}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        data-experience-dialog="true"
        data-testid={testId}
      >
        {children}
      </section>
    </div>
  );
};

export const experienceDialogInternals = Object.freeze({
  FOCUSABLE_SELECTOR,
  getFocusableElements,
});

export default ExperienceDialog;
