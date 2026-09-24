export type FilterFieldType = 'text' | 'number' | 'select' | 'boolean' | 'date';
export type FilterOperator =
  | 'equals'
  | 'not-equals'
  | 'contains'
  | 'starts-with'
  | 'greater-than'
  | 'greater-or-equal'
  | 'less-than'
  | 'less-or-equal'
  | 'in'
  | 'is-empty'
  | 'is-not-empty';
export type FilterValue = string | number | boolean | readonly string[] | null;

export interface FilterFieldDefinition {
  readonly id: string;
  readonly label: string;
  readonly type: FilterFieldType;
  readonly operators?: readonly FilterOperator[];
  readonly options?: readonly { id: string; label: string }[];
}

export interface FilterConditionInput {
  readonly id: string;
  readonly fieldId: string;
  readonly operator: FilterOperator;
  readonly value?: FilterValue;
}

export interface FilterConditionSnapshot {
  readonly id: string;
  readonly fieldId: string;
  readonly fieldLabel: string;
  readonly operator: FilterOperator;
  readonly operatorLabel: string;
  readonly value: FilterValue;
  readonly valid: boolean;
  readonly error: string | null;
  readonly summary: string;
}

export interface FilterPanelSnapshot {
  readonly query: string;
  readonly conjunction: 'and' | 'or';
  readonly conditions: readonly FilterConditionSnapshot[];
  readonly activeCount: number;
  readonly invalidCount: number;
  readonly hasFilters: boolean;
  readonly canApply: boolean;
  readonly revision: number;
}

export interface FilterPanelModelOptions {
  readonly fields: readonly FilterFieldDefinition[];
  readonly maxConditions?: number;
  readonly onObserverError?: (error: unknown) => void;
}

export interface FilterPanelModel {
  snapshot(): FilterPanelSnapshot;
  setQuery(query: string): void;
  setConjunction(value: 'and' | 'or'): void;
  addCondition(input: FilterConditionInput): void;
  updateCondition(id: string, patch: Partial<Omit<FilterConditionInput, 'id'>>): boolean;
  removeCondition(id: string): boolean;
  moveCondition(id: string, direction: -1 | 1): boolean;
  clear(): void;
  subscribe(observer: (snapshot: FilterPanelSnapshot) => void): () => void;
}

interface NormalizedField {
  readonly id: string;
  readonly label: string;
  readonly type: FilterFieldType;
  readonly operators: readonly FilterOperator[];
  readonly options: ReadonlyMap<string, string>;
}

interface StoredCondition {
  readonly id: string;
  readonly fieldId: string;
  readonly operator: FilterOperator;
  readonly value: FilterValue;
}

const MAX_FIELDS = 128;
const DEFAULT_MAX_CONDITIONS = 24;
const HARD_MAX_CONDITIONS = 64;
const MAX_TEXT = 400;
const MAX_SELECT_VALUES = 64;

const OPERATOR_LABELS: Readonly<Record<FilterOperator, string>> = Object.freeze({
  equals: 'eşittir',
  'not-equals': 'eşit değildir',
  contains: 'içerir',
  'starts-with': 'ile başlar',
  'greater-than': 'büyüktür',
  'greater-or-equal': 'büyük veya eşittir',
  'less-than': 'küçüktür',
  'less-or-equal': 'küçük veya eşittir',
  in: 'şunlardan biri',
  'is-empty': 'boş',
  'is-not-empty': 'boş değil',
});

const DEFAULT_OPERATORS: Readonly<Record<FilterFieldType, readonly FilterOperator[]>> = Object.freeze({
  text: Object.freeze(['contains', 'equals', 'not-equals', 'starts-with', 'is-empty', 'is-not-empty']),
  number: Object.freeze(['equals', 'not-equals', 'greater-than', 'greater-or-equal', 'less-than', 'less-or-equal', 'is-empty', 'is-not-empty']),
  select: Object.freeze(['equals', 'not-equals', 'in', 'is-empty', 'is-not-empty']),
  boolean: Object.freeze(['equals', 'not-equals']),
  date: Object.freeze(['equals', 'not-equals', 'greater-than', 'greater-or-equal', 'less-than', 'less-or-equal', 'is-empty', 'is-not-empty']),
});

const cleanId = (value: string, kind: string): string => {
  const id = value.trim();
  if (!id) throw new Error(`${kind} id is required.`);
  return id;
};

const cleanText = (value: string): string => value.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);

const normalizeFields = (fields: readonly FilterFieldDefinition[]): Map<string, NormalizedField> => {
  if (fields.length === 0) throw new Error('At least one filter field is required.');
  if (fields.length > MAX_FIELDS) throw new Error(`Filter field capacity exceeded (${MAX_FIELDS}).`);
  const result = new Map<string, NormalizedField>();
  fields.forEach((field) => {
    const id = cleanId(field.id, 'Filter field');
    if (result.has(id)) throw new Error(`Duplicate filter field id: ${id}`);
    const label = cleanText(field.label);
    if (!label) throw new Error(`Filter field label is required: ${id}`);
    const operators = field.operators ?? DEFAULT_OPERATORS[field.type];
    if (operators.length === 0) throw new Error(`Filter field must expose at least one operator: ${id}`);
    const supported = new Set(DEFAULT_OPERATORS[field.type]);
    operators.forEach((operator) => {
      if (!supported.has(operator)) throw new Error(`Operator ${operator} is not valid for ${field.type} field ${id}.`);
    });
    const options = new Map<string, string>();
    (field.options ?? []).forEach((option) => {
      const optionId = cleanId(option.id, 'Filter option');
      const optionLabel = cleanText(option.label);
      if (!optionLabel) throw new Error(`Filter option label is required: ${optionId}`);
      if (options.has(optionId)) throw new Error(`Duplicate filter option id: ${optionId}`);
      options.set(optionId, optionLabel);
    });
    if (field.type === 'select' && options.size === 0) throw new Error(`Select filter field requires options: ${id}`);
    result.set(id, Object.freeze({ id, label, type: field.type, operators: Object.freeze([...operators]), options }));
  });
  return result;
};

const normalizeMaxConditions = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONDITIONS;
  return Math.max(1, Math.min(HARD_MAX_CONDITIONS, Math.floor(value ?? DEFAULT_MAX_CONDITIONS)));
};

const normalizeValue = (field: NormalizedField, operator: FilterOperator, value: FilterValue | undefined): FilterValue => {
  if (operator === 'is-empty' || operator === 'is-not-empty') return null;
  if (value === undefined || value === null) return null;
  if (field.type === 'number') {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : null;
  if (operator === 'in') {
    const values = Array.isArray(value) ? value : [String(value)];
    return Object.freeze(values.map((entry) => cleanText(String(entry))).filter(Boolean).slice(0, MAX_SELECT_VALUES));
  }
  return cleanText(String(value));
};

const validate = (field: NormalizedField, condition: StoredCondition): string | null => {
  if (!field.operators.includes(condition.operator)) return 'Bu alan için geçersiz işlem.';
  if (condition.operator === 'is-empty' || condition.operator === 'is-not-empty') return null;
  if (condition.value === null) return 'Bir filtre değeri girin.';
  if (field.type === 'select') {
    const values = Array.isArray(condition.value) ? condition.value : [String(condition.value)];
    if (values.length === 0) return 'En az bir seçenek belirleyin.';
    if (values.some((value) => !field.options.has(String(value)))) return 'Geçersiz seçenek.';
  }
  if (field.type === 'text' && typeof condition.value === 'string' && !condition.value) return 'Bir metin değeri girin.';
  return null;
};

const valueLabel = (field: NormalizedField, value: FilterValue): string => {
  if (value === null) return '';
  if (Array.isArray(value)) return value.map((item) => field.options.get(String(item)) ?? String(item)).join(', ');
  if (field.type === 'select') return field.options.get(String(value)) ?? String(value);
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  return String(value);
};

export const createFilterPanelModel = (options: FilterPanelModelOptions): FilterPanelModel => {
  const fields = normalizeFields(options.fields);
  const maxConditions = normalizeMaxConditions(options.maxConditions);
  const observers = new Set<(snapshot: FilterPanelSnapshot) => void>();
  let query = '';
  let conjunction: 'and' | 'or' = 'and';
  let conditions: StoredCondition[] = [];
  let revision = 0;

  const report = (error: unknown): void => {
    const reporter = options.onObserverError;
    if (!reporter) return;
    try { reporter(error); } catch (reporterError) { void reporterError; }
  };

  const normalizeCondition = (input: FilterConditionInput): StoredCondition => {
    const id = cleanId(input.id, 'Filter condition');
    const fieldId = cleanId(input.fieldId, 'Filter field');
    const field = fields.get(fieldId);
    if (!field) throw new Error(`Unknown filter field: ${fieldId}`);
    if (!field.operators.includes(input.operator)) throw new Error(`Unsupported filter operator ${input.operator} for ${fieldId}.`);
    return Object.freeze({ id, fieldId, operator: input.operator, value: normalizeValue(field, input.operator, input.value) });
  };

  const buildCondition = (condition: StoredCondition): FilterConditionSnapshot => {
    const field = fields.get(condition.fieldId);
    if (!field) throw new Error(`Unknown filter field: ${condition.fieldId}`);
    const error = validate(field, condition);
    const value = valueLabel(field, condition.value);
    const operatorLabel = OPERATOR_LABELS[condition.operator];
    return Object.freeze({
      id: condition.id,
      fieldId: condition.fieldId,
      fieldLabel: field.label,
      operator: condition.operator,
      operatorLabel,
      value: condition.value,
      valid: error === null,
      error,
      summary: value ? `${field.label} ${operatorLabel} ${value}` : `${field.label} ${operatorLabel}`,
    });
  };

  const buildSnapshot = (): FilterPanelSnapshot => {
    const snapshots = Object.freeze(conditions.map(buildCondition));
    const invalidCount = snapshots.filter((condition) => !condition.valid).length;
    const activeCount = conditions.length + (query ? 1 : 0);
    return Object.freeze({
      query,
      conjunction,
      conditions: snapshots,
      activeCount,
      invalidCount,
      hasFilters: activeCount > 0,
      canApply: activeCount > 0 && invalidCount === 0,
      revision,
    });
  };

  const notify = (): void => {
    revision += 1;
    const snapshot = buildSnapshot();
    observers.forEach((observer) => {
      try { observer(snapshot); } catch (error) { report(error); }
    });
  };

  return {
    snapshot: buildSnapshot,
    setQuery(next) {
      const normalized = cleanText(next);
      if (query === normalized) return;
      query = normalized;
      notify();
    },
    setConjunction(next) {
      if (conjunction === next) return;
      conjunction = next;
      notify();
    },
    addCondition(input) {
      if (conditions.length >= maxConditions) throw new Error(`Filter condition capacity exceeded (${maxConditions}).`);
      const normalized = normalizeCondition(input);
      if (conditions.some((condition) => condition.id === normalized.id)) throw new Error(`Duplicate filter condition id: ${normalized.id}`);
      conditions = [...conditions, normalized];
      notify();
    },
    updateCondition(id, patch) {
      const index = conditions.findIndex((condition) => condition.id === id.trim());
      const current = conditions[index];
      if (index < 0 || !current) return false;
      const normalized = normalizeCondition({
        id: current.id,
        fieldId: patch.fieldId ?? current.fieldId,
        operator: patch.operator ?? current.operator,
        value: patch.value === undefined ? current.value : patch.value,
      });
      conditions = conditions.map((condition, conditionIndex) => conditionIndex === index ? normalized : condition);
      notify();
      return true;
    },
    removeCondition(id) {
      const normalized = id.trim();
      if (!conditions.some((condition) => condition.id === normalized)) return false;
      conditions = conditions.filter((condition) => condition.id !== normalized);
      notify();
      return true;
    },
    moveCondition(id, direction) {
      const index = conditions.findIndex((condition) => condition.id === id.trim());
      if (index < 0) return false;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= conditions.length) return false;
      const next = [...conditions];
      const current = next[index];
      const target = next[nextIndex];
      if (!current || !target) return false;
      next[index] = target;
      next[nextIndex] = current;
      conditions = next;
      notify();
      return true;
    },
    clear() {
      if (!query && conditions.length === 0) return;
      query = '';
      conditions = [];
      notify();
    },
    subscribe(observer) {
      observers.add(observer);
      try { observer(buildSnapshot()); } catch (error) { report(error); }
      return () => observers.delete(observer);
    },
  };
};
