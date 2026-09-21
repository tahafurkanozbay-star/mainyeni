export type AccessibilityIssueKind =
    | "missing-accessible-name"
    | "invalid-positive-tabindex"
    | "interactive-aria-hidden"
    | "focusable-in-hidden-tree"
    | "dialog-without-name"
    | "image-without-alt"
    | "form-control-without-name"
    | "duplicate-id"
    | "broken-aria-reference"
    | "invalid-heading-order"
    | "empty-heading"
    | "invalid-live-region"
    | "invalid-current-value"
    | "invalid-expanded-control"
    | "invalid-selected-state"
    | "invalid-aria-boolean"
    | "invalid-role-state"
    | "invalid-tab-state"
    | "invalid-menuitem-state"
    | "invalid-progress-range"
    | "invalid-slider-range"
    | "invalid-required-state"
    | "invalid-modal-dialog"
    | "autofocus-control"
    | "invalid-target-size";

export interface AccessibilityIssue { kind: AccessibilityIssueKind; element: HTMLElement; message: string; }
export interface AccessibilityAuditResult { issues: AccessibilityIssue[]; counts: Record<AccessibilityIssueKind, number>; }
export interface AccessibilityAuditOptions { minimumTargetSize?: number; checkTargetSize?: boolean; }

const ISSUE_KINDS: readonly AccessibilityIssueKind[] = [
    "missing-accessible-name", "invalid-positive-tabindex", "interactive-aria-hidden", "focusable-in-hidden-tree",
    "dialog-without-name", "image-without-alt", "form-control-without-name", "duplicate-id", "broken-aria-reference",
    "invalid-heading-order", "empty-heading", "invalid-live-region", "invalid-current-value", "invalid-expanded-control",
    "invalid-selected-state", "invalid-aria-boolean", "invalid-role-state", "invalid-tab-state", "invalid-menuitem-state",
    "invalid-progress-range", "invalid-slider-range", "invalid-required-state", "invalid-modal-dialog", "autofocus-control",
    "invalid-target-size"
];
const BOOLEAN_ARIA = ["aria-checked", "aria-disabled", "aria-hidden", "aria-pressed", "aria-readonly", "aria-required"] as const;
const normalize = (value: string | null | undefined): string => String(value ?? "").trim();
const emptyCounts = (): Record<AccessibilityIssueKind, number> => Object.fromEntries(ISSUE_KINDS.map(kind => [kind, 0])) as Record<AccessibilityIssueKind, number>;
const referencedIds = (element: Element, attribute: string): string[] => normalize(element.getAttribute(attribute)).split(/\s+/).filter(Boolean);
const textFromIds = (element: Element, attribute: string): string => referencedIds(element, attribute).map(id => normalize(element.ownerDocument.getElementById(id)?.textContent)).filter(Boolean).join(" ");
const labelText = (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string => Array.from(element.labels ?? []).map(label => normalize(label.textContent)).filter(Boolean).join(" ");

export function getAccessibleName(element: HTMLElement): string {
    const labelledBy = textFromIds(element, "aria-labelledby");
    if (labelledBy) return labelledBy;
    const ariaLabel = normalize(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    if (element instanceof HTMLInputElement) {
        const labels = labelText(element); if (labels) return labels;
        if (["button", "submit", "reset"].includes(element.type) && normalize(element.value)) return normalize(element.value);
        if (element.type === "image" && normalize(element.alt)) return normalize(element.alt);
        if (normalize(element.placeholder)) return normalize(element.placeholder);
    }
    if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        const labels = labelText(element); if (labels) return labels;
        if (element instanceof HTMLTextAreaElement && normalize(element.placeholder)) return normalize(element.placeholder);
    }
    if (element instanceof HTMLImageElement) return normalize(element.alt);
    if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement || element.getAttribute("role") === "button") return normalize(element.textContent) || normalize(element.getAttribute("title"));
    return normalize(element.getAttribute("title"));
}

function isInteractive(element: HTMLElement): boolean {
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(element.tagName)) return true;
    if (element.tagName === "A" && element.hasAttribute("href")) return true;
    return ["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio", "switch", "option", "slider"].includes(element.getAttribute("role") ?? "");
}
function isNaturallyFocusable(element: HTMLElement): boolean {
    if (element instanceof HTMLButtonElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) return !element.disabled;
    if (element instanceof HTMLInputElement) return !element.disabled && element.type !== "hidden";
    if (element instanceof HTMLAnchorElement) return element.hasAttribute("href");
    return element instanceof HTMLDetailsElement || element.tagName === "SUMMARY";
}
function isFocusable(element: HTMLElement): boolean {
    const tabIndex = element.getAttribute("tabindex");
    if (tabIndex !== null && Number.isFinite(Number(tabIndex))) return Number(tabIndex) >= 0;
    return isNaturallyFocusable(element) || element.isContentEditable;
}
function isHiddenFromAccessibilityTree(element: HTMLElement): boolean {
    return element.closest('[aria-hidden="true"], [inert], [hidden]') !== null;
}
function push(issues: AccessibilityIssue[], kind: AccessibilityIssueKind, element: HTMLElement, message: string): void { issues.push({ kind, element, message }); }
const ARIA_REFERENCE_ATTRIBUTES = ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant"] as const;
function auditReferences(element: HTMLElement, issues: AccessibilityIssue[]): void {
    const missing = ARIA_REFERENCE_ATTRIBUTES.flatMap(attribute =>
        referencedIds(element, attribute)
            .filter(id => !element.ownerDocument.getElementById(id))
            .map(id => ({ attribute, id }))
    );
    issues.push(...missing.map(({ attribute, id }) => ({
        kind: "broken-aria-reference" as const,
        element,
        message: `${attribute} bulunamayan bir id'ye başvuruyor: ${id}`
    })));
}
function auditBooleanAttributes(element: HTMLElement, issues: AccessibilityIssue[]): void {
    for (const attribute of BOOLEAN_ARIA) {
        const value = element.getAttribute(attribute);
        if (value !== null && !["true", "false"].includes(value)) push(issues, "invalid-aria-boolean", element, `${attribute} boolean olmalı: ${value}`);
    }
}
function auditStateAttributes(element: HTMLElement, issues: AccessibilityIssue[]): void {
    const current = element.getAttribute("aria-current");
    if (current !== null && !["page", "step", "location", "date", "time", "true", "false"].includes(current)) push(issues, "invalid-current-value", element, `aria-current değeri geçersiz: ${current}`);
    const expanded = element.getAttribute("aria-expanded");
    if (expanded !== null && (!["true", "false"].includes(expanded) || (!element.hasAttribute("aria-controls") && !element.hasAttribute("aria-owns")))) push(issues, "invalid-expanded-control", element, "aria-expanded kullanan kontrol hedefini aria-controls veya aria-owns ile tanımlamalı.");
    const selected = element.getAttribute("aria-selected");
    if (selected !== null && !["true", "false"].includes(selected)) push(issues, "invalid-selected-state", element, `aria-selected boolean olmalı: ${selected}`);
}
function auditRoleState(element: HTMLElement, issues: AccessibilityIssue[]): void {
    const role = element.getAttribute("role");
    const checked = element.getAttribute("aria-checked");
    if (checked !== null && !["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio", "option"].includes(role ?? "")) push(issues, "invalid-role-state", element, "aria-checked yalnız uyumlu seçim rollerinde kullanılmalı.");
    if (role === "tab" && !["true", "false"].includes(element.getAttribute("aria-selected") ?? "")) push(issues, "invalid-tab-state", element, "Tab öğesi aria-selected=true|false sağlamalı.");
    if (["menuitemcheckbox", "menuitemradio"].includes(role ?? "") && !["true", "false", "mixed"].includes(element.getAttribute("aria-checked") ?? "")) push(issues, "invalid-menuitem-state", element, "Seçilebilir menü öğesi aria-checked durumu sağlamalı.");
}
function numericAttribute(element: HTMLElement, name: string): number | null { const value = element.getAttribute(name); if (value === null || value.trim() === "") return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : Number.NaN; }
function auditRanges(element: HTMLElement, issues: AccessibilityIssue[]): void {
    const role = element.getAttribute("role");
    if (role !== "progressbar" && role !== "slider") return;
    const min = numericAttribute(element, "aria-valuemin") ?? 0;
    const max = numericAttribute(element, "aria-valuemax") ?? 100;
    const now = numericAttribute(element, "aria-valuenow");
    const valid = Number.isFinite(min) && Number.isFinite(max) && max >= min && now !== null && Number.isFinite(now) && now >= min && now <= max;
    if (!valid) push(issues, role === "slider" ? "invalid-slider-range" : "invalid-progress-range", element, `${role} geçerli aria-valuemin/max/now aralığı sağlamalı.`);
}
function auditRequiredState(element: HTMLElement, issues: AccessibilityIssue[]): void {
    if (element.getAttribute("aria-required") !== "true") return;
    const role = element.getAttribute("role");
    const native = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
    if (!native && !["combobox", "listbox", "radiogroup", "tree"].includes(role ?? "")) push(issues, "invalid-required-state", element, "aria-required yalnız desteklenen form/widget rollerinde kullanılmalı.");
}
function auditDialog(element: HTMLElement, issues: AccessibilityIssue[]): void {
    const role = element.getAttribute("role");
    if (element.getAttribute("aria-modal") !== null && !["dialog", "alertdialog"].includes(role ?? "")) push(issues, "invalid-modal-dialog", element, "aria-modal yalnız dialog veya alertdialog üzerinde kullanılmalı.");
}
function auditTargetSize(element: HTMLElement, issues: AccessibilityIssue[], options: AccessibilityAuditOptions): void {
    if (!options.checkTargetSize || !isInteractive(element) || isHiddenFromAccessibilityTree(element)) return;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const minimum = options.minimumTargetSize ?? 24;
    if (rect.width < minimum || rect.height < minimum) push(issues, "invalid-target-size", element, `Etkileşim hedefi en az ${minimum}x${minimum}px olmalı.`);
}
function auditLiveRegion(element: HTMLElement, issues: AccessibilityIssue[]): void { const live = element.getAttribute("aria-live"); if (live !== null && !["off", "polite", "assertive"].includes(live)) push(issues, "invalid-live-region", element, `aria-live değeri geçersiz: ${live}`); }
function auditHeadings(elements: HTMLElement[], issues: AccessibilityIssue[]): void {
    let previousLevel = 0;
    for (const element of elements) { if (!/^H[1-6]$/.test(element.tagName)) continue; const level = Number(element.tagName.slice(1)); if (!normalize(element.textContent)) push(issues, "empty-heading", element, "Başlık görünür veya erişilebilir metin içermeli."); if (previousLevel > 0 && level > previousLevel + 1) push(issues, "invalid-heading-order", element, `Başlık seviyesi H${previousLevel}'den H${level}'e atlıyor.`); previousLevel = level; }
}

export function auditAccessibility(root: ParentNode = document, options: AccessibilityAuditOptions = {}): AccessibilityAuditResult {
    const issues: AccessibilityIssue[] = []; const elements = Array.from(root.querySelectorAll<HTMLElement>("*")); const ids = new Map<string, HTMLElement[]>();
    elements.forEach(element => {
        const id = normalize(element.id); if (id) ids.set(id, [...(ids.get(id) ?? []), element]);
        const tabIndex = element.getAttribute("tabindex"); if (tabIndex !== null && Number(tabIndex) > 0) push(issues, "invalid-positive-tabindex", element, "Pozitif tabindex doğal klavye sırasını bozar.");
        if (element.hasAttribute("autofocus")) push(issues, "autofocus-control", element, "autofocus beklenmedik odak sıçramasına neden olabilir.");
        if (element.getAttribute("aria-hidden") === "true" && isInteractive(element)) push(issues, "interactive-aria-hidden", element, "Etkileşimli kontrol aria-hidden ile erişilebilirlik ağacından gizlenmiş.");
        if (isFocusable(element) && isHiddenFromAccessibilityTree(element)) push(issues, "focusable-in-hidden-tree", element, "Odaklanabilir kontrol gizli veya inert erişilebilirlik ağacında bulunuyor.");
        if (isInteractive(element) && !getAccessibleName(element)) push(issues, "missing-accessible-name", element, "Etkileşimli kontrolün erişilebilir adı yok.");
        const role = element.getAttribute("role"); if ((role === "dialog" || role === "alertdialog") && !getAccessibleName(element)) push(issues, "dialog-without-name", element, "Dialog aria-label veya aria-labelledby ile adlandırılmalı.");
        if (element instanceof HTMLImageElement && !element.hasAttribute("alt")) push(issues, "image-without-alt", element, "Görsel alt niteliği sağlamalı; dekoratifse alt boş olmalı.");
        if ((element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) && !getAccessibleName(element)) push(issues, "form-control-without-name", element, "Form kontrolünün programatik etiketi yok.");
        auditReferences(element, issues); auditBooleanAttributes(element, issues); auditStateAttributes(element, issues); auditRoleState(element, issues); auditRanges(element, issues); auditRequiredState(element, issues); auditDialog(element, issues); auditLiveRegion(element, issues); auditTargetSize(element, issues, options);
    });
    ids.forEach(matches => { if (matches.length >= 2) matches.slice(1).forEach(element => push(issues, "duplicate-id", element, `Tekrarlanan id: ${element.id}`)); });
    auditHeadings(elements, issues); const counts = emptyCounts(); issues.forEach(issue => { counts[issue.kind] += 1; }); return { issues, counts };
}
export function formatAccessibilityAudit(result: AccessibilityAuditResult): string { if (!result.issues.length) return "Erişilebilirlik denetimi sorun bulmadı."; const details = ISSUE_KINDS.map(kind => [kind, result.counts[kind]] as const).filter(([, count]) => count > 0).map(([kind, count]) => `${kind}: ${count}`).join(", "); return `Erişilebilirlik denetimi ${result.issues.length} sorun buldu (${details}).`; }
