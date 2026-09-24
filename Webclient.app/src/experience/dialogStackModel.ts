export type DialogKind = 'modal' | 'drawer' | 'popover';

export interface DialogDescriptor {
  readonly id: string;
  readonly kind: DialogKind;
  readonly label: string;
  readonly dismissible?: boolean;
  readonly restoreFocusTo?: string;
}

export interface DialogPresentation {
  readonly id: string;
  readonly kind: DialogKind;
  readonly label: string;
  readonly depth: number;
  readonly active: boolean;
  readonly modal: boolean;
  readonly trapFocus: boolean;
  readonly ariaHidden: boolean;
  readonly inertBackground: boolean;
  readonly dismissible: boolean;
  readonly restoreFocusTo?: string;
}

export interface DialogStackSnapshot {
  readonly dialogs: readonly DialogPresentation[];
  readonly activeId: string | null;
  readonly pageInert: boolean;
  readonly escapeDismisses: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly coarsePointer: boolean;
  readonly minimumTargetPx: 44 | 48;
}

type Observer = (snapshot: DialogStackSnapshot) => void;
type ErrorReporter = (error: unknown) => void;

const normalizeId = (value: string): string => value.trim();

export class DialogStackModel {
  readonly #stack: DialogDescriptor[] = [];
  readonly #observers = new Set<Observer>();
  readonly #onObserverError: ErrorReporter | undefined;
  #reducedMotion = false;
  #forcedColors = false;
  #coarsePointer = false;

  constructor(options: { onObserverError?: ErrorReporter } = {}) {
    this.#onObserverError = options.onObserverError;
  }

  open(dialog: DialogDescriptor): void {
    const id = normalizeId(dialog.id);
    if (!id) throw new Error('Dialog id is required.');
    if (!dialog.label.trim()) throw new Error('Dialog label is required.');
    if (this.#stack.some((item) => item.id === id)) {
      throw new Error(`Dialog "${id}" is already open.`);
    }
    this.#stack.push({ ...dialog, id, label: dialog.label.trim() });
    this.#notify();
  }

  close(id: string): string | null {
    const index = this.#stack.findIndex((dialog) => dialog.id === id);
    if (index < 0) return null;
    const [closed] = this.#stack.splice(index, 1);
    this.#notify();
    return closed?.restoreFocusTo ?? null;
  }

  dismissActive(): string | null {
    const active = this.#stack.at(-1);
    if (!active || active.dismissible === false) return null;
    return this.close(active.id);
  }

  setPreferences(preferences: {
    reducedMotion?: boolean;
    forcedColors?: boolean;
    coarsePointer?: boolean;
  }): void {
    if (preferences.reducedMotion !== undefined) this.#reducedMotion = preferences.reducedMotion;
    if (preferences.forcedColors !== undefined) this.#forcedColors = preferences.forcedColors;
    if (preferences.coarsePointer !== undefined) this.#coarsePointer = preferences.coarsePointer;
    this.#notify();
  }

  snapshot(): DialogStackSnapshot {
    const activeId = this.#stack.at(-1)?.id ?? null;
    const pageInert = this.#stack.some((dialog) => dialog.kind === 'modal' || dialog.kind === 'drawer');
    const dialogs = this.#stack.map<DialogPresentation>((dialog, index) => {
      const active = dialog.id === activeId;
      const modal = dialog.kind === 'modal' || dialog.kind === 'drawer';
      return {
        id: dialog.id,
        kind: dialog.kind,
        label: dialog.label,
        depth: index,
        active,
        modal,
        trapFocus: active && modal,
        ariaHidden: !active,
        inertBackground: active && modal,
        dismissible: dialog.dismissible !== false,
        ...(dialog.restoreFocusTo ? { restoreFocusTo: dialog.restoreFocusTo } : {}),
      };
    });
    const active = this.#stack.at(-1);
    return Object.freeze({
      dialogs: Object.freeze(dialogs),
      activeId,
      pageInert,
      escapeDismisses: Boolean(active && active.dismissible !== false),
      reducedMotion: this.#reducedMotion,
      forcedColors: this.#forcedColors,
      coarsePointer: this.#coarsePointer,
      minimumTargetPx: this.#coarsePointer ? 48 : 44,
    });
  }

  subscribe(observer: Observer): () => void {
    this.#observers.add(observer);
    this.#deliver(observer, this.snapshot());
    return () => this.#observers.delete(observer);
  }

  #notify(): void {
    const snapshot = this.snapshot();
    for (const observer of this.#observers) this.#deliver(observer, snapshot);
  }

  #deliver(observer: Observer, snapshot: DialogStackSnapshot): void {
    try {
      observer(snapshot);
    } catch (error) {
      this.#reportObserverError(error);
    }
  }

  #reportObserverError(error: unknown): void {
    const reporter = this.#onObserverError;
    if (!reporter) return;
    try {
      reporter(error);
    } catch (reportingError) {
      // The observer reporter is diagnostic-only. Explicitly consume its failure
      // so diagnostics can never replace the user's already-completed interaction.
      void reportingError;
    }
  }
}
