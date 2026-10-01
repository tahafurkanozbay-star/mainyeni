export type ResultInteractionViewport = 'phone' | 'tablet' | 'desktop';
export type ResultInteractionSurface = 'collection' | 'detail' | 'filters' | 'map';
export type ResultInteractionReason = 'keyboard' | 'pointer' | 'programmatic' | 'result-refresh' | 'filter-change';

export interface ResultInteractionSnapshot {
  resultIds: readonly string[];
  selectedIds: readonly string[];
  focusedId: string | null;
  activeId: string | null;
  anchorId: string | null;
  surface: ResultInteractionSurface;
  viewport: ResultInteractionViewport;
  detailOpen: boolean;
  filterOpen: boolean;
  scrollTop: number;
  rowHeight: number;
  viewportHeight: number;
}

export interface ResultInteractionTransition {
  next: ResultInteractionSnapshot;
  focusTarget: string | null;
  scrollTop: number;
  announcement: string;
  restoreMapFocus: boolean;
}

const MAX_RESULTS = 20_000;
const MAX_SELECTION = 1_000;
const cleanId = (value: unknown): string => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;

export function normalizeResultInteractionSnapshot(input: Partial<ResultInteractionSnapshot>): ResultInteractionSnapshot {
  const seen = new Set<string>();
  const resultIds = (input.resultIds ?? []).flatMap((raw) => {
    if (seen.size >= MAX_RESULTS) return [];
    const id = cleanId(raw);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
  const resultSet = new Set(resultIds);
  const selectionSeen = new Set<string>();
  const selectedIds = (input.selectedIds ?? []).flatMap((raw) => {
    if (selectionSeen.size >= MAX_SELECTION) return [];
    const id = cleanId(raw);
    if (!resultSet.has(id) || selectionSeen.has(id)) return [];
    selectionSeen.add(id);
    return [id];
  });
  const focusedCandidate = cleanId(input.focusedId);
  const activeCandidate = cleanId(input.activeId);
  const anchorCandidate = cleanId(input.anchorId);
  const viewport = input.viewport === 'phone' || input.viewport === 'tablet' ? input.viewport : 'desktop';
  const surface: ResultInteractionSurface = ['collection', 'detail', 'filters', 'map'].includes(input.surface ?? '') ? input.surface! : 'collection';
  const rowHeight = Math.min(96, Math.max(36, finite(input.rowHeight ?? 56, 56)));
  const viewportHeight = Math.max(0, finite(input.viewportHeight ?? 0));
  const maxScroll = Math.max(0, resultIds.length * rowHeight - viewportHeight);
  return {
    resultIds,
    selectedIds,
    focusedId: resultSet.has(focusedCandidate) ? focusedCandidate : null,
    activeId: resultSet.has(activeCandidate) ? activeCandidate : null,
    anchorId: resultSet.has(anchorCandidate) ? anchorCandidate : null,
    surface,
    viewport,
    detailOpen: Boolean(input.detailOpen && resultSet.has(activeCandidate)),
    filterOpen: viewport === 'desktop' ? false : Boolean(input.filterOpen),
    scrollTop: Math.min(maxScroll, Math.max(0, finite(input.scrollTop ?? 0))),
    rowHeight,
    viewportHeight,
  };
}

function focusScroll(snapshot: ResultInteractionSnapshot, id: string | null): number {
  if (!id) return snapshot.scrollTop;
  const index = snapshot.resultIds.indexOf(id);
  if (index < 0) return snapshot.scrollTop;
  const top = index * snapshot.rowHeight;
  const bottom = top + snapshot.rowHeight;
  if (top < snapshot.scrollTop) return top;
  if (bottom > snapshot.scrollTop + snapshot.viewportHeight) return Math.max(0, bottom - snapshot.viewportHeight);
  return snapshot.scrollTop;
}

export function reconcileResultInteraction(
  previous: ResultInteractionSnapshot,
  nextResultIds: readonly string[],
  reason: ResultInteractionReason,
): ResultInteractionTransition {
  const next = normalizeResultInteractionSnapshot({ ...previous, resultIds: nextResultIds });
  const previousFocusIndex = previous.focusedId ? previous.resultIds.indexOf(previous.focusedId) : -1;
  let focusTarget = next.focusedId;
  if (!focusTarget && next.resultIds.length && previousFocusIndex >= 0) {
    focusTarget = next.resultIds[Math.min(previousFocusIndex, next.resultIds.length - 1)];
  }
  if (!focusTarget && reason === 'keyboard' && next.resultIds.length) focusTarget = next.resultIds[0];
  const activeRemoved = Boolean(previous.activeId && !next.resultIds.includes(previous.activeId));
  const selectedRemoved = previous.selectedIds.length - next.selectedIds.length;
  const reconciled = normalizeResultInteractionSnapshot({ ...next, focusedId: focusTarget, activeId: activeRemoved ? null : next.activeId, detailOpen: activeRemoved ? false : next.detailOpen });
  const announcement = activeRemoved
    ? 'Açık sonuç artık listede değil; detay kapatıldı'
    : selectedRemoved > 0
      ? `${selectedRemoved} seçili sonuç artık listede değil`
      : reason === 'result-refresh'
        ? `${reconciled.resultIds.length} sonuç güncellendi`
        : reason === 'filter-change'
          ? `${reconciled.resultIds.length} sonuç filtrelendi`
          : '';
  return {
    next: reconciled,
    focusTarget,
    scrollTop: focusScroll(reconciled, focusTarget),
    announcement,
    restoreMapFocus: activeRemoved && previous.surface === 'detail',
  };
}

export function openResultDetail(snapshot: ResultInteractionSnapshot, resultId: string): ResultInteractionTransition {
  const id = cleanId(resultId);
  if (!snapshot.resultIds.includes(id)) return { next: snapshot, focusTarget: snapshot.focusedId, scrollTop: snapshot.scrollTop, announcement: '', restoreMapFocus: false };
  const next = normalizeResultInteractionSnapshot({ ...snapshot, activeId: id, focusedId: id, detailOpen: true, surface: 'detail' });
  return { next, focusTarget: id, scrollTop: focusScroll(next, id), announcement: 'Sonuç ayrıntıları açıldı', restoreMapFocus: false };
}

export function closeResultDetail(snapshot: ResultInteractionSnapshot): ResultInteractionTransition {
  if (!snapshot.detailOpen) return { next: snapshot, focusTarget: snapshot.focusedId, scrollTop: snapshot.scrollTop, announcement: '', restoreMapFocus: false };
  const focusTarget = snapshot.activeId ?? snapshot.focusedId;
  const next = normalizeResultInteractionSnapshot({ ...snapshot, detailOpen: false, activeId: null, focusedId: focusTarget, surface: 'collection' });
  return { next, focusTarget, scrollTop: focusScroll(next, focusTarget), announcement: 'Sonuç ayrıntıları kapatıldı', restoreMapFocus: false };
}

export function moveResultFocus(snapshot: ResultInteractionSnapshot, delta: number): ResultInteractionTransition {
  if (!snapshot.resultIds.length) return { next: snapshot, focusTarget: null, scrollTop: 0, announcement: '', restoreMapFocus: false };
  const current = snapshot.focusedId ? snapshot.resultIds.indexOf(snapshot.focusedId) : -1;
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const index = Math.min(snapshot.resultIds.length - 1, Math.max(0, (current < 0 ? 0 : current) + step));
  const focusTarget = snapshot.resultIds[index];
  const next = normalizeResultInteractionSnapshot({ ...snapshot, focusedId: focusTarget, surface: 'collection' });
  return { next, focusTarget, scrollTop: focusScroll(next, focusTarget), announcement: `${index + 1} / ${snapshot.resultIds.length}`, restoreMapFocus: false };
}

export function toggleResultSelection(snapshot: ResultInteractionSnapshot, resultId: string, extend = false): ResultInteractionTransition {
  const id = cleanId(resultId);
  if (!snapshot.resultIds.includes(id)) return { next: snapshot, focusTarget: snapshot.focusedId, scrollTop: snapshot.scrollTop, announcement: '', restoreMapFocus: false };
  let selectedIds: string[];
  if (extend && snapshot.anchorId) {
    const a = snapshot.resultIds.indexOf(snapshot.anchorId);
    const b = snapshot.resultIds.indexOf(id);
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    selectedIds = snapshot.resultIds.slice(start, end + 1).slice(0, MAX_SELECTION);
  } else {
    selectedIds = snapshot.selectedIds.includes(id) ? snapshot.selectedIds.filter((item) => item !== id) : [...snapshot.selectedIds, id].slice(0, MAX_SELECTION);
  }
  const next = normalizeResultInteractionSnapshot({ ...snapshot, selectedIds, focusedId: id, anchorId: extend ? snapshot.anchorId ?? id : id });
  return { next, focusTarget: id, scrollTop: focusScroll(next, id), announcement: selectedIds.length ? `${selectedIds.length} sonuç seçili` : 'Seçim temizlendi', restoreMapFocus: false };
}
