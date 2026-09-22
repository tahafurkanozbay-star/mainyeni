export type FieldStatus = 'idle' | 'validating' | 'valid' | 'invalid';
export type ValidationTrigger = 'change' | 'blur' | 'submit';

export interface FieldIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

export interface FieldValidatorContext {
  readonly value: string;
  readonly signal: AbortSignal;
  readonly trigger: ValidationTrigger;
}

export type FieldValidator = (context: FieldValidatorContext) => FieldIssue | readonly FieldIssue[] | null | Promise<FieldIssue | readonly FieldIssue[] | null>;

export interface FormFieldOptions {
  readonly id: string;
  readonly label: string;
  readonly initialValue?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly maxLength?: number;
  readonly validateOn?: readonly ValidationTrigger[];
  readonly validators?: readonly FieldValidator[];
}

export interface FormFieldState {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly initialValue: string;
  readonly dirty: boolean;
  readonly touched: boolean;
  readonly focused: boolean;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly required: boolean;
  readonly status: FieldStatus;
  readonly issues: readonly FieldIssue[];
  readonly errorMessage: string | null;
  readonly warningMessage: string | null;
  readonly ariaInvalid: boolean;
  readonly ariaBusy: boolean;
  readonly describedBy: readonly string[];
  readonly revision: number;
}

export interface FormFieldModel {
  readonly getState: () => FormFieldState;
  readonly setValue: (value: string) => Promise<FormFieldState>;
  readonly focus: () => FormFieldState;
  readonly blur: () => Promise<FormFieldState>;
  readonly validate: (trigger?: ValidationTrigger) => Promise<FormFieldState>;
  readonly reset: (value?: string) => FormFieldState;
  readonly setDisabled: (disabled: boolean) => FormFieldState;
  readonly setReadOnly: (readOnly: boolean) => FormFieldState;
  readonly dispose: () => void;
}

const MAX_VALIDATORS = 24;
const MAX_ISSUES = 12;
const MAX_VALUE_LENGTH = 20_000;

const freezeIssue = (issue: FieldIssue): FieldIssue => Object.freeze({
  code: String(issue.code ?? '').trim() || 'invalid',
  message: String(issue.message ?? '').trim() || 'Geçersiz değer',
  severity: issue.severity === 'warning' ? 'warning' : 'error',
});

const normalizeIssues = (value: FieldIssue | readonly FieldIssue[] | null): readonly FieldIssue[] => {
  if (!value) return Object.freeze([]);
  const source = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const result: FieldIssue[] = [];
  for (const issue of source) {
    const normalized = freezeIssue(issue);
    const key = `${normalized.severity}:${normalized.code}:${normalized.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= MAX_ISSUES) break;
  }
  return Object.freeze(result);
};

const mergeIssues = (groups: readonly (readonly FieldIssue[])[]): readonly FieldIssue[] => {
  const seen = new Set<string>();
  const result: FieldIssue[] = [];
  for (const group of groups) {
    for (const issue of group) {
      const key = `${issue.severity}:${issue.code}:${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(issue);
      if (result.length >= MAX_ISSUES) return Object.freeze(result);
    }
  }
  return Object.freeze(result);
};

export const createFormFieldModel = (options: FormFieldOptions): FormFieldModel => {
  const id = String(options.id ?? '').trim();
  const label = String(options.label ?? '').trim();
  if (!id) throw new Error('Form field id is required.');
  if (!label) throw new Error(`Form field label is required for "${id}".`);
  const maxLength = Math.max(1, Math.min(MAX_VALUE_LENGTH, Math.trunc(options.maxLength ?? MAX_VALUE_LENGTH)));
  const validators = Object.freeze([...(options.validators ?? [])].slice(0, MAX_VALIDATORS));
  const validateOn = new Set<ValidationTrigger>(options.validateOn ?? ['blur', 'submit']);
  let initialValue = String(options.initialValue ?? '').slice(0, maxLength);
  let value = initialValue;
  let touched = false;
  let focused = false;
  let disabled = Boolean(options.disabled);
  let readOnly = Boolean(options.readOnly);
  let status: FieldStatus = 'idle';
  let issues: readonly FieldIssue[] = Object.freeze([]);
  let revision = 0;
  let disposed = false;
  let validationSequence = 0;
  let controller: AbortController | null = null;

  const snapshot = (): FormFieldState => {
    const error = issues.find((issue) => issue.severity === 'error')?.message ?? null;
    const warning = issues.find((issue) => issue.severity === 'warning')?.message ?? null;
    const describedBy: string[] = [];
    if (error) describedBy.push(`${id}-error`);
    else if (warning) describedBy.push(`${id}-warning`);
    return Object.freeze({
      id,
      label,
      value,
      initialValue,
      dirty: value !== initialValue,
      touched,
      focused,
      disabled,
      readOnly,
      required: Boolean(options.required),
      status,
      issues,
      errorMessage: error,
      warningMessage: warning,
      ariaInvalid: Boolean(error),
      ariaBusy: status === 'validating',
      describedBy: Object.freeze(describedBy),
      revision,
    });
  };

  const cancelValidation = (): void => {
    controller?.abort();
    controller = null;
    validationSequence += 1;
  };

  const requiredIssues = (): readonly FieldIssue[] => {
    if (!options.required || value.trim()) return Object.freeze([]);
    return Object.freeze([freezeIssue({ code: 'required', message: `${label} zorunludur.`, severity: 'error' })]);
  };

  const validate = async (trigger: ValidationTrigger = 'submit'): Promise<FormFieldState> => {
    if (disposed || disabled) return snapshot();
    cancelValidation();
    const sequence = validationSequence;
    const activeController = new AbortController();
    controller = activeController;
    status = 'validating';
    revision += 1;
    const groups: Array<readonly FieldIssue[]> = [requiredIssues()];
    try {
      for (const validator of validators) {
        if (activeController.signal.aborted || sequence !== validationSequence) return snapshot();
        const result = await validator({ value, signal: activeController.signal, trigger });
        if (activeController.signal.aborted || sequence !== validationSequence) return snapshot();
        groups.push(normalizeIssues(result));
      }
      issues = mergeIssues(groups);
      status = issues.some((issue) => issue.severity === 'error') ? 'invalid' : 'valid';
      revision += 1;
      return snapshot();
    } catch (error) {
      if (activeController.signal.aborted || sequence !== validationSequence) return snapshot();
      issues = mergeIssues([groups.flat(), normalizeIssues({ code: 'validation-failed', message: error instanceof Error ? error.message : 'Doğrulama tamamlanamadı.', severity: 'error' })]);
      status = 'invalid';
      revision += 1;
      return snapshot();
    } finally {
      if (controller === activeController) controller = null;
    }
  };

  const setValue = async (nextValue: string): Promise<FormFieldState> => {
    if (disposed || disabled || readOnly) return snapshot();
    const normalized = String(nextValue ?? '').slice(0, maxLength);
    if (normalized === value) return snapshot();
    cancelValidation();
    value = normalized;
    status = 'idle';
    issues = Object.freeze([]);
    revision += 1;
    if (validateOn.has('change')) return validate('change');
    return snapshot();
  };

  const focus = (): FormFieldState => {
    if (disposed || disabled || focused) return snapshot();
    focused = true;
    revision += 1;
    return snapshot();
  };

  const blur = async (): Promise<FormFieldState> => {
    if (disposed || disabled) return snapshot();
    if (focused) {
      focused = false;
      touched = true;
      revision += 1;
    }
    if (validateOn.has('blur')) return validate('blur');
    return snapshot();
  };

  const reset = (nextValue?: string): FormFieldState => {
    cancelValidation();
    initialValue = String(nextValue ?? options.initialValue ?? '').slice(0, maxLength);
    value = initialValue;
    touched = false;
    focused = false;
    issues = Object.freeze([]);
    status = 'idle';
    revision += 1;
    return snapshot();
  };

  const setDisabled = (nextDisabled: boolean): FormFieldState => {
    const normalized = Boolean(nextDisabled);
    if (disabled === normalized) return snapshot();
    disabled = normalized;
    if (disabled) {
      cancelValidation();
      focused = false;
      issues = Object.freeze([]);
      status = 'idle';
    }
    revision += 1;
    return snapshot();
  };

  const setReadOnly = (nextReadOnly: boolean): FormFieldState => {
    const normalized = Boolean(nextReadOnly);
    if (readOnly === normalized) return snapshot();
    readOnly = normalized;
    revision += 1;
    return snapshot();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelValidation();
    focused = false;
  };

  return Object.freeze({ getState: snapshot, setValue, focus, blur, validate, reset, setDisabled, setReadOnly, dispose });
};
