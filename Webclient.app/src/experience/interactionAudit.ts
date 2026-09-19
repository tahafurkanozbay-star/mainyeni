export type InteractionIssueKind =
    | "tiny-touch-target"
    | "missing-focus-indicator"
    | "pointer-only-action"
    | "nested-interactive"
    | "disabled-but-focusable"
    | "invalid-aria-expanded"
    | "invalid-aria-controls"
    | "invalid-tab-contract"
    | "invalid-current-contract"
    | "unannounced-live-region"
    | "autofocus"
    | "motion-without-opt-out";

export interface InteractionIssue {
    kind: InteractionIssueKind;
    element: HTMLElement;
    message: string;
    severity: "error" | "warning";
}

export interface InteractionAuditOptions {
    minimumTouchSize?: number;
    inspectGeometry?: boolean;
    inspectComputedStyle?: boolean;
    reducedMotion?: boolean;
}

export interface InteractionAuditResult {
    issues: InteractionIssue[];
    counts: Record<InteractionIssueKind, number>;
    errors: number;
    warnings: number;
}

const interactiveSelector = [
    "button",
    "a[href]",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[role='link']",
    "[role='tab']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='menuitem']",
    "[tabindex]"
].join(",");

const emptyCounts = (): Record<InteractionIssueKind, number> => ({
    "tiny-touch-target": 0,
    "missing-focus-indicator": 0,
    "pointer-only-action": 0,
    "nested-interactive": 0,
    "disabled-but-focusable": 0,
    "invalid-aria-expanded": 0,
    "invalid-aria-controls": 0,
    "invalid-tab-contract": 0,
    "invalid-current-contract": 0,
    "unannounced-live-region": 0,
    autofocus: 0,
    "motion-without-opt-out": 0
});

const normalize = (value: string | null | undefined): string => String(value ?? "").trim();

function isDisabled(element: HTMLElement): boolean {
    if (element.getAttribute("aria-disabled") === "true") return true;
    return "disabled" in element && Boolean((element as HTMLButtonElement).disabled);
}

function isNaturallyFocusable(element: HTMLElement): boolean {
    if (element instanceof HTMLAnchorElement) return element.hasAttribute("href");
    return element instanceof HTMLButtonElement || element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ||
        element instanceof HTMLDetailsElement;
}

function isFocusable(element: HTMLElement): boolean {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const tabIndex = element.getAttribute("tabindex");
    if (tabIndex !== null) return Number(tabIndex) >= 0;
    return isNaturallyFocusable(element) && !isDisabled(element);
}

function push(
    issues: InteractionIssue[],
    kind: InteractionIssueKind,
    element: HTMLElement,
    message: string,
    severity: InteractionIssue["severity"] = "error"
): void {
    issues.push({ kind, element, message, severity });
}

function inspectTouchTarget(element: HTMLElement, minimum: number, issues: InteractionIssue[]): void {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rect.width < minimum || rect.height < minimum) {
        push(issues, "tiny-touch-target", element,
            `Dokunma hedefi ${Math.round(rect.width)}×${Math.round(rect.height)}px; en az ${minimum}×${minimum}px olmalı.`, "warning");
    }
}

function inspectFocusStyle(element: HTMLElement, issues: InteractionIssue[]): void {
    if (!isFocusable(element) || typeof getComputedStyle !== "function") return;
    const style = getComputedStyle(element);
    const outlineInvisible = style.outlineStyle === "none" || style.outlineWidth === "0px";
    const shadowInvisible = !style.boxShadow || style.boxShadow === "none";
    if (outlineInvisible && shadowInvisible && element.dataset.focusVisibleGuard !== "true") {
        push(issues, "missing-focus-indicator", element,
            "Klavye odağı için görünür outline/box-shadow veya focus-visible guard bulunamadı.", "warning");
    }
}

function inspectPointerContract(element: HTMLElement, issues: InteractionIssue[]): void {
    const hasPointer = element.hasAttribute("onclick") || element.hasAttribute("onpointerdown") ||
        element.hasAttribute("onmousedown") || element.dataset.pointerAction === "true";
    if (!hasPointer) return;
    if (!isNaturallyFocusable(element) && !element.hasAttribute("role") && !element.hasAttribute("tabindex")) {
        push(issues, "pointer-only-action", element,
            "Pointer eylemi semantik kontrol, rol veya klavye odağı olmadan tanımlanmış.");
    }
}

function inspectNestedInteractive(element: HTMLElement, issues: InteractionIssue[]): void {
    if (!element.matches(interactiveSelector)) return;
    const descendant = element.querySelector<HTMLElement>(interactiveSelector);
    if (descendant) {
        push(issues, "nested-interactive", descendant,
            "Etkileşimli kontrol başka bir etkileşimli kontrolün içine yerleştirilmiş.");
    }
}

function inspectDisabledContract(element: HTMLElement, issues: InteractionIssue[]): void {
    if (!isDisabled(element)) return;
    if (element.getAttribute("aria-disabled") === "true" && isFocusable(element) && element.dataset.allowDisabledFocus !== "true") {
        push(issues, "disabled-but-focusable", element,
            "aria-disabled kontrol tab sırasından çıkarılmalı veya bilinçli odak davranışı işaretlenmeli.", "warning");
    }
}

function inspectExpandedContract(element: HTMLElement, root: ParentNode, issues: InteractionIssue[]): void {
    const expanded = element.getAttribute("aria-expanded");
    if (expanded === null) return;
    if (expanded !== "true" && expanded !== "false") {
        push(issues, "invalid-aria-expanded", element, "aria-expanded yalnız true veya false olabilir.");
    }
    const controls = normalize(element.getAttribute("aria-controls"));
    if (!controls) return;
    const doc = element.ownerDocument;
    for (const id of controls.split(/\s+/)) {
        const target = doc.getElementById(id);
        if (!target || (root instanceof Element && !root.contains(target))) {
            push(issues, "invalid-aria-controls", element, `aria-controls hedefi bulunamadı: ${id}`);
        }
    }
}

function inspectTabContract(element: HTMLElement, issues: InteractionIssue[]): void {
    if (element.getAttribute("role") !== "tab") return;
    const selected = element.getAttribute("aria-selected");
    if (selected !== "true" && selected !== "false") {
        push(issues, "invalid-tab-contract", element, "Tab kontrolü aria-selected=true|false sağlamalı.");
    }
    const controls = normalize(element.getAttribute("aria-controls"));
    if (!controls || !element.ownerDocument.getElementById(controls)) {
        push(issues, "invalid-tab-contract", element, "Tab kontrolü mevcut bir tabpanel için aria-controls sağlamalı.");
    }
}

function inspectCurrentContract(element: HTMLElement, issues: InteractionIssue[]): void {
    const current = element.getAttribute("aria-current");
    if (current === null) return;
    const allowed = new Set(["page", "step", "location", "date", "time", "true", "false"]);
    if (!allowed.has(current)) {
        push(issues, "invalid-current-contract", element, `Geçersiz aria-current değeri: ${current}`);
    }
}

function inspectLiveRegion(element: HTMLElement, issues: InteractionIssue[]): void {
    if (element.dataset.dynamicStatus !== "true") return;
    const role = element.getAttribute("role");
    const live = element.getAttribute("aria-live");
    if (role !== "status" && role !== "alert" && live !== "polite" && live !== "assertive") {
        push(issues, "unannounced-live-region", element,
            "Dinamik durum mesajı role=status/alert veya aria-live ile duyurulmalı.");
    }
}

function inspectAutofocus(element: HTMLElement, issues: InteractionIssue[]): void {
    if (element.hasAttribute("autofocus")) {
        push(issues, "autofocus", element,
            "autofocus beklenmedik odak sıçramasına yol açabilir; kontrollü focus yönetimi kullanın.", "warning");
    }
}

function inspectMotion(element: HTMLElement, reducedMotion: boolean, issues: InteractionIssue[]): void {
    if (!element.dataset.motion || reducedMotion) return;
    if (element.dataset.reducedMotion !== "supported") {
        push(issues, "motion-without-opt-out", element,
            "Hareketli deneyim prefers-reduced-motion için kapatma/sadeleştirme sözleşmesi sağlamalı.", "warning");
    }
}

export function auditInteractionQuality(
    root: ParentNode = document,
    options: InteractionAuditOptions = {}
): InteractionAuditResult {
    const issues: InteractionIssue[] = [];
    const minimum = Math.max(24, options.minimumTouchSize ?? 44);
    const elements = Array.from(root.querySelectorAll<HTMLElement>("*"));

    for (const element of elements) {
        inspectPointerContract(element, issues);
        inspectNestedInteractive(element, issues);
        inspectDisabledContract(element, issues);
        inspectExpandedContract(element, root, issues);
        inspectTabContract(element, issues);
        inspectCurrentContract(element, issues);
        inspectLiveRegion(element, issues);
        inspectAutofocus(element, issues);
        inspectMotion(element, options.reducedMotion ?? false, issues);
        if (options.inspectGeometry && element.matches(interactiveSelector)) inspectTouchTarget(element, minimum, issues);
        if (options.inspectComputedStyle && element.matches(interactiveSelector)) inspectFocusStyle(element, issues);
    }

    const counts = emptyCounts();
    let errors = 0;
    let warnings = 0;
    for (const issue of issues) {
        counts[issue.kind] += 1;
        if (issue.severity === "error") errors += 1;
        else warnings += 1;
    }
    return { issues, counts, errors, warnings };
}

export function formatInteractionAudit(result: InteractionAuditResult): string {
    if (!result.issues.length) return "Etkileşim denetimi sorun bulmadı.";
    const summary = Object.entries(result.counts)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${kind}: ${count}`)
        .join(", ");
    return `Etkileşim denetimi ${result.errors} hata, ${result.warnings} uyarı buldu (${summary}).`;
}
