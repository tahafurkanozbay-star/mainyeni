import type { FormValidationModel } from './formValidationModel';

export type FormFieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface FormAccessibilityField {
  readonly name: string;
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
  readonly validateOnBlur?: boolean;
  readonly validateOnChange?: boolean;
}

export interface FormAccessibilitySnapshot {
  readonly invalidFields: readonly string[];
  readonly pendingFields: readonly string[];
  readonly touchedFields: readonly string[];
  readonly dirtyFields: readonly string[];
  readonly canSubmit: boolean;
  readonly announcement: string;
}

type Listener = (snapshot: FormAccessibilitySnapshot) => void;

function tokens(value: string | null): string[] {
  return value?.split(/\s+/u).map((token) => token.trim()).filter(Boolean) ?? [];
}

function setToken(element: Element, attribute: string, token: string, enabled: boolean): void {
  const next = new Set(tokens(element.getAttribute(attribute)));
  if (enabled) next.add(token);
  else next.delete(token);
  if (next.size === 0) element.removeAttribute(attribute);
  else element.setAttribute(attribute, [...next].join(' '));
}

function safeFocus(element: HTMLElement): void {
  try {
    element.focus({ preventScroll: false });
  } catch {
    // Focus is progressive enhancement; validation state remains authoritative.
  }
}

export class FormAccessibilityController {
  readonly #form: HTMLFormElement;
  readonly #model: FormValidationModel;
  readonly #fields: readonly FormAccessibilityField[];
  readonly #summary?: HTMLElement;
  readonly #status?: HTMLElement;
  readonly #focusInvalidOnSubmit: boolean;
  readonly #validateOnBlur: boolean;
  readonly #validateOnChange: boolean;
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
    this.#validateOnBlur = options.validateOnBlur ?? true;
    this.#validateOnChange = options.validateOnChange ?? false;

    this.#form.noValidate = true;
    this.#form.setAttribute('aria-busy', 'false');
    this.#bindFields();
    this.#bindSubmit();
    this.#render();
  }

  subscribe(listener: Listener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  snapshot(): FormAccessibilitySnapshot {
    const state = this.#model.snapshot();
    const invalidFields = this.#fields
      .filter(({ name }) => (state.fields[name]?.errors.length ?? 0) > 0)
      .map(({ name }) => name);
    const pendingFields = this.#fields
      .filter(({ name }) => state.fields[name]?.pending === true)
      .map(({ name }) => name);
    const touchedFields = this.#fields
      .filter(({ name }) => state.fields[name]?.touched === true)
      .map(({ name }) => name);
    const dirtyFields = this.#fields
      .filter(({ name }) => state.fields[name]?.dirty === true)
      .map(({ name }) => name);
    return Object.freeze({
      invalidFields: Object.freeze(invalidFields),
      pendingFields: Object.freeze(pendingFields),
      touchedFields: Object.freeze(touchedFields),
      dirtyFields: Object.freeze(dirtyFields),
      canSubmit: state.canSubmit,
      announcement: this.#announcement,
    });
  }

  async validateAll(options: { focusFirstInvalid?: boolean } = {}): Promise<boolean> {
    this.#assertActive();
    await this.#model.validateAll();
    this.#render();
    const snapshot = this.snapshot();
    const valid = snapshot.invalidFields.length === 0 && snapshot.pendingFields.length === 0;
    if (!valid && (options.focusFirstInvalid ?? false)) this.focusFirstInvalid();
    return valid;
  }

  focusFirstInvalid(): boolean {
    this.#assertActive();
    const invalid = new Set(this.snapshot().invalidFields);
    const field = this.#fields.find(({ name }) => invalid.has(name));
    if (!field) return false;
    safeFocus(field.element);
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
    this.#model.reset();
    this.#announcement = '';
    this.#render();
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
        if (this.#disposed) return;
        this.#model.setValue(field.name, field.element.value);
        if (this.#validateOnChange) void this.#validateField(field.name);
        else this.#render();
      };
      const onBlur = (): void => {
        if (this.#disposed) return;
        this.#model.touch(field.name);
        if (this.#validateOnBlur) void this.#validateField(field.name);
        else this.#render();
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
    const valid = await this.validateAll({ focusFirstInvalid: this.#focusInvalidOnSubmit });
    if (!valid) {
      const count = this.snapshot().invalidFields.length;
      this.announce(count === 1 ? 'Formda düzeltilmesi gereken 1 alan var.' : `Formda düzeltilmesi gereken ${count} alan var.`);
      return;
    }
    this.announce('Form doğrulandı ve gönderime hazır.');
  }

  async #validateField(name: string): Promise<void> {
    try {
      await this.#model.validateField(name);
    } finally {
      if (!this.#disposed) this.#render();
    }
  }

  #render(): void {
    if (this.#disposed) return;
    const state = this.#model.snapshot();
    const pending = this.#fields.some(({ name }) => state.fields[name]?.pending === true);
    this.#form.setAttribute('aria-busy', String(pending));

    for (const field of this.#fields) {
      const fieldState = state.fields[field.name];
      const errors = fieldState?.errors ?? [];
      const showError = fieldState?.touched === true && errors.length > 0;
      field.element.setAttribute('aria-invalid', showError ? 'true' : 'false');
      if (field.errorElement) {
        field.errorElement.textContent = showError ? errors[0] ?? '' : '';
        field.errorElement.hidden = !showError;
        if (field.errorElement.id) setToken(field.element, 'aria-describedby', field.errorElement.id, showError);
      }
    }

    if (this.#summary) {
      const invalid = this.#fields.filter(({ name }) => (state.fields[name]?.errors.length ?? 0) > 0);
      this.#summary.hidden = invalid.length === 0;
      this.#summary.setAttribute('role', invalid.length > 0 ? 'alert' : 'status');
      this.#summary.textContent = invalid.length === 0 ? '' : invalid.length === 1
        ? '1 alanın düzeltilmesi gerekiyor.'
        : `${invalid.length} alanın düzeltilmesi gerekiyor.`;
    }
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // One observer must never break form interaction for other observers.
      }
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('FormAccessibilityController has been disposed.');
  }
}

export function createFormAccessibilityController(options: FormAccessibilityControllerOptions): FormAccessibilityController {
  return new FormAccessibilityController(options);
}
