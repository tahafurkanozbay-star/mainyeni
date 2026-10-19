export type ResultFilterOperator = 'equals' | 'contains' | 'between' | 'before' | 'after';
export type ResultFilterKind = 'text' | 'number' | 'date' | 'choice';
export type ResultFilterViewport = 'phone' | 'tablet' | 'desktop';

export interface ResultFilterDefinition {
  id: string;
  label: string;
  kind: ResultFilterKind;
  operators?: readonly ResultFilterOperator[];
  options?: readonly { value: string; label: string; count?: number }[];
}

export interface ResultFilterClause {
  id: string;
  filterId: string;
  operator: ResultFilterOperator;
  value: string;
  secondaryValue?: string;
}

export interface ResultFilterState {
  definitions: readonly ResultFilterDefinition[];
  clauses: readonly ResultFilterClause[];
  draftClauses: readonly ResultFilterClause[];
  panelOpen: boolean;
  viewport: ResultFilterViewport;
  dirty: boolean;
  invalidClauseIds: readonly string[];
  activeCount: number;
  summary: string;
  applyLabel: string;
  clearLabel: string;
  panelLabel: string;
}

export type ResultFilterAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'cancel' }
  | { type: 'apply' }
  | { type: 'clear' }
  | { type: 'remove'; clauseId: string }
  | { type: 'upsert'; clause: ResultFilterClause };

const MAX_FILTERS = 32;
const MAX_OPTIONS = 100;
const MAX_CLAUSES = 24;
const MAX_TEXT = 160;

const clean = (value: unknown, max = MAX_TEXT): string =>
  String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const finite = (value: number): boolean => Number.isFinite(value);

export function resolveResultFilterViewport(width?: number): ResultFilterViewport {
  if (!finite(width ?? Number.NaN)) return 'desktop';
  if ((width as number) < 640) return 'phone';
  if ((width as number) < 1024) return 'tablet';
  return 'desktop';
}

const defaultOperators = (kind: ResultFilterKind): readonly ResultFilterOperator[] => {
  if (kind === 'text') return ['contains', 'equals'];
  if (kind === 'number') return ['equals', 'between'];
  if (kind === 'date') return ['equals', 'before', 'after', 'between'];
  return ['equals'];
};

export function normalizeResultFilterDefinitions(input: readonly ResultFilterDefinition[]): readonly ResultFilterDefinition[] {
  const seen = new Set<string>();
  const result: ResultFilterDefinition[] = [];
  for (const item of input) {
    if (result.length >= MAX_FILTERS) break;
    const id = clean(item.id, 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind: ResultFilterKind = ['text', 'number', 'date', 'choice'].includes(item.kind) ? item.kind : 'text';
    const allowed = new Set(defaultOperators(kind));
    const operators = (item.operators ?? defaultOperators(kind)).filter((operator, index, list) => allowed.has(operator) && list.indexOf(operator) === index);
    const optionSeen = new Set<string>();
    const options = (item.options ?? []).flatMap((option) => {
      if (optionSeen.size >= MAX_OPTIONS) return [];
      const value = clean(option.value, 120);
      if (!value || optionSeen.has(value)) return [];
      optionSeen.add(value);
      return [{ value, label: clean(option.label) || value, count: finite(option.count ?? Number.NaN) ? Math.max(0, Math.floor(option.count!)) : undefined }];
    });
    result.push({ id, label: clean(item.label) || id, kind, operators: operators.length ? operators : defaultOperators(kind), options });
  }
  return result;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isClauseValid(clause: ResultFilterClause, definition: ResultFilterDefinition): boolean {
  if (!definition.operators?.includes(clause.operator)) return false;
  const value = clean(clause.value);
  if (!value) return false;
  if (definition.kind === 'number') {
    if (!Number.isFinite(Number(value))) return false;
    if (clause.operator === 'between') return Number.isFinite(Number(clean(clause.secondaryValue)));
  }
  if (definition.kind === 'date') {
    if (!validDate(value)) return false;
    if (clause.operator === 'between') return validDate(clean(clause.secondaryValue));
  }
  if (definition.kind === 'choice') return Boolean(definition.options?.some((option) => option.value === value));
  return true;
}

export function normalizeResultFilterClauses(
  input: readonly ResultFilterClause[],
  definitions: readonly ResultFilterDefinition[],
): { clauses: readonly ResultFilterClause[]; invalidClauseIds: readonly string[] } {
  const definitionMap = new Map(definitions.map((definition) => [definition.id, definition]));
  const seen = new Set<string>();
  const clauses: ResultFilterClause[] = [];
  const invalidClauseIds: string[] = [];
  for (const source of input) {
    if (clauses.length >= MAX_CLAUSES) break;
    const id = clean(source.id, 80);
    const filterId = clean(source.filterId, 80);
    if (!id || seen.has(id) || !definitionMap.has(filterId)) continue;
    seen.add(id);
    const clause: ResultFilterClause = {
      id,
      filterId,
      operator: source.operator,
      value: clean(source.value),
      ...(source.secondaryValue === undefined ? {} : { secondaryValue: clean(source.secondaryValue) }),
    };
    clauses.push(clause);
    if (!isClauseValid(clause, definitionMap.get(filterId)!)) invalidClauseIds.push(id);
  }
  return { clauses, invalidClauseIds };
}

function sameClauses(left: readonly ResultFilterClause[], right: readonly ResultFilterClause[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createResultFilterState(input: {
  definitions: readonly ResultFilterDefinition[];
  clauses?: readonly ResultFilterClause[];
  draftClauses?: readonly ResultFilterClause[];
  viewportWidth?: number;
  panelOpen?: boolean;
}): ResultFilterState {
  const definitions = normalizeResultFilterDefinitions(input.definitions);
  const committed = normalizeResultFilterClauses(input.clauses ?? [], definitions);
  const draft = normalizeResultFilterClauses(input.draftClauses ?? committed.clauses, definitions);
  const viewport = resolveResultFilterViewport(input.viewportWidth);
  const activeCount = committed.clauses.length;
  return {
    definitions,
    clauses: committed.clauses,
    draftClauses: draft.clauses,
    panelOpen: viewport === 'desktop' ? false : Boolean(input.panelOpen),
    viewport,
    dirty: !sameClauses(committed.clauses, draft.clauses),
    invalidClauseIds: draft.invalidClauseIds,
    activeCount,
    summary: activeCount ? `${activeCount} etkin filtre` : 'Filtre yok',
    applyLabel: draft.invalidClauseIds.length ? `Filtreleri uygula, ${draft.invalidClauseIds.length} hata var` : 'Filtreleri uygula',
    clearLabel: activeCount ? `Tüm filtreleri temizle, ${activeCount} etkin` : 'Filtreleri temizle',
    panelLabel: viewport === 'desktop' ? 'Sonuç filtreleri' : `Sonuç filtreleri${activeCount ? `, ${activeCount} etkin` : ''}`,
  };
}

export function reduceResultFilterState(state: ResultFilterState, action: ResultFilterAction): ResultFilterState {
  if (action.type === 'open') return { ...state, panelOpen: state.viewport === 'desktop' ? false : true };
  if (action.type === 'close') return { ...state, panelOpen: false };
  if (action.type === 'cancel') return createResultFilterState({ definitions: state.definitions, clauses: state.clauses, draftClauses: state.clauses, panelOpen: false, viewportWidth: state.viewport === 'phone' ? 390 : state.viewport === 'tablet' ? 800 : 1280 });
  if (action.type === 'clear') return createResultFilterState({ definitions: state.definitions, clauses: [], draftClauses: [], panelOpen: state.panelOpen, viewportWidth: state.viewport === 'phone' ? 390 : state.viewport === 'tablet' ? 800 : 1280 });
  if (action.type === 'apply') {
    if (state.invalidClauseIds.length) return state;
    return createResultFilterState({ definitions: state.definitions, clauses: state.draftClauses, draftClauses: state.draftClauses, panelOpen: false, viewportWidth: state.viewport === 'phone' ? 390 : state.viewport === 'tablet' ? 800 : 1280 });
  }
  const draft = action.type === 'remove'
    ? state.draftClauses.filter((clause) => clause.id !== clean(action.clauseId, 80))
    : [...state.draftClauses.filter((clause) => clause.id !== clean(action.clause.id, 80)), action.clause];
  return createResultFilterState({ definitions: state.definitions, clauses: state.clauses, draftClauses: draft, panelOpen: state.panelOpen, viewportWidth: state.viewport === 'phone' ? 390 : state.viewport === 'tablet' ? 800 : 1280 });
}

export function describeResultFilterChange(previous: ResultFilterState, next: ResultFilterState): string {
  if (previous.activeCount !== next.activeCount) return next.activeCount ? `${next.activeCount} filtre etkin` : 'Tüm filtreler temizlendi';
  if (previous.invalidClauseIds.length !== next.invalidClauseIds.length) return next.invalidClauseIds.length ? `${next.invalidClauseIds.length} filtre alanını düzeltin` : 'Filtre hataları düzeltildi';
  if (!previous.dirty && next.dirty) return 'Filtre değişiklikleri uygulanmayı bekliyor';
  if (previous.dirty && !next.dirty) return 'Filtre değişiklikleri uygulandı';
  return '';
}
