export type InteractionModality = 'keyboard' | 'pointer' | 'touch' | 'programmatic';

export interface InteractionModalitySnapshot {
  readonly revision: number;
  readonly modality: InteractionModality;
  readonly focusVisible: boolean;
  readonly coarsePointer: boolean;
  readonly targetSize: number;
  readonly hoverCapable: boolean;
}

export interface InteractionModalityOptions {
  readonly coarsePointer?: boolean;
  readonly hoverCapable?: boolean;
  readonly initialModality?: InteractionModality;
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = (snapshot: InteractionModalitySnapshot) => void;

export class InteractionModalityModel {
  readonly #listeners = new Set<Listener>();
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #coarsePointer: boolean;
  readonly #hoverCapable: boolean;
  #modality: InteractionModality;
  #revision = 0;
  #snapshot: InteractionModalitySnapshot;

  constructor(options: InteractionModalityOptions = {}) {
    this.#coarsePointer = options.coarsePointer ?? false;
    this.#hoverCapable = options.hoverCapable ?? !this.#coarsePointer;
    this.#modality = options.initialModality ?? 'programmatic';
    this.#onObserverError = options.onObserverError;
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): InteractionModalitySnapshot { return this.#snapshot; }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    this.#notifyOne(listener);
    return () => this.#listeners.delete(listener);
  }

  keyboard(): void { this.#set('keyboard'); }
  pointer(): void { this.#set(this.#coarsePointer ? 'touch' : 'pointer'); }
  touch(): void { this.#set('touch'); }
  programmatic(): void { this.#set('programmatic'); }

  handleKey(key: string): void {
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return;
    this.keyboard();
  }

  #set(modality: InteractionModality): void {
    if (modality === this.#modality) return;
    this.#modality = modality;
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) this.#notifyOne(listener);
  }

  #buildSnapshot(): InteractionModalitySnapshot {
    return Object.freeze({
      revision: this.#revision,
      modality: this.#modality,
      focusVisible: this.#modality === 'keyboard',
      coarsePointer: this.#coarsePointer,
      targetSize: this.#coarsePointer ? 48 : 40,
      hoverCapable: this.#hoverCapable,
    });
  }

  #notifyOne(listener: Listener): void {
    try { listener(this.#snapshot); } catch (error) { this.#reportObserverError(error); }
  }

  #reportObserverError(error: unknown): void {
    if (!this.#onObserverError) return;
    try { this.#onObserverError(error); } catch (reportingError) { void reportingError; }
  }
}
