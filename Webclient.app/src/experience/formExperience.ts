export type FieldValidationState = "idle" | "validating" | "valid" | "invalid";

export interface FieldIssue {
    code: string;
    message: string;
}

export interface FieldExperienceConfig {
    id: string;
    control: HTMLElement;
    label?: HTMLElement | null;
    hint?: HTMLElement | null;
    error?: HTMLElement | null;
    required?: boolean;
    validate?: (value: string, signal: AbortSignal) => FieldIssue | readonly FieldIssue[] | null | Promise<FieldIssue | readonly FieldIssue[] | null>;
}

export interface FieldExperienceSnapshot {
    id: string;
    state: FieldValidationState;
    value: string;
    dirty: boolean;
    touched: boolean;
    issues: readonly FieldIssue[];
}

export interface FormExperienceSnapshot {
    valid: boolean;
    validating: boolean;
    dirty: boolean;
    fields: readonly FieldExperienceSnapshot[];
}

export interface FormExperienceOptions {
    form: HTMLFormElement;
    summary?: HTMLElement | null;
    liveRegion?: HTMLElement | null;
    focusFirstInvalid?: boolean;
    onChange?: (snapshot: FormExperienceSnapshot) => void;
}

interface FieldRuntime {
    config: FieldExperienceConfig;
    state: FieldValidationState;
    dirty: boolean;
    touched: boolean;
    issues: FieldIssue[];
    controller: AbortController | null;
    version: number;
}

const readValue = (control: HTMLElement): string => {
    if (control instanceof HTMLInputElement) {
        if (control.type === "checkbox" || control.type === "radio") return control.checked ? control.value || "true" : "";
        return control.value;
    }
    if (control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) return control.value;
    return control.getAttribute("data-value") ?? control.textContent ?? "";
};

const normalizeIssues = (value: FieldIssue | readonly FieldIssue[] | null | undefined): FieldIssue[] => {
    if (!value) return [];
    return (Array.isArray(value) ? value : [value]).map((issue) => ({ code: issue.code, message: issue.message.trim() })).filter((issue) => issue.message);
};

const joinIds = (...ids: Array<string | null | undefined>): string => [...new Set(ids.filter((id): id is string => Boolean(id?.trim())).map((id) => id.trim()))].join(" ");

export class FormExperience {
    private readonly form: HTMLFormElement;
    private readonly summary: HTMLElement | null;
    private readonly liveRegion: HTMLElement | null;
    private readonly focusFirstInvalid: boolean;
    private readonly onChange: ((snapshot: FormExperienceSnapshot) => void) | undefined;
    private readonly fields = new Map<string, FieldRuntime>();
    private destroyed = false;

    constructor(options: FormExperienceOptions) {
        this.form = options.form;
        this.summary = options.summary ?? null;
        this.liveRegion = options.liveRegion ?? null;
        this.focusFirstInvalid = options.focusFirstInvalid !== false;
        this.onChange = options.onChange;
        this.form.addEventListener("submit", this.onSubmit);
        if (this.summary) {
            this.summary.setAttribute("role", "alert");
            this.summary.setAttribute("tabindex", "-1");
        }
        if (this.liveRegion) {
            this.liveRegion.setAttribute("aria-live", "polite");
            this.liveRegion.setAttribute("aria-atomic", "true");
        }
    }

    register(config: FieldExperienceConfig): () => void {
        this.assertActive();
        const id = config.id.trim();
        if (!id) throw new Error("Form field id boş olamaz.");
        if (this.fields.has(id)) throw new Error(`Form field zaten kayıtlı: ${id}`);
        const runtime: FieldRuntime = { config: { ...config, id }, state: "idle", dirty: false, touched: false, issues: [], controller: null, version: 0 };
        this.fields.set(id, runtime);
        this.prepare(runtime);
        config.control.addEventListener("input", this.onInput);
        config.control.addEventListener("change", this.onInput);
        config.control.addEventListener("blur", this.onBlur, true);
        this.emit();
        return () => this.unregister(id);
    }

    unregister(id: string): void {
        const runtime = this.fields.get(id);
        if (!runtime) return;
        runtime.controller?.abort();
        runtime.config.control.removeEventListener("input", this.onInput);
        runtime.config.control.removeEventListener("change", this.onInput);
        runtime.config.control.removeEventListener("blur", this.onBlur, true);
        this.fields.delete(id);
        this.emit();
    }

    async validate(id?: string): Promise<FormExperienceSnapshot> {
        this.assertActive();
        const targets = id ? [this.fields.get(id)].filter((field): field is FieldRuntime => Boolean(field)) : [...this.fields.values()];
        await Promise.all(targets.map((field) => this.validateField(field)));
        this.renderSummary();
        this.emit();
        return this.snapshot();
    }

    setIssues(id: string, issues: FieldIssue | readonly FieldIssue[] | null): void {
        const runtime = this.fields.get(id);
        if (!runtime) return;
        runtime.controller?.abort();
        runtime.controller = null;
        runtime.issues = normalizeIssues(issues);
        runtime.state = runtime.issues.length ? "invalid" : "valid";
        this.renderField(runtime);
        this.renderSummary();
        this.emit();
    }

    snapshot(): FormExperienceSnapshot {
        const fields = [...this.fields.values()].map((runtime): FieldExperienceSnapshot => Object.freeze({
            id: runtime.config.id,
            state: runtime.state,
            value: readValue(runtime.config.control),
            dirty: runtime.dirty,
            touched: runtime.touched,
            issues: Object.freeze(runtime.issues.map((issue) => Object.freeze({ ...issue })))
        }));
        return Object.freeze({
            valid: fields.every((field) => field.state !== "invalid"),
            validating: fields.some((field) => field.state === "validating"),
            dirty: fields.some((field) => field.dirty),
            fields: Object.freeze(fields)
        });
    }

    reset(): void {
        for (const runtime of this.fields.values()) {
            runtime.controller?.abort();
            runtime.controller = null;
            runtime.state = "idle";
            runtime.dirty = false;
            runtime.touched = false;
            runtime.issues = [];
            this.renderField(runtime);
        }
        if (this.summary) this.summary.replaceChildren();
        if (this.liveRegion) this.liveRegion.textContent = "";
        this.emit();
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.form.removeEventListener("submit", this.onSubmit);
        for (const id of this.fields.keys()) this.unregister(id);
    }

    private prepare(runtime: FieldRuntime): void {
        const { config } = runtime;
        if (!config.control.id) config.control.id = config.id;
        if (config.label) {
            if (config.label instanceof HTMLLabelElement) config.label.htmlFor = config.control.id;
            else if (!config.control.hasAttribute("aria-labelledby")) {
                if (!config.label.id) config.label.id = `${config.id}-label`;
                config.control.setAttribute("aria-labelledby", config.label.id);
            }
        }
        if (config.required) config.control.setAttribute("aria-required", "true");
        this.renderField(runtime);
    }

    private async validateField(runtime: FieldRuntime): Promise<void> {
        runtime.controller?.abort();
        const controller = new AbortController();
        runtime.controller = controller;
        const version = ++runtime.version;
        const value = readValue(runtime.config.control).trim();
        if (runtime.config.required && !value) {
            runtime.issues = [{ code: "required", message: "Bu alan zorunludur." }];
            runtime.state = "invalid";
            this.renderField(runtime);
            return;
        }
        if (!runtime.config.validate) {
            runtime.issues = [];
            runtime.state = "valid";
            this.renderField(runtime);
            return;
        }
        runtime.state = "validating";
        this.renderField(runtime);
        try {
            const result = await runtime.config.validate(value, controller.signal);
            if (controller.signal.aborted || runtime.version !== version) return;
            runtime.issues = normalizeIssues(result);
            runtime.state = runtime.issues.length ? "invalid" : "valid";
        } catch (error) {
            if (controller.signal.aborted || runtime.version !== version) return;
            runtime.issues = [{ code: "validation-error", message: error instanceof Error ? error.message : "Doğrulama tamamlanamadı." }];
            runtime.state = "invalid";
        } finally {
            if (runtime.version === version) runtime.controller = null;
            this.renderField(runtime);
        }
    }

    private renderField(runtime: FieldRuntime): void {
        const { config } = runtime;
        const invalid = runtime.state === "invalid";
        config.control.setAttribute("aria-invalid", invalid ? "true" : "false");
        config.control.setAttribute("aria-busy", runtime.state === "validating" ? "true" : "false");
        if (config.error) {
            if (!config.error.id) config.error.id = `${config.id}-error`;
            config.error.textContent = runtime.issues.map((issue) => issue.message).join(" ");
            config.error.hidden = !invalid;
        }
        const describedBy = joinIds(config.hint?.id, invalid ? config.error?.id : null);
        if (describedBy) config.control.setAttribute("aria-describedby", describedBy);
        else config.control.removeAttribute("aria-describedby");
    }

    private renderSummary(): void {
        const invalid = [...this.fields.values()].filter((field) => field.state === "invalid");
        if (this.summary) {
            this.summary.replaceChildren();
            if (invalid.length) {
                const heading = this.form.ownerDocument.createElement("p");
                heading.textContent = `${invalid.length} alanda düzeltme gerekiyor.`;
                const list = this.form.ownerDocument.createElement("ul");
                for (const field of invalid) {
                    const item = this.form.ownerDocument.createElement("li");
                    const button = this.form.ownerDocument.createElement("button");
                    button.type = "button";
                    button.textContent = field.issues[0]?.message ?? field.config.id;
                    button.addEventListener("click", () => field.config.control.focus(), { once: true });
                    item.append(button);
                    list.append(item);
                }
                this.summary.append(heading, list);
            }
        }
        if (this.liveRegion) this.liveRegion.textContent = invalid.length ? `${invalid.length} form hatası bulundu.` : "Form doğrulaması tamamlandı.";
    }

    private readonly onInput = (event: Event): void => {
        const runtime = [...this.fields.values()].find((field) => field.config.control === event.currentTarget);
        if (!runtime) return;
        runtime.dirty = true;
        if (runtime.state === "invalid") void this.validateField(runtime).then(() => { this.renderSummary(); this.emit(); });
        else this.emit();
    };

    private readonly onBlur = (event: Event): void => {
        const runtime = [...this.fields.values()].find((field) => field.config.control === event.currentTarget);
        if (!runtime) return;
        runtime.touched = true;
        void this.validateField(runtime).then(() => { this.renderSummary(); this.emit(); });
    };

    private readonly onSubmit = (event: SubmitEvent): void => {
        event.preventDefault();
        void this.validate().then((snapshot) => {
            if (!snapshot.valid && this.focusFirstInvalid) {
                const first = [...this.fields.values()].find((field) => field.state === "invalid");
                first?.config.control.focus();
                this.summary?.focus({ preventScroll: true });
            }
        });
    };

    private emit(): void {
        this.onChange?.(this.snapshot());
    }

    private assertActive(): void {
        if (this.destroyed) throw new Error("FormExperience destroy edildikten sonra kullanılamaz.");
    }
}

export const createFormExperience = (options: FormExperienceOptions): FormExperience => new FormExperience(options);
