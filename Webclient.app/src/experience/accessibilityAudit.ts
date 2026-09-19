export type AccessibilityIssueKind =
    | "missing-accessible-name"
    | "invalid-positive-tabindex"
    | "interactive-aria-hidden"
    | "dialog-without-name"
    | "image-without-alt"
    | "form-control-without-name"
    | "duplicate-id";

export interface AccessibilityIssue {
    kind: AccessibilityIssueKind;
    element: HTMLElement;
    message: string;
}

export interface AccessibilityAuditResult {
    issues: AccessibilityIssue[];
    counts: Record<AccessibilityIssueKind, number>;
}

const emptyCounts = (): Record<AccessibilityIssueKind, number> => ({
    "missing-accessible-name": 0,
    "invalid-positive-tabindex": 0,
    "interactive-aria-hidden": 0,
    "dialog-without-name": 0,
    "image-without-alt": 0,
    "form-control-without-name": 0,
    "duplicate-id": 0
});

const normalize = (value: string | null | undefined): string => String(value ?? "").trim();

function textFromIds(element: Element, attribute: string): string {
    const ids = normalize(element.getAttribute(attribute)).split(/\s+/).filter(Boolean);
    return ids.map(id => normalize(element.ownerDocument.getElementById(id)?.textContent)).filter(Boolean).join(" ");
}

export function getAccessibleName(element: HTMLElement): string {
    const labelledBy = textFromIds(element, "aria-labelledby");
    if (labelledBy) return labelledBy;
    const ariaLabel = normalize(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    if (element instanceof HTMLInputElement) {
        const labels = Array.from(element.labels ?? []).map(label => normalize(label.textContent)).filter(Boolean);
        if (labels.length) return labels.join(" ");
        if (["button", "submit", "reset"].includes(element.type) && normalize(element.value)) return normalize(element.value);
        if (element.type === "image" && normalize(element.alt)) return normalize(element.alt);
        if (normalize(element.placeholder)) return normalize(element.placeholder);
    }
    if (element instanceof HTMLTextAreaElement && normalize(element.placeholder)) return normalize(element.placeholder);
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
    return role === "button" || role === "link" || role === "tab" || role === "menuitem" || role === "checkbox" || role === "radio" || role === "switch";
}

function push(issues: AccessibilityIssue[], kind: AccessibilityIssueKind, element: HTMLElement, message: string): void {
    issues.push({ kind, element, message });
}

export function auditAccessibility(root: ParentNode = document): AccessibilityAuditResult {
    const issues: AccessibilityIssue[] = [];
    const elements = Array.from(root.querySelectorAll<HTMLElement>("*"));
    const ids = new Map<string, HTMLElement[]>();

    elements.forEach(element => {
        const id = normalize(element.id);
        if (id) ids.set(id, [...(ids.get(id) ?? []), element]);

        const tabIndex = element.getAttribute("tabindex");
        if (tabIndex && Number(tabIndex) > 0) {
            push(issues, "invalid-positive-tabindex", element, "Pozitif tabindex doğal klavye sırasını bozar.");
        }
        if (element.getAttribute("aria-hidden") === "true" && isInteractive(element)) {
            push(issues, "interactive-aria-hidden", element, "Etkileşimli kontrol aria-hidden ile erişilebilirlik ağacından gizlenmiş.");
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
    });

    ids.forEach(matches => {
        if (matches.length < 2) return;
        matches.slice(1).forEach(element => push(issues, "duplicate-id", element, `Tekrarlanan id: ${element.id}`));
    });

    const counts = emptyCounts();
    issues.forEach(issue => { counts[issue.kind] += 1; });
    return { issues, counts };
}

export function formatAccessibilityAudit(result: AccessibilityAuditResult): string {
    if (!result.issues.length) return "Erişilebilirlik denetimi sorun bulmadı.";
    const details = Object.entries(result.counts)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${kind}: ${count}`)
        .join(", ");
    return `Erişilebilirlik denetimi ${result.issues.length} sorun buldu (${details}).`;
}
