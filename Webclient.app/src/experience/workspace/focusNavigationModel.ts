export type WorkspaceFocusRegion = 'header' | 'navigation' | 'map' | 'tools' | 'content' | 'status';
export type FocusMove = 'next' | 'previous' | 'first' | 'last';

export interface WorkspaceFocusTarget {
  readonly id: string;
  readonly region: WorkspaceFocusRegion;
  readonly label: string;
  readonly order: number;
  readonly disabled?: boolean | undefined;
  readonly hidden?: boolean | undefined;
  readonly modalScope?: string | null | undefined;
}

export interface WorkspaceFocusSnapshot {
  readonly activeId: string | null;
  readonly activeRegion: WorkspaceFocusRegion | null;
  readonly modalScope: string | null;
  readonly targets: readonly Readonly<WorkspaceFocusTarget>[];
  readonly availableIds: readonly string[];
  readonly revision: number;
}

export interface WorkspaceFocusModel {
  readonly getSnapshot: () => WorkspaceFocusSnapshot;
  readonly replaceTargets: (targets: readonly WorkspaceFocusTarget[]) => WorkspaceFocusSnapshot;
  readonly activate: (id: string | null) => WorkspaceFocusSnapshot;
  readonly move: (move: FocusMove) => WorkspaceFocusSnapshot;
  readonly moveRegion: (region: WorkspaceFocusRegion, edge?: 'first' | 'last') => WorkspaceFocusSnapshot;
  readonly enterModal: (scope: string, preferredId?: string | null | undefined) => WorkspaceFocusSnapshot;
  readonly leaveModal: () => WorkspaceFocusSnapshot;
}

const MAX_TARGETS = 256;
const REGIONS: readonly WorkspaceFocusRegion[] = Object.freeze(['header', 'navigation', 'map', 'tools', 'content', 'status']);

const freezeTarget = (target: WorkspaceFocusTarget): Readonly<WorkspaceFocusTarget> => {
  const id = String(target.id ?? '').trim();
  const label = String(target.label ?? '').trim();
  if (!id) throw new Error('Workspace focus target id is required.');
  if (!label) throw new Error(`Workspace focus target label is required for "${id}".`);
  if (!REGIONS.includes(target.region)) throw new Error(`Unsupported workspace focus region for "${id}".`);
  if (!Number.isFinite(target.order)) throw new Error(`Workspace focus order must be finite for "${id}".`);
  const modalScope = String(target.modalScope ?? '').trim() || null;
  return Object.freeze({ ...target, id, label, order: Math.trunc(target.order), modalScope });
};

const normalizeTargets = (targets: readonly WorkspaceFocusTarget[]): readonly Readonly<WorkspaceFocusTarget>[] => {
  if (targets.length > MAX_TARGETS) throw new Error(`Workspace focus capacity exceeded (${MAX_TARGETS}).`);
  const ids = new Set<string>();
  return Object.freeze(targets.map(freezeTarget).map((target) => {
    if (ids.has(target.id)) throw new Error(`Duplicate workspace focus target id "${target.id}".`);
    ids.add(target.id);
    return target;
  }).sort((left, right) => left.order - right.order || REGIONS.indexOf(left.region) - REGIONS.indexOf(right.region) || left.id.localeCompare(right.id)));
};

const isAvailable = (target: Readonly<WorkspaceFocusTarget>, modalScope: string | null): boolean => {
  if (target.disabled || target.hidden) return false;
  if (modalScope !== null) return target.modalScope === modalScope;
  return target.modalScope === null || target.modalScope === undefined;
};

const freezeSnapshot = (targets: readonly Readonly<WorkspaceFocusTarget>[], activeId: string | null, modalScope: string | null, revision: number): WorkspaceFocusSnapshot => {
  const available = targets.filter((target) => isAvailable(target, modalScope));
  const active = activeId ? available.find((target) => target.id === activeId) ?? null : null;
  return Object.freeze({ activeId: active?.id ?? null, activeRegion: active?.region ?? null, modalScope, targets, availableIds: Object.freeze(available.map((target) => target.id)), revision });
};

export const createWorkspaceFocusModel = (initialTargets: readonly WorkspaceFocusTarget[]): WorkspaceFocusModel => {
  let targets = normalizeTargets(initialTargets);
  let revision = 0;
  let modalScope: string | null = null;
  let activeId: string | null = null;
  const returnStack: string[] = [];
  let snapshot = freezeSnapshot(targets, activeId, modalScope, revision);
  const publish = (nextActiveId: string | null = activeId): WorkspaceFocusSnapshot => {
    revision += 1;
    snapshot = freezeSnapshot(targets, nextActiveId, modalScope, revision);
    activeId = snapshot.activeId;
    return snapshot;
  };
  const available = (): readonly Readonly<WorkspaceFocusTarget>[] => targets.filter((target) => isAvailable(target, modalScope));
  const move = (direction: FocusMove): WorkspaceFocusSnapshot => {
    const list = available();
    if (!list.length) return publish(null);
    if (direction === 'first') return publish(list[0]?.id ?? null);
    if (direction === 'last') return publish(list[list.length - 1]?.id ?? null);
    const current = activeId ? list.findIndex((target) => target.id === activeId) : -1;
    if (current < 0) return publish(direction === 'previous' ? list[list.length - 1]?.id ?? null : list[0]?.id ?? null);
    const delta = direction === 'previous' ? -1 : 1;
    const next = (current + delta + list.length) % list.length;
    return publish(list[next]?.id ?? null);
  };
  const model: WorkspaceFocusModel = {
    getSnapshot: () => snapshot,
    replaceTargets: (nextTargets: readonly WorkspaceFocusTarget[]) => { targets = normalizeTargets(nextTargets); if (activeId && !targets.some((target) => target.id === activeId && isAvailable(target, modalScope))) activeId = null; return publish(activeId); },
    activate: (id: string | null) => { if (id === null) return publish(null); const target = targets.find((candidate) => candidate.id === id); return publish(target && isAvailable(target, modalScope) ? target.id : activeId); },
    move,
    moveRegion: (region: WorkspaceFocusRegion, edge: 'first' | 'last' = 'first') => { const regionTargets = available().filter((target) => target.region === region); if (!regionTargets.length) return publish(activeId); return publish(edge === 'last' ? regionTargets[regionTargets.length - 1]?.id ?? null : regionTargets[0]?.id ?? null); },
    enterModal: (scope: string, preferredId: string | null = null) => { const normalizedScope = String(scope ?? '').trim(); if (!normalizedScope) throw new Error('Workspace modal focus scope is required.'); if (modalScope === null && activeId) returnStack.push(activeId); modalScope = normalizedScope; const scoped = available(); const preferred = preferredId ? scoped.find((target) => target.id === preferredId) : null; return publish(preferred?.id ?? scoped[0]?.id ?? null); },
    leaveModal: () => { if (modalScope === null) return snapshot; modalScope = null; const restore = returnStack.pop() ?? null; const validRestore = restore && targets.some((target) => target.id === restore && isAvailable(target, null)) ? restore : null; return publish(validRestore); },
  };
  return Object.freeze(model);
};
