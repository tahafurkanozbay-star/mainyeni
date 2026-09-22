export type FieldValue = string | number | boolean | null | undefined;
export type ValidationTrigger = 'change' | 'blur' | 'submit';

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity?: 'error' | 'warning';
}

export interface ValidationContext {
  readonly name: string;
  readonly value: FieldValue;
  readonly values: Readonly<Record<string, FieldValue>>;
  readonly trigger: ValidationTrigger;
  readonly signal: AbortSignal;
}

export type FieldValidator = (context: ValidationContext) =>
  | ValidationIssue
  | readonly ValidationIssue[]
  | null
  | undefined
  | Promise<ValidationIssue | readonly ValidationIssue[] | null | undefined>;

export interface FieldDefinition {
  readonly name: string;
  readonly label: string;
  readonly validators?: readonly FieldValidator[];
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
}

export interface FieldValidationState {
  readonly name: string;
  readonly value: FieldValue;
  readonly initialValue: FieldValue;
  readonly dirty: boolean;
  readonly touched: boolean;
  readonly validating: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly invalid: boolean;
}

export interface FormValidationRuntime {
  getField(name: string): FieldValidationState;
  getValues(): Readonly<Record<string, FieldValue>>;
  setValue(name: string, value: FieldValue): FieldValidationState;
  touch(name: string): FieldValidationState;
  validateField(name: string, trigger?: ValidationTrigger): Promise<FieldValidationState>;
  validateAll(trigger?: ValidationTrigger): Promise<{ readonly valid: boolean; readonly firstInvalid: string | null }>;
  reset(): void;
  dispose(): void;
}

interface MutableField {
  definition: FieldDefinition;
  value: FieldValue;
  initialValue: FieldValue;
  touched: boolean;
  validating: boolean;
  issues: ValidationIssue[];
  sequence: number;
  controller: AbortController | null;
}

function normalizedIssues(value: ValidationIssue | readonly ValidationIssue[] | null | undefined): ValidationIssue[] {
  if (!value) return [];
  const issues = Array.isArray(value) ? value : [value];
  return issues.map((issue) => ({ ...issue, severity: issue.severity ?? 'error' }));
}

export function required(message = 'Bu alan zorunludur.'): FieldValidator {
  return ({ value }) => value == null || (typeof value === 'string' && value.trim() === '')
    ? { code: 'required', message }
    : null;
}

export function minLength(length: number, message?: string): FieldValidator {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('length must be a non-negative integer');
  return ({ value }) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') return { code: 'type', message: 'Metin değeri bekleniyor.' };
    return value.length < length ? { code: 'minLength', message: message ?? `En az ${length} karakter girin.` } : null;
  };
}

export function numberRange(min?: number, max?: number): FieldValidator {
  if (min != null && max != null && min > max) throw new RangeError('min cannot exceed max');
  return ({ value }) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return { code: 'type', message: 'Geçerli bir sayı girin.' };
    if (min != null && value < min) return { code: 'min', message: `Değer en az ${min} olmalıdır.` };
    if (max != null && value > max) return { code: 'max', message: `Değer en fazla ${max} olmalıdır.` };
    return null;
  };
}

export function createFormValidationRuntime(
  definitions: readonly FieldDefinition[],
  initialValues: Readonly<Record<string, FieldValue>> = {},
): FormValidationRuntime {
  if (!definitions.length) throw new Error('At least one field is required');
  const fields = new Map<string, MutableField>();
  let disposed = false;

  for (const definition of definitions) {
    const name = definition.name.trim();
    if (!name) throw new Error('Field name cannot be empty');
    if (fields.has(name)) throw new Error(`Duplicate field: ${name}`);
    const initialValue = initialValues[name];
    fields.set(name, { definition: { ...definition, name }, value: initialValue, initialValue, touched: false, validating: false, issues: [], sequence: 0, controller: null });
  }

  const active = () => {
    if (disposed) throw new Error('Form validation runtime has been disposed');
  };
  const mutable = (name: string) => {
    const field = fields.get(name);
    if (!field) throw new Error(`Unknown field: ${name}`);
    return field;
  };
  const values = () => Object.fromEntries([...fields].map(([name, field]) => [name, field.value]));
  const snapshot = (field: MutableField): FieldValidationState => ({
    name: field.definition.name,
    value: field.value,
    initialValue: field.initialValue,
    dirty: !Object.is(field.value, field.initialValue),
    touched: field.touched,
    validating: field.validating,
    issues: field.issues.map((issue) => ({ ...issue })),
    invalid: field.issues.some((issue) => (issue.severity ?? 'error') === 'error'),
  });

  const validate = async (field: MutableField, trigger: ValidationTrigger) => {
    active();
    if (field.definition.disabled) return snapshot(field);
    field.controller?.abort();
    const controller = new AbortController();
    const sequence = ++field.sequence;
    field.controller = controller;
    field.validating = true;
    const issues: ValidationIssue[] = [];
    const context: ValidationContext = { name: field.definition.name, value: field.value, values: values(), trigger, signal: controller.signal };
    try {
      for (const validator of field.definition.validators ?? []) {
        if (controller.signal.aborted) break;
        issues.push(...normalizedIssues(await validator(context)));
      }
    } catch {
      if (!controller.signal.aborted) issues.push({ code: 'validation', message: 'Doğrulama tamamlanamadı.', severity: 'error' });
    }
    if (!disposed && sequence === field.sequence && !controller.signal.aborted) {
      field.issues = issues;
      field.validating = false;
      field.controller = null;
    }
    return snapshot(field);
  };

  return {
    getField(name) { active(); return snapshot(mutable(name)); },
    getValues() { active(); return values(); },
    setValue(name, value) {
      active();
      const field = mutable(name);
      if (!field.definition.disabled && !field.definition.readOnly) field.value = value;
      return snapshot(field);
    },
    touch(name) { active(); const field = mutable(name); field.touched = true; return snapshot(field); },
    validateField(name, trigger = 'submit') { return validate(mutable(name), trigger); },
    async validateAll(trigger = 'submit') {
      active();
      const enabled = [...fields.values()].filter((field) => !field.definition.disabled);
      const states = await Promise.all(enabled.map((field) => validate(field, trigger)));
      return { valid: states.every((state) => !state.invalid), firstInvalid: states.find((state) => state.invalid)?.name ?? null };
    },
    reset() {
      active();
      for (const field of fields.values()) {
        field.controller?.abort();
        field.value = field.initialValue;
        field.touched = false;
        field.validating = false;
        field.issues = [];
        field.sequence += 1;
        field.controller = null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const field of fields.values()) field.controller?.abort();
    },
  };
}
