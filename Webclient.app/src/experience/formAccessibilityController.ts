import type { FormValidationModel, FormValidationSnapshot } from './formValidationModel';

export type FormFieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface FormAccessibilityField {
  readonly id: string;
  readonly element: FormFieldElement;
  readonly errorElement?: HTMLElement;
  readonly hintElement?: HTMLElement;
}

export interface FormAccessibilityControllerOptions {
  readonly form: HTMLFormElement;
  readonly model: FormValidationModel;
  readonly fields: readonly FormAccessibilityField[];
  readonly summary?: HTMLElement;
  readonly status?: HTMLElement;
  readonly focusInvalidOnSubmit?: boolean;
  readonly onSubmit?: () => void | Promise<void>;
  readonly onObserverError?: (error: unknown) => void;
}

export interface FormAccessibilitySnapshot {
  readonly invalidFieldIds: readonly string[];
  readonly validatingFieldIds: readonly string[];
  readonly touchedFieldIds: readonly string[];
  readonly dirtyFieldIds: readonly string[];
  readonly valid: boolean;
  readonly submitting: boolean;
  readonly announcement: string;
}

type Listener = (snapshot: FormAccessibilitySnapshot) => void;

const attributeTokens = (value: string | null): string[] =>
  value?.split(/\s+/u).map((token) => token.trim()).filter(Boolean) ?? [];

const setToken = (element: Element, attribute: string, token: string, enabled: boolean): void => {
  const next = new Set(attributeTokens(element.getAttribute(attribute)));
  if (enabled) next.add(token);
  else next.delete(token);
  if (next.size === 0) element.removeAttribute(attribute);
  else element.setAttribute(attribute, [...next].join(' '));
};

const renderField = (field: FormAccessibilityField, state: FormValidationSnapshot): void => {
  const fieldState = state.fields[field.id];
  const showError = fieldState?.touched === true && fieldState.issue !== null;
  field.element.setAttribute('aria-invalid', showError ? 'true' : 'false');
  if (!field.errorElement) return;
  field.errorElement.textContent = showError ? fieldState?.issue?.message ?? '' : '';
  field.errorElement.hidden = !showError;
  if (field.errorElement.id) setToken(field.element, 'aria-describedby', field.errorElement.id, showError);
};

export class FormAccessibilityController {
  readonly #form: HTMLFormElement;
  readonly #model: FormValidationModel;
  readonly #fields: readonly FormAccessibilityField[];
  readonly #summary: HTMLElement | undefined;
  readonly #status: HTMLElement | undefined;
  readonly #focusInvalidOnSubmit: boolean;
  readonly #onSubmit: (() => void | Promise<void>) | undefined;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #listeners = new Set<Listener>();
  readonly #cleanup: Array<() => void> = [];
  #disposed = false;
  #announcement = '';

  constructor(options: FormAccessibilityControllerOptions) {
    this.#form = options.form;
    this.#model = options.model;
    this.#fields = options.fields;
    this.#summary = options.summary;
    this.#status = options.status;
    this.#focusInvalidOnSubmit = options.focusInvalidOnSubmit ?? true;
    this.#onSubmit = options.onSubmit;
    this.#onObserverError = options.onObserverError;
    this.#form.noValidate = true;
    this.#bindFields();
    this.#bindSubmit();
    this.#cleanup.push(this.#model.subscribe(() => this.#render()));
    this.#render();
  }

  snapshot(): FormAccessibilitySnapshot {
    const state = this.#model.snapshot();
    const validatingFieldIds = this.#fields.filter(({ id }) => state.fields[id]?.status === 'validating').map(({ id }) => id);
    const touchedFieldIds = this.#fields.filter(({ id }) => state.fields[id]?.touched === true).map(({ id }) => id);
    const dirtyFieldIds = this.#fields.filter(({ id }) => state.fields[id]?.dirty === true).map(({ id }) => id);
    return Object.freeze({
      invalidFieldIds: Object.freeze([...state.invalidFieldIds]),
      validatingFieldIds: Object.freeze(validatingFieldIds),
      touchedFieldIds: Object.freeze(touchedFieldIds),
      dirtyFieldIds: Object.freeze(dirtyFieldIds),
      valid: state.valid,
      submitting: state.submitting,
      announcement: this.#announcement || state.announcement,
    });
  }

  subscribe(listener: Listener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    this.#notifyListener(listener);
    return () => this.#listeners.delete(listener);
  }

  async validateAll(options: { focusFirstInvalid?: boolean } = {}): Promise<boolean> {
    this.#assertActive();
    const valid = await this.#model.validateAll();
    if (!valid && (options.focusFirstInvalid ?? false)) this.focusFirstInvalid();
    return valid;
  }

  focusFirstInvalid(): boolean {
    this.#assertActive();
    const id = this.#model.snapshot().firstInvalidFieldId;
    const field = id ? this.#fields.find((candidate) => candidate.id === id) : undefined;
    if (!field) return false;
    field.element.focus({ preventScroll: false });
    return true;
  }

  announce(message: string): void {
    this.#assertActive();
    this.#announcement = message.trim();
    if (this.#status) {
      this.#status.setAttribute('role', 'status');
      this.#status.setAttribute('aria-live', 'polite');
      this.#status.setAttribute('aria-atomic', 'true');
      this.#status.textContent = this.#announcement;
    }
    this.#emit();
  }

  reset(): void {
    this.#assertActive();
    this.#announcement = '';
    this.#model.reset();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
    this.#listeners.clear();
    this.#form.removeAttribute('aria-busy');
    for (const field of this.#fields) {
      field.element.removeAttribute('aria-invalid');
      if (field.errorElement?.id) setToken(field.element, 'aria-describedby', field.errorElement.id, false);
      if (field.hintElement?.id) setToken(field.element, 'aria-describedby', field.hintElement.id, false);
    }
  }

  #bindFields(): void {
    for (const field of this.#fields) {
      if (field.hintElement?.id) setToken(field.element, 'aria-describedby', field.hintElement.id, true);
      const onInput = (): void => {
        if (!this.#disposed) this.#model.setValue(field.id, field.element.value);
      };
      const onBlur = (): void => {
        if (!this.#disposed) void this.#model.blur(field.id);
      };
      field.element.addEventListener('input', onInput);
      field.element.addEventListener('change', onInput);
      field.element.addEventListener('blur', onBlur);
      this.#cleanup.push(() => {
        field.element.removeEventListener('input', onInput);
        field.element.removeEventListener('change', onInput);
        field.element.removeEventListener('blur', onBlur);
      });
    }
  }

  #bindSubmit(): void {
    const onSubmit = (event: SubmitEvent): void => {
      if (this.#disposed) return;
      event.preventDefault();
      void this.#handleSubmit();
    };
    this.#form.addEventListener('submit', onSubmit);
    this.#cleanup.push(() => this.#form.removeEventListener('submit', onSubmit));
  }

  async #handleSubmit(): Promise<void> {
    const accepted = await this.#model.beginSubmit();
    if (this.#disposed) return;
    if (!accepted) {
      if (this.#focusInvalidOnSubmit) this.focusFirstInvalid();
      const count = this.#model.snapshot().invalidFieldIds.length;
      this.announce(count === 1 ? 'Formda düzeltilmesi gereken 1 alan var.' : `Formda düzeltilmesi gereken ${count} alan var.`);
      return;
    }

    try {
      await this.#onSubmit?.();
      if (!this.#disposed) this.announce('Form doğrulandı ve gönderim tamamlandı.');
    } catch (error) {
      this.#report(error);
      if (!this.#disposed) this.announce('Form gönderilemedi. Lütfen tekrar deneyin.');
    } finally {
      if (!this.#disposed) this.#model.endSubmit();
    }
  }

  #render(): void {
    if (this.#disposed) return;
    const state = this.#model.snapshot();
    this.#form.setAttribute('aria-busy', String(state.submitting || this.#hasValidatingField(state)));
    for (const field of this.#fields) renderField(field, state);
    this.#renderSummary(state);
    this.#emit();
  }

  #renderSummary(state: FormValidationSnapshot): void {
    if (!this.#summary) return;
    const count = state.invalidFieldIds.length;
    this.#summary.hidden = count === 0;
    this.#summary.setAttribute('role', count > 0 ? 'alert' : 'status');
    this.#summary.textContent = count === 0 ? '' : count === 1
      ? '1 alanın düzeltilmesi gerekiyor.'
      : `${count} alanın düzeltilmesi gerekiyor.`;
  }

  #hasValidatingField(state: FormValidationSnapshot): boolean {
    return this.#fields.some(({ id }) => state.fields[id]?.status === 'validating');
  }

  #emit(): void {
    for (const listener of this.#listeners) this.#notifyListener(listener);
  }

  #notifyListener(listener: Listener): void {
    try {
      listener(this.snapshot());
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    if (!this.#onObserverError) return;
    try {
      this.#onObserverError(error);
    } catch (reportingError) {
      // Diagnostics are best-effort; the secondary reporter failure must not break form interaction.
      void reportingError;
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('FormAccessibilityController dispose edildikten sonra kullanılamaz.');
  }
}

export const createFormAccessibilityController = (
  options: FormAccessibilityControllerOptions,
): FormAccessibilityController => new FormAccessibilityController(options);
