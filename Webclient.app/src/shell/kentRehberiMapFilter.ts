export interface KentRehberiMapFilterInput {
  readonly label: string;
  readonly iconKeys: readonly string[];
}

export interface KentRehberiMapFilterSnapshot {
  readonly revision: number;
  readonly label: string | null;
  /** null means show every record; an empty array means intentionally show none. */
  readonly iconKeys: readonly string[] | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();

let snapshot: KentRehberiMapFilterSnapshot = Object.freeze({
  revision: 0,
  label: null,
  iconKeys: null,
});

const normalizeIconKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return /^[a-zA-Z0-9_-]{1,80}$/u.test(key) ? key : null;
};

export const getKentRehberiMapFilterSnapshot = (): KentRehberiMapFilterSnapshot => snapshot;

export const subscribeKentRehberiMapFilter = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Update map visibility independently of whether the sidebar is expanded or collapsed. */
export const setKentRehberiMapFilter = (filter: KentRehberiMapFilterInput | null): void => {
  const label = filter === null ? null : filter.label.trim().slice(0, 120) || 'Seçili kategori';
  const iconKeys = filter === null
    ? null
    : Object.freeze([...new Set(filter.iconKeys.map(normalizeIconKey).filter((key): key is string => key !== null))]);

  const sameKeys = snapshot.iconKeys === null
    ? iconKeys === null
    : iconKeys !== null
      && snapshot.iconKeys.length === iconKeys.length
      && snapshot.iconKeys.every((key, index) => key === iconKeys[index]);

  if (snapshot.label === label && sameKeys) return;

  snapshot = Object.freeze({
    revision: snapshot.revision + 1,
    label,
    iconKeys,
  });

  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One subscriber must not prevent the remaining map-filter subscribers from updating.
    }
  }
};

/** Produce a safe ArcGIS SQL expression from the validated, local icon registry keys. */
export const buildKentRehberiDefinitionExpression = (
  filter: KentRehberiMapFilterSnapshot,
): string | null => {
  if (filter.iconKeys === null) return null;
  if (filter.iconKeys.length === 0) return '1 = 2';
  return `iconKey IN (${filter.iconKeys.map((key) => `'${key}'`).join(', ')})`;
};
