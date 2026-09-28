export type FormValidationMode = 'change' | 'blur' | 'submit';
export type FormFieldStatus = 'idle' | 'validating' | 'valid' | 'invalid';

export interface FormValidationIssue {
  readonly code: string;
  readonly message: string;
}

export interface FormFieldDefinition<Value = unknown> {
  readonly id: string;
  readonly label: string;
  readonly required?: boolean;
  readonly validate?: (value: Value, signal: AbortSignal) => FormValidationIssue | null | Promise<FormValidationIssue | null>;
}

export interface FormFieldSnapshot<Value = unknown> {
  readonly id: string;
  readonly label: string;
  readonly value: Value;
  readonly required: boolean;
  readonly touched: boolean;
  readonly dirty: boolean;
  readonly status: FormFieldStatus;
  readonly issue: FormValidationIssue | null;
  readonly revision: number;
}

export interface FormValidationSnapshot {
  readonly fields: Readonly<Record<string, FormFieldSnapshot>>;
  readonly fieldOrder: readonly string[];
  readonly submitting: boolean;
  readonly submitCount: number;
  readonly valid: boolean;
  readonly invalidFieldIds: readonly string[];
  readonly firstInvalidFieldId: string | null;
  readonly announcement: string;
  readonly revision: number;
}

export interface FormValidationModelOptions {
  readonly mode?: FormValidationMode;
  readonly onObserverError?: (error: unknown) => void;
}

export interface FormValidationModel {
  snapshot(): FormValidationSnapshot;
  register<Value>(definition: FormFieldDefinition<Value>, initialValue: Value): () => void;
  setValue<Value>(id: string, value: Value): void;
  blur(id: string): Promise<boolean>;
  validate(id: string): Promise<boolean>;
  validateAll(): Promise<boolean>;
  beginSubmit(): Promise<boolean>;
  endSubmit(): void;
  reset(): void;
  subscribe(observer: (snapshot: FormValidationSnapshot) => void): () => void;
  dispose(): void;
}

interface MutableField {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly initialValue: unknown;
  readonly validate?: FormFieldDefinition['validate'];
  value: unknown;
  touched: boolean;
  dirty: boolean;
  status: FormFieldStatus;
  issue: FormValidationIssue | null;
  revision: number;
  validationGeneration: number;
  controller: AbortController | null;
}

const normalizeText = (value: string, fallback: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || fallback;
};

const normalizeId = (value: string): string => value.trim();

const sameValue = (left: unknown, right: unknown): boolean => Object.is(left, right);

const requiredIssue = (field: MutableField): FormValidationIssue | null => {
  if (!field.required) return null;
  const value = field.value;
  if (value == null) return { code: 'required', message: `${field.label} alanı zorunludur.` };
  if (typeof value === 'string' && value.trim().length === 0) {
    return { code: 'required', message: `${field.label} alanı zorunludur.` };
  }
  if (Array.isArray(value) && value.length === 0) {
    return { code: 'required', message: `${field.label} alanı zorunludur.` };
  }
  return null;
};

const freezeIssue = (issue: FormValidationIssue | null): FormValidationIssue | null =>
  issue ? Object.freeze({
    code: normalizeText(issue.code, 'invalid'),
    message: normalizeText(issue.message, 'Alan geçerli değil.'),
  }) : null;

export const createFormValidationModel = (
  options: FormValidationModelOptions = {},
): FormValidationModel => {
  const mode = options.mode ?? 'blur';
  const fields = new Map<string, MutableField>();
  const observers = new Set<(snapshot: FormValidationSnapshot) => void>();
  let revision = 0;
  let submitting = false;
  let submitCount = 0;
  let disposed = false;
  let announcement = '';

  const assertActive = (): void => {
    if (disposed) throw new Error('FormValidationModel dispose edildikten sonra kullanılamaz.');
  };

  const report = (error: unknown): void => {
    const reporter = options.onObserverError;
    if (!reporter) return;
    try {
      reporter(error);
    } catch (reportingError) {
      // Diagnostics are best-effort: mark the secondary reporter failure as intentionally handled.
      void reportingError;
    }
  };

  const fieldSnapshot = (field: MutableField): FormFieldSnapshot => Object.freeze({
    id: field.id,
    label: field.label,
    value: field.value,
    required: field.required,
    touched: field.touched,
    dirty: field.dirty,
    status: field.status,
    issue: field.issue,
    revision: field.revision,
  });

  const buildSnapshot = (): FormValidationSnapshot => {
    const entries = Array.from(fields.values());
    const invalidFieldIds = entries.filter((field) => field.status === 'invalid').map((field) => field.id);
    const record: Record<string, FormFieldSnapshot> = {};
    entries.forEach((field) => { record[field.id] = fieldSnapshot(field); });
    return Object.freeze({
      fields: Object.freeze(record),
      fieldOrder: Object.freeze(entries.map((field) => field.id)),
      submitting,
      submitCount,
      valid: invalidFieldIds.length === 0 && entries.every((field) => field.status !== 'validating'),
      invalidFieldIds: Object.freeze(invalidFieldIds),
      firstInvalidFieldId: invalidFieldIds[0] ?? null,
      announcement,
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

  const cancelValidation = (field: MutableField): void => {
    field.validationGeneration += 1;
    field.controller?.abort();
    field.controller = null;
  };

  const setResult = (field: MutableField, issue: FormValidationIssue | null): boolean => {
    field.issue = freezeIssue(issue);
    field.status = field.issue ? 'invalid' : 'valid';
    field.revision += 1;
    return field.issue === null;
  };

  const validateField = async (field: MutableField): Promise<boolean> => {
    cancelValidation(field);
    const generation = field.validationGeneration;
    const required = requiredIssue(field);
    if (required) {
      const valid = setResult(field, required);
      notify();
      return valid;
    }
    if (!field.validate) {
      const valid = setResult(field, null);
      notify();
      return valid;
    }

    const controller = new AbortController();
    field.controller = controller;
    field.status = 'validating';
    field.issue = null;
    field.revision += 1;
    notify();
    try {
      const issue = await field.validate(field.value, controller.signal);
      if (disposed || controller.signal.aborted || generation !== field.validationGeneration) return false;
      field.controller = null;
      const valid = setResult(field, issue);
      notify();
      return valid;
    } catch (error) {
      if (controller.signal.aborted || disposed || generation !== field.validationGeneration) return false;
      field.controller = null;
      report(error);
      const valid = setResult(field, {
        code: 'validation-unavailable',
        message: `${field.label} alanı şu anda doğrulanamadı. Lütfen tekrar deneyin.`,
      });
      notify();
      return valid;
    }
  };

  const fieldFor = (id: string): MutableField | null => fields.get(normalizeId(id)) ?? null;

  return {
    snapshot: buildSnapshot,
    register(definition, initialValue) {
      assertActive();
      const id = normalizeId(definition.id);
      if (!id) throw new Error('Form alanı kimliği boş olamaz.');
      if (fields.has(id)) throw new Error(`Form alanı zaten kayıtlı: ${id}`);
      const field: MutableField = {
        id,
        label: normalizeText(definition.label, id),
        required: definition.required === true,
        initialValue,
        ...(definition.validate ? { validate: definition.validate as FormFieldDefinition['validate'] } : {}),
        value: initialValue,
        touched: false,
        dirty: false,
        status: 'idle',
        issue: null,
        revision: 0,
        validationGeneration: 0,
        controller: null,
      };
      fields.set(id, field);
      notify();
      let registered = true;
      return () => {
        if (!registered || disposed) return;
        registered = false;
        const current = fields.get(id);
        if (current !== field) return;
        cancelValidation(field);
        fields.delete(id);
        notify();
      };
    },
    setValue(id, value) {
      assertActive();
      const field = fieldFor(id);
      if (!field || sameValue(field.value, value)) return;
      cancelValidation(field);
      field.value = value;
      field.dirty = !sameValue(value, field.initialValue);
      field.issue = null;
      field.status = 'idle';
      field.revision += 1;
      notify();
      if (mode === 'change') void validateField(field);
    },
    async blur(id) {
      assertActive();
      const field = fieldFor(id);
      if (!field) return true;
      if (!field.touched) {
        field.touched = true;
        field.revision += 1;
        notify();
      }
      if (mode === 'submit') return field.status !== 'invalid';
      return validateField(field);
    },
    async validate(id) {
      assertActive();
      const field = fieldFor(id);
      return field ? validateField(field) : true;
    },
    async validateAll() {
      assertActive();
      const results = await Promise.all(Array.from(fields.values(), (field) => validateField(field)));
      const invalidCount = results.filter((valid) => !valid).length;
      announcement = invalidCount === 0
        ? 'Form doğrulandı. Tüm alanlar geçerli.'
        : `${invalidCount} alanda düzeltme gerekiyor.`;
      notify();
      return invalidCount === 0;
    },
    async beginSubmit() {
      assertActive();
      if (submitting) return false;
      submitCount += 1;
      fields.forEach((field) => {
        if (!field.touched) {
          field.touched = true;
          field.revision += 1;
        }
      });
      const valid = await this.validateAll();
      if (!valid) return false;
      submitting = true;
      announcement = 'Form gönderiliyor.';
      notify();
      return true;
    },
    endSubmit() {
      assertActive();
      if (!submitting) return;
      submitting = false;
      announcement = 'Form gönderimi tamamlandı.';
      notify();
    },
    reset() {
      assertActive();
      fields.forEach((field) => {
        cancelValidation(field);
        field.value = field.initialValue;
        field.touched = false;
        field.dirty = false;
        field.status = 'idle';
        field.issue = null;
        field.revision += 1;
      });
      submitting = false;
      announcement = '';
      notify();
    },
    subscribe(observer) {
      assertActive();
      observers.add(observer);
      try { observer(buildSnapshot()); } catch (error) { report(error); }
      return () => observers.delete(observer);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      fields.forEach(cancelValidation);
      fields.clear();
      observers.clear();
    },
  };
};
