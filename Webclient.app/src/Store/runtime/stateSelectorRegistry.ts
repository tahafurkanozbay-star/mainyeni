import type { RootState } from '../contracts';

export interface StoreSelectorRegistryEntry {
  readonly name: string;
  readonly description: string | null;
}

type RegisteredSelector = {
  readonly name: string;
  readonly description: string | null;
  readonly selector: (state: RootState) => unknown;
};

const normalizeName = (value: string): string => {
  const name = String(value ?? '').trim();
  if (!name) throw Object.assign(new Error('Store selector name is required.'), {
    code: 'STORE_SELECTOR_NAME_REQUIRED',
  });
  if (name.length > 120) throw Object.assign(new Error('Store selector name exceeds the length limit.'), {
    code: 'STORE_SELECTOR_NAME_TOO_LONG',
  });
  return name;
};

export class StoreSelectorRegistry {
  readonly #capacity: number;
  #selectors = new Map<string, RegisteredSelector>();

  constructor(capacity = 128) {
    const numeric = Number(capacity);
    this.#capacity = Number.isFinite(numeric)
      ? Math.min(10_000, Math.max(1, Math.trunc(numeric)))
      : 128;
  }

  get size(): number {
    return this.#selectors.size;
  }

  register<TSelected>(
    nameInput: string,
    selector: (state: RootState) => TSelected,
    description?: string,
  ): () => void {
    const name = normalizeName(nameInput);
    if (typeof selector !== 'function') throw new TypeError('Store selector must be callable.');
    if (this.#selectors.has(name)) {
      throw Object.assign(new Error('Store selector name is already registered.'), {
        code: 'STORE_SELECTOR_DUPLICATE',
      });
    }
    if (this.#selectors.size >= this.#capacity) {
      throw Object.assign(new Error('Store selector registry capacity exceeded.'), {
        code: 'STORE_SELECTOR_REGISTRY_LIMIT',
      });
    }

    const entry: RegisteredSelector = Object.freeze({
      name,
      description: description ? String(description).trim().slice(0, 240) || null : null,
      selector: selector as (state: RootState) => unknown,
    });
    this.#selectors.set(name, entry);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#selectors.delete(name);
    };
  }

  select<TSelected = unknown>(nameInput: string, state: RootState): TSelected {
    const name = normalizeName(nameInput);
    const entry = this.#selectors.get(name);
    if (!entry) {
      throw Object.assign(new Error('Store selector is not registered.'), {
        code: 'STORE_SELECTOR_NOT_FOUND',
      });
    }
    return entry.selector(state) as TSelected;
  }

  list(): readonly StoreSelectorRegistryEntry[] {
    return Object.freeze(
      [...this.#selectors.values()]
        .map((entry) => Object.freeze({
          name: entry.name,
          description: entry.description,
        }))
        .sort((left, right) => left.name.localeCompare(right.name, 'en')),
    );
  }

  clear(): number {
    const count = this.#selectors.size;
    this.#selectors.clear();
    return count;
  }
}

export const createStoreSelectorRegistry = (
  capacity = 128,
): StoreSelectorRegistry => new StoreSelectorRegistry(capacity);
