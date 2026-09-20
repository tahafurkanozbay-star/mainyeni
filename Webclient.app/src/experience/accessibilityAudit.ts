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
    | "invalid-selected-state";

export interface AccessibilityIssue {
    kind: AccessibilityIssueKind;
    element: HTMLElement;
    message: string;
}

export interface AccessibilityAuditResult {
    issues: AccessibilityIssue[];
    counts: Record<AccessibilityIssueKind, number>;
}

const ISSUE_KINDS: readonly AccessibilityIssueKind[] = [
    "missing-accessible-name",
    "invalid-positive-tabindex",
    "interactive-aria-hidden",
    "focusable-in-hidden-tree",
    "dialog-without-name",
    "image-without-alt",
    "form-control-without-name",
    "duplicate-id",
    "broken-aria-reference",
    "invalid-heading-order",
    "empty-heading",
    "invalid-live-region",
    "invalid-current-value",
    "invalid-expanded-control",
    "invalid-selected-state"
];

const emptyCounts = (): Record<AccessibilityIssueKind, number> => Object.fromEntries(
    ISSUE_KINDS.map(kind => [kind, 0])
) as Record<AccessibilityIssueKind, number>;

const normalize = (value: string | null | undefined): string => String(value ?? "").trim();

function referencedIds(element: Element, attribute: string): string[] {
    return normalize(element.getAttribute(attribute)).split(/\s+/).filter(Boolean);
}

function textFromIds(element: Element, attribute: string): string {
    return referencedIds(element, attribute)
        .map(id => normalize(element.ownerDocument.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(" ");
}

function labelText(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
    return Array.from(element.labels ?? []).map(label => normalize(label.textContent)).filter(Boolean).join(" ");
}

export function getAccessibleName(element: HTMLElement): string {
    const labelledBy = textFromIds(element, "aria-labelledby");
    if (labelledBy) return labelledBy;
    const ariaLabel = normalize(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    if (element instanceof HTMLInputElement) {
        const labels = labelText(element);
        if (labels) return labels;
        if (["button", "submit", "reset"].includes(element.type) && normalize(element.value)) return normalize(element.value);
        if (element.type === "image" && normalize(element.alt)) return normalize(element.alt);
        if (normalize(element.placeholder)) return normalize(element.placeholder);
    }
    if (element instanceof HTMLSelectElement) {
        const labels = labelText(element);
        if (labels) return labels;
    }
    if (element instanceof HTMLTextAreaElement) {
        const labels = labelText(element);
        if (labels) return labels;
        if (normalize(element.placeholder)) return normalize(element.placeholder);
    }
    if (element instanceof HTMLImageElement) return normalize(element.alt);
    if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement || element.getAttribute("role") === "button") {
        return normalize(element.textContent) || normalize(element.getAttribute("title"));
    }
    return normalize(element.getAttribute("title"));
}

function isInteractive(element: HTMLElement): boolean {
    const tag = element.tagName;
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(tag)) return true;
    if (tag === "A" && element.hasAttribute("href")) return true;
    const role = element.getAttribute("role");
    return role === "button" || role === "link" || role === "tab" || role === "menuitem" || role === "checkbox" || role === "radio" || role === "switch" || role === "option";
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
    let current: HTMLElement | null = element;
    while (current) {
        if (current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert") || current.hidden) return true;
        current = current.parentElement;
    }
    return false;
}

function push(issues: AccessibilityIssue[], kind: AccessibilityIssueKind, element: HTMLElement, message: string): void {
    issues.push({ kind, element, message });
}

function auditReferences(element: HTMLElement, issues: AccessibilityIssue[]): void {
    for (const attribute of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns"] as const) {
        for (const id of referencedIds(element, attribute)) {
            if (!element.ownerDocument.getElementById(id)) {
                push(issues, "broken-aria-reference", element, `${attribute} bulunamayan bir id'ye başvuruyor: ${id}`);
            }
        }
    }
}

function auditStateAttributes(element: HTMLElement, issues: AccessibilityIssue[]): void {
    const current = element.getAttribute("aria-current");
    if (current !== null && !["page", "step", "location", "date", "time", "true", "false"].includes(current)) {
        push(issues, "invalid-current-value", element, `aria-current değeri geçersiz: ${current}`);
    }
    const expanded = element.getAttribute("aria-expanded");
    if (expanded !== null) {
        if (!["true", "false"].includes(expanded) || (!element.hasAttribute("aria-controls") && !element.hasAttribute("aria-owns"))) {
            push(issues, "invalid-expanded-control", element, "aria-expanded kullanan kontrol hedefini aria-controls veya aria-owns ile tanımlamalı.");
        }
    }
    const selected = element.getAttribute("aria-selected");
    if (selected !== null && !["true", "false"].includes(selected)) {
        push(issues, "invalid-selected-state", element, `aria-selected boolean olmalı: ${selected}`);
    }
}

function auditLiveRegion(element: HTMLElement, issues: AccessibilityIssue[]): void {
    const live = element.getAttribute("aria-live");
    if (live !== null && !["off", "polite", "assertive"].includes(live)) {
        push(issues, "invalid-live-region", element, `aria-live değeri geçersiz: ${live}`);
    }
}

function auditHeadings(elements: HTMLElement[], issues: AccessibilityIssue[]): void {
    let previousLevel = 0;
    for (const element of elements) {
        if (!/^H[1-6]$/.test(element.tagName)) continue;
        const level = Number(element.tagName.slice(1));
        if (!normalize(element.textContent)) push(issues, "empty-heading", element, "Başlık görünür veya erişilebilir metin içermeli.");
        if (previousLevel > 0 && level > previousLevel + 1) {
            push(issues, "invalid-heading-order", element, `Başlık seviyesi H${previousLevel}'den H${level}'e atlıyor.`);
        }
        previousLevel = level;
    }
}

export function auditAccessibility(root: ParentNode = document): AccessibilityAuditResult {
    const issues: AccessibilityIssue[] = [];
    const elements = Array.from(root.querySelectorAll<HTMLElement>("*"));
    const ids = new Map<string, HTMLElement[]>();

    elements.forEach(element => {
        const id = normalize(element.id);
        if (id) ids.set(id, [...(ids.get(id) ?? []), element]);

        const tabIndex = element.getAttribute("tabindex");
        if (tabIndex !== null && Number(tabIndex) > 0) {
            push(issues, "invalid-positive-tabindex", element, "Pozitif tabindex doğal klavye sırasını bozar.");
        }
        if (element.getAttribute("aria-hidden") === "true" && isInteractive(element)) {
            push(issues, "interactive-aria-hidden", element, "Etkileşimli kontrol aria-hidden ile erişilebilirlik ağacından gizlenmiş.");
        }
        if (isFocusable(element) && isHiddenFromAccessibilityTree(element)) {
            push(issues, "focusable-in-hidden-tree", element, "Odaklanabilir kontrol gizli veya inert erişilebilirlik ağacında bulunuyor.");
        }
        if (isInteractive(element) && !getAccessibleName(element)) {
            push(issues, "missing-accessible-name", element, "Etkileşimli kontrolün erişilebilir adı yok.");
        }
        const role = element.getAttribute("role");
        if ((role === "dialog" || role === "alertdialog") && !getAccessibleName(element)) {
            push(issues, "dialog-without-name", element, "Dialog aria-label veya aria-labelledby ile adlandırılmalı.");
        }
        if (element instanceof HTMLImageElement && !element.hasAttribute("alt")) {
            push(issues, "image-without-alt", element, "Görsel alt niteliği sağlamalı; dekoratifse alt boş olmalı.");
        }
        if ((element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) && !getAccessibleName(element)) {
            push(issues, "form-control-without-name", element, "Form kontrolünün programatik etiketi yok.");
        }
        auditReferences(element, issues);
        auditStateAttributes(element, issues);
        auditLiveRegion(element, issues);
    });

    ids.forEach(matches => {
        if (matches.length < 2) return;
        matches.slice(1).forEach(element => push(issues, "duplicate-id", element, `Tekrarlanan id: ${element.id}`));
    });
    auditHeadings(elements, issues);

    const counts = emptyCounts();
    issues.forEach(issue => { counts[issue.kind] += 1; });
    return { issues, counts };
}

export function formatAccessibilityAudit(result: AccessibilityAuditResult): string {
    if (!result.issues.length) return "Erişilebilirlik denetimi sorun bulmadı.";
    const details = ISSUE_KINDS
        .map(kind => [kind, result.counts[kind]] as const)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${kind}: ${count}`)
        .join(", ");
    return `Erişilebilirlik denetimi ${result.issues.length} sorun buldu (${details}).`;
}
