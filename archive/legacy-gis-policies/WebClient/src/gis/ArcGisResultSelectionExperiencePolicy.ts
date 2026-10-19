export type ResultSelectionScope = 'visible' | 'page' | 'loaded';
export type ResultSelectionCommand = 'select' | 'deselect' | 'toggle' | 'invert' | 'clear';
export type ResultSelectionCoverage = 'none' | 'partial' | 'all';

export interface ResultSelectionInput {
  readonly resultIds?: readonly string[];
  readonly visibleIds?: readonly string[];
  readonly pageIds?: readonly string[];
  readonly selectedIds?: readonly string[];
  readonly focusedId?: string | null;
  readonly anchorId?: string | null;
  readonly maxSelection?: number;
}

export interface ResultSelectionSnapshot {
  readonly resultIds: readonly string[];
  readonly visibleIds: readonly string[];
  readonly pageIds: readonly string[];
  readonly selectedIds: readonly string[];
  readonly selectedCount: number;
  readonly focusedId: string | null;
  readonly anchorId: string | null;
  readonly maxSelection: number;
  readonly capacityRemaining: number;
  readonly visibleCoverage: ResultSelectionCoverage;
  readonly pageCoverage: ResultSelectionCoverage;
  readonly loadedCoverage: ResultSelectionCoverage;
}

export interface ResultSelectionTransition {
  readonly next: ResultSelectionSnapshot;
  readonly changedCount: number;
  readonly selectedCount: number;
  readonly truncated: boolean;
  readonly focusTarget: string | null;
  readonly announcement: string;
}

export interface ResultSelectionReconcileResult {
  readonly next: ResultSelectionSnapshot;
  readonly removedSelectionCount: number;
  readonly focusChanged: boolean;
  readonly anchorChanged: boolean;
  readonly announcement: string;
}

const DEFAULT_MAX_SELECTION = 1_000;
const MAX_SELECTION_LIMIT = 5_000;
const MAX_RESULTS = 20_000;
const MAX_ID_LENGTH = 120;

const sanitizeId = (value: unknown): string => {
  const input = String(value ?? '');
  let cleaned = '';
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) continue;
    cleaned += character;
    if (cleaned.length >= MAX_ID_LENGTH) break;
  }
  return cleaned.trim();
};

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value ?? fallback)));
};

const normalizeUniqueIds = (values: readonly string[] | undefined, limit = MAX_RESULTS): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values ?? []) {
    if (result.length >= limit) break;
    const id = sanitizeId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return Object.freeze(result);
};

const retainKnownIds = (
  values: readonly string[] | undefined,
  known: ReadonlySet<string>,
  limit: number,
): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values ?? []) {
    if (result.length >= limit) break;
    const id = sanitizeId(raw);
    if (!id || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return Object.freeze(result);
};

const coverageFor = (scopeIds: readonly string[], selected: ReadonlySet<string>): ResultSelectionCoverage => {
  if (scopeIds.length === 0) return 'none';
  let selectedCount = 0;
  for (const id of scopeIds) {
    if (selected.has(id)) selectedCount += 1;
  }
  if (selectedCount === 0) return 'none';
  return selectedCount === scopeIds.length ? 'all' : 'partial';
};

export const normalizeResultSelectionSnapshot = (input: ResultSelectionInput): ResultSelectionSnapshot => {
  const resultIds = normalizeUniqueIds(input.resultIds);
  const known = new Set(resultIds);
  const maxSelection = clampInteger(input.maxSelection, DEFAULT_MAX_SELECTION, 1, MAX_SELECTION_LIMIT);
  const visibleIds = retainKnownIds(input.visibleIds, known, MAX_RESULTS);
  const pageIds = retainKnownIds(input.pageIds, known, MAX_RESULTS);
  const selectedIds = retainKnownIds(input.selectedIds, known, maxSelection);
  const selected = new Set(selectedIds);
  const focusedCandidate = sanitizeId(input.focusedId);
  const anchorCandidate = sanitizeId(input.anchorId);

  return Object.freeze({
    resultIds,
    visibleIds,
    pageIds,
    selectedIds,
    selectedCount: selectedIds.length,
    focusedId: known.has(focusedCandidate) ? focusedCandidate : null,
    anchorId: known.has(anchorCandidate) ? anchorCandidate : null,
    maxSelection,
    capacityRemaining: Math.max(0, maxSelection - selectedIds.length),
    visibleCoverage: coverageFor(visibleIds, selected),
    pageCoverage: coverageFor(pageIds, selected),
    loadedCoverage: coverageFor(resultIds, selected),
  });
};

export const resolveResultSelectionScope = (
  snapshot: ResultSelectionSnapshot,
  scope: ResultSelectionScope,
): readonly string[] => {
  switch (scope) {
    case 'visible': return snapshot.visibleIds;
    case 'page': return snapshot.pageIds;
    case 'loaded': return snapshot.resultIds;
  }
};

const selectionAnnouncement = (
  command: ResultSelectionCommand,
  scope: ResultSelectionScope,
  changedCount: number,
  selectedCount: number,
  truncated: boolean,
): string => {
  if (command === 'clear') return changedCount > 0 ? 'Tüm sonuç seçimleri temizlendi.' : 'Temizlenecek sonuç seçimi yok.';
  if (changedCount === 0) {
    return command === 'select'
      ? 'Bu kapsamda seçilecek yeni sonuç yok.'
      : command === 'deselect'
        ? 'Bu kapsamda kaldırılacak seçim yok.'
        : 'Bu kapsamda seçim değişmedi.';
  }
  const scopeLabel = scope === 'visible' ? 'görünür' : scope === 'page' ? 'sayfadaki' : 'yüklenmiş';
  const action = command === 'select'
    ? 'seçildi'
    : command === 'deselect'
      ? 'seçimden çıkarıldı'
      : command === 'invert'
        ? 'seçimi tersine çevrildi'
        : 'seçimi değiştirildi';
  const truncation = truncated ? ` Seçim sınırı ${selectedCount} sonuçta durduruldu.` : '';
  return `${changedCount} ${scopeLabel} sonuç ${action}. Toplam ${selectedCount} sonuç seçili.${truncation}`;
};

const applyScopeMutation = (
  snapshot: ResultSelectionSnapshot,
  command: Exclude<ResultSelectionCommand, 'clear'>,
  scopeIds: readonly string[],
): { readonly selectedIds: readonly string[]; readonly changedCount: number; readonly truncated: boolean } => {
  const selected = new Set(snapshot.selectedIds);
  const before = selected.size;
  let truncated = false;

  for (const id of scopeIds) {
    const isSelected = selected.has(id);
    if (command === 'deselect') {
      selected.delete(id);
      continue;
    }
    if (command === 'toggle' || command === 'invert') {
      if (isSelected) {
        selected.delete(id);
        continue;
      }
    } else if (command === 'select' && isSelected) {
      continue;
    }

    if (selected.size >= snapshot.maxSelection) {
      truncated = true;
      continue;
    }
    selected.add(id);
  }

  const ordered = snapshot.resultIds.filter((id) => selected.has(id)).slice(0, snapshot.maxSelection);
  return Object.freeze({
    selectedIds: Object.freeze(ordered),
    changedCount: Math.abs(ordered.length - before) + (command === 'invert' || command === 'toggle'
      ? scopeIds.filter((id) => snapshot.selectedIds.includes(id) !== ordered.includes(id)).length - Math.abs(ordered.length - before)
      : 0),
    truncated,
  });
};

const countMembershipChanges = (before: readonly string[], after: readonly string[]): number => {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  let changed = 0;
  for (const id of beforeSet) if (!afterSet.has(id)) changed += 1;
  for (const id of afterSet) if (!beforeSet.has(id)) changed += 1;
  return changed;
};

export const applyResultBulkSelection = (
  snapshot: ResultSelectionSnapshot,
  command: ResultSelectionCommand,
  scope: ResultSelectionScope = 'visible',
): ResultSelectionTransition => {
  const scopeIds = resolveResultSelectionScope(snapshot, scope);
  const mutation = command === 'clear'
    ? Object.freeze({ selectedIds: Object.freeze([] as string[]), changedCount: snapshot.selectedIds.length, truncated: false })
    : applyScopeMutation(snapshot, command, scopeIds);
  const changedCount = countMembershipChanges(snapshot.selectedIds, mutation.selectedIds);
  const focusTarget = snapshot.focusedId ?? scopeIds[0] ?? snapshot.resultIds[0] ?? null;
  const next = normalizeResultSelectionSnapshot({
    ...snapshot,
    selectedIds: mutation.selectedIds,
    focusedId: focusTarget,
    anchorId: command === 'clear' ? null : snapshot.anchorId ?? focusTarget,
  });

  return Object.freeze({
    next,
    changedCount,
    selectedCount: next.selectedCount,
    truncated: mutation.truncated,
    focusTarget,
    announcement: selectionAnnouncement(command, scope, changedCount, next.selectedCount, mutation.truncated),
  });
};

export const selectResultRange = (
  snapshot: ResultSelectionSnapshot,
  targetId: string,
  additive = false,
): ResultSelectionTransition => {
  const target = sanitizeId(targetId);
  const targetIndex = snapshot.resultIds.indexOf(target);
  if (targetIndex < 0) {
    return Object.freeze({
      next: snapshot,
      changedCount: 0,
      selectedCount: snapshot.selectedCount,
      truncated: false,
      focusTarget: snapshot.focusedId,
      announcement: 'Aralık seçimi uygulanamadı.',
    });
  }

  const anchor = snapshot.anchorId ?? snapshot.focusedId ?? target;
  const anchorIndex = Math.max(0, snapshot.resultIds.indexOf(anchor));
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const range = snapshot.resultIds.slice(start, end + 1);
  const selected = additive ? new Set(snapshot.selectedIds) : new Set<string>();
  let truncated = false;
  for (const id of range) {
    if (selected.has(id)) continue;
    if (selected.size >= snapshot.maxSelection) {
      truncated = true;
      break;
    }
    selected.add(id);
  }
  const selectedIds = snapshot.resultIds.filter((id) => selected.has(id));
  const changedCount = countMembershipChanges(snapshot.selectedIds, selectedIds);
  const next = normalizeResultSelectionSnapshot({
    ...snapshot,
    selectedIds,
    focusedId: target,
    anchorId: anchor,
  });

  return Object.freeze({
    next,
    changedCount,
    selectedCount: next.selectedCount,
    truncated,
    focusTarget: target,
    announcement: `${range.length} sonuçluk aralık işlendi. Toplam ${next.selectedCount} sonuç seçili.${truncated ? ' Seçim sınırına ulaşıldı.' : ''}`,
  });
};

export const reconcileResultSelection = (
  previous: ResultSelectionSnapshot,
  nextResultIds: readonly string[],
  visibleIds: readonly string[] = previous.visibleIds,
  pageIds: readonly string[] = previous.pageIds,
): ResultSelectionReconcileResult => {
  const nextIds = normalizeUniqueIds(nextResultIds);
  const nextSet = new Set(nextIds);
  const retainedSelection = previous.selectedIds.filter((id) => nextSet.has(id));
  const removedSelectionCount = previous.selectedIds.length - retainedSelection.length;
  const focusedId = previous.focusedId && nextSet.has(previous.focusedId) ? previous.focusedId : nextIds[0] ?? null;
  const anchorId = previous.anchorId && nextSet.has(previous.anchorId) ? previous.anchorId : focusedId;
  const next = normalizeResultSelectionSnapshot({
    resultIds: nextIds,
    visibleIds,
    pageIds,
    selectedIds: retainedSelection,
    focusedId,
    anchorId,
    maxSelection: previous.maxSelection,
  });
  const focusChanged = previous.focusedId !== next.focusedId;
  const anchorChanged = previous.anchorId !== next.anchorId;
  const announcement = removedSelectionCount > 0
    ? `${removedSelectionCount} seçili sonuç artık mevcut değil. Toplam ${next.selectedCount} sonuç seçili.`
    : nextIds.length !== previous.resultIds.length
      ? `${nextIds.length} sonuç kullanılabilir.`
      : '';

  return Object.freeze({ next, removedSelectionCount, focusChanged, anchorChanged, announcement });
};

export const createResultSelectionToolbarFacts = (snapshot: ResultSelectionSnapshot) => Object.freeze({
  canClear: snapshot.selectedCount > 0,
  canSelectVisible: snapshot.visibleIds.length > 0 && snapshot.visibleCoverage !== 'all' && snapshot.capacityRemaining > 0,
  canSelectPage: snapshot.pageIds.length > 0 && snapshot.pageCoverage !== 'all' && snapshot.capacityRemaining > 0,
  canSelectLoaded: snapshot.resultIds.length > 0 && snapshot.loadedCoverage !== 'all' && snapshot.capacityRemaining > 0,
  canInvertVisible: snapshot.visibleIds.length > 0,
  selectedCount: snapshot.selectedCount,
  maxSelection: snapshot.maxSelection,
  capacityRemaining: snapshot.capacityRemaining,
  summary: snapshot.selectedCount === 0
    ? 'Sonuç seçimi yok.'
    : `${snapshot.selectedCount} sonuç seçili; en fazla ${snapshot.maxSelection} sonuç seçilebilir.`,
});
