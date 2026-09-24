import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DialogStackModel,
  type DialogPresentation,
  type DialogStackSnapshot,
} from '../../experience/dialogStackModel';
import {
  createDialogFocusRuntime,
  type DialogFocusRuntime,
} from '../../experience/dialogFocusRuntime';
import './experience-overlay-stack.css';

export interface ExperienceOverlayStackProps {
  readonly model: DialogStackModel;
  readonly renderContent: (dialog: DialogPresentation) => ReactNode;
  readonly backgroundRoots?: readonly HTMLElement[];
  readonly portalTarget?: Element | DocumentFragment | null;
  readonly onClose?: (dialogId: string, restoreFocusTo: string | null) => void;
  readonly onObserverError?: (error: unknown) => void;
  readonly closeLabel?: string;
}

const initialSnapshot = (model: DialogStackModel): DialogStackSnapshot => model.snapshot();

const kindRole = (kind: DialogPresentation['kind']): 'dialog' | 'menu' =>
  kind === 'popover' ? 'menu' : 'dialog';

const dialogClassName = (dialog: DialogPresentation): string => [
  'experience-overlay-surface',
  `experience-overlay-surface--${dialog.kind}`,
  dialog.active ? 'is-active' : 'is-background',
].join(' ');

const backdropDismissible = (dialog: DialogPresentation): boolean =>
  dialog.active && dialog.modal && dialog.dismissible;

export const ExperienceOverlayStack = ({
  model,
  renderContent,
  backgroundRoots = [],
  portalTarget,
  onClose,
  onObserverError,
  closeLabel = 'Kapat',
}: ExperienceOverlayStackProps): ReactNode => {
  const [snapshot, setSnapshot] = useState<DialogStackSnapshot>(() => initialSnapshot(model));
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<DialogFocusRuntime | null>(null);
  const resolvedPortal = useMemo<Element | DocumentFragment | null>(() => {
    if (portalTarget !== undefined) return portalTarget;
    if (backgroundRoots.length === 0) return null;
    return typeof document === 'undefined' ? null : document.body;
  }, [backgroundRoots, portalTarget]);

  useEffect(() => model.subscribe(setSnapshot), [model]);

  useEffect(() => {
    const root = overlayRef.current;
    if (!root || typeof document === 'undefined') return undefined;
    const runtime = createDialogFocusRuntime({
      document,
      overlayRoot: root,
      backgroundRoots,
      onDismissRequest: () => {
        const activeId = model.snapshot().activeId;
        if (!activeId) return;
        const restoreFocusTo = model.dismissActive();
        onClose?.(activeId, restoreFocusTo);
      },
      ...(onObserverError ? { onObserverError } : {}),
    });
    runtimeRef.current = runtime;
    runtime.apply(model.snapshot());
    return () => {
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [backgroundRoots, model, onClose, onObserverError]);

  useEffect(() => {
    runtimeRef.current?.apply(snapshot);
  }, [snapshot]);

  const close = (dialog: DialogPresentation): void => {
    if (!dialog.dismissible) return;
    const restoreFocusTo = model.close(dialog.id);
    onClose?.(dialog.id, restoreFocusTo);
  };

  const onBackdropClick = (dialog: DialogPresentation, event: MouseEvent<HTMLDivElement>): void => {
    if (!backdropDismissible(dialog) || event.target !== event.currentTarget) return;
    close(dialog);
  };

  const stack = (
    <div
      ref={overlayRef}
      className="experience-overlay-stack"
      data-experience-overlay-count={snapshot.dialogs.length}
      data-experience-reduced-motion={String(snapshot.reducedMotion)}
      data-experience-forced-colors={String(snapshot.forcedColors)}
      data-experience-coarse-pointer={String(snapshot.coarsePointer)}
      aria-live="off"
    >
      {snapshot.dialogs.map((dialog) => {
        const labelledBy = `experience-overlay-title-${dialog.id}`;
        const bodyId = `experience-overlay-body-${dialog.id}`;
        return (
          <div
            key={dialog.id}
            className={`experience-overlay-layer experience-overlay-layer--${dialog.kind}`}
            data-experience-dialog-id={dialog.id}
            data-experience-active={String(dialog.active)}
            data-experience-trap-focus={String(dialog.trapFocus)}
            aria-hidden={dialog.ariaHidden}
            onMouseDown={(event) => onBackdropClick(dialog, event)}
          >
            <section
              className={dialogClassName(dialog)}
              role={kindRole(dialog.kind)}
              aria-modal={dialog.modal ? true : undefined}
              aria-labelledby={labelledBy}
              aria-describedby={bodyId}
              tabIndex={-1}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="experience-overlay-surface__header">
                <h2 id={labelledBy} className="experience-overlay-surface__title">
                  {dialog.label}
                </h2>
                {dialog.dismissible ? (
                  <button
                    type="button"
                    className="experience-overlay-surface__close"
                    aria-label={`${dialog.label}: ${closeLabel}`}
                    onClick={() => close(dialog)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                ) : null}
              </header>
              <div id={bodyId} className="experience-overlay-surface__body">
                {renderContent(dialog)}
              </div>
            </section>
          </div>
        );
      })}
    </div>
  );

  return resolvedPortal ? createPortal(stack, resolvedPortal) : stack;
};

export default ExperienceOverlayStack;