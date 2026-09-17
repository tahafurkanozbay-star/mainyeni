export const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
].join(",");

export type LivePoliteness = "polite" | "assertive";
export type FocusDirection = "next" | "previous" | "first" | "last";

export interface FocusTrapOptions {
    initialFocus?: HTMLElement | null;
    returnFocus?: HTMLElement | null;
    closeOnEscape?: boolean;
    onEscape?: () => void;
}

export interface FocusTrapHandle {
    activate(): void;
    deactivate(options?: { restore?: boolean }): void;
    isActive(): boolean;
    focusFirst(): boolean;
    focusLast(): boolean;
}

export interface MediaPreferenceSnapshot {
    reducedMotion: boolean;
    forcedColors: boolean;
    prefersDark: boolean;
    coarsePointer: boolean;
    hoverCapable: boolean;
}

export interface MediaQueryLike {
    matches: boolean;
    addEventListener?(type: "change", listener: (event: { matches: boolean }) => void): void;
    removeEventListener?(type: "change", listener: (event: { matches: boolean }) => void): void;
    addListener?(listener: (event: { matches: boolean }) => void): void;
    removeListener?(listener: (event: { matches: boolean }) => void): void;
}

export interface MatchMediaLike {
    (query: string): MediaQueryLike;
}

function hasUsableSize(element: HTMLElement): boolean {
    const style = typeof window !== "undefined" ? window.getComputedStyle?.(element) : null;
    if (style?.visibility === "hidden" || style?.display === "none") return false;
    const rect = element.getBoundingClientRect?.();
    if (!rect) return true;
    // JSDOM reports zero-sized rectangles for otherwise usable controls. Treat
    // disconnected nodes as hidden, but do not reject connected zero-size nodes.
    return element.isConnected;
}

export function isFocusableElement(value: Element | null | undefined): value is HTMLElement {
    if (!(value instanceof HTMLElement)) return false;
    if (value.hasAttribute("disabled")) return false;
    if (value.getAttribute("aria-hidden") === "true") return false;
    if (value.getAttribute("tabindex") === "-1") return false;
    if (!value.isConnected) return false;
    return hasUsableSize(value);
}

export function getFocusableElements(container: ParentNode | null | undefined): HTMLElement[] {
    if (!container?.querySelectorAll) return [];
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isFocusableElement);
}

export function focusElement(element: HTMLElement | null | undefined, preventScroll = true): boolean {
    if (!element || typeof element.focus !== "function") return false;
    try {
        element.focus({ preventScroll });
    } catch (_) {
        element.focus();
    }
    return typeof document === "undefined" || document.activeElement === element;
}

export function focusFirst(container: ParentNode | null | undefined): boolean {
    return focusElement(getFocusableElements(container)[0] ?? null);
}

export function focusLast(container: ParentNode | null | undefined): boolean {
    const elements = getFocusableElements(container);
    return focusElement(elements[elements.length - 1] ?? null);
}

export function moveFocus(
    container: ParentNode | null | undefined,
    active: Element | null | undefined,
    direction: FocusDirection,
    wrap = true
): HTMLElement | null {
    const elements = getFocusableElements(container);
    if (!elements.length) return null;
    if (direction === "first") {
        const first = elements[0] ?? null;
        return focusElement(first) ? first : null;
    }
    if (direction === "last") {
        const last = elements[elements.length - 1] ?? null;
        return focusElement(last) ? last : null;
    }

    const currentIndex = elements.findIndex(element => element === active);
    const step = direction === "previous" ? -1 : 1;
    let nextIndex = currentIndex < 0 ? (step > 0 ? 0 : elements.length - 1) : currentIndex + step;

    if (wrap) {
        nextIndex = (nextIndex + elements.length) % elements.length;
    } else if (nextIndex < 0 || nextIndex >= elements.length) {
        return null;
    }

    const next = elements[nextIndex] ?? null;
    return focusElement(next) ? next : null;
}

export function createFocusTrap(
    container: HTMLElement,
    options: FocusTrapOptions = {}
): FocusTrapHandle {
    let active = false;
    let returnFocus: HTMLElement | null = null;

    const focusInitial = () => {
        const preferred = options.initialFocus;
        if (preferred && isFocusableElement(preferred)) return focusElement(preferred);
        if (focusFirst(container)) return true;
        if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
        return focusElement(container);
    };

    const onKeyDown = (event: KeyboardEvent) => {
        if (!active) return;
        if (event.key === "Escape" && options.closeOnEscape !== false) {
            event.preventDefault();
            event.stopPropagation();
            options.onEscape?.();
            return;
        }
        if (event.key !== "Tab") return;

        const focusable = getFocusableElements(container);
        if (!focusable.length) {
            event.preventDefault();
            focusElement(container);
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const current = document.activeElement;
        if (event.shiftKey && (current === first || !container.contains(current))) {
            event.preventDefault();
            focusElement(last);
        } else if (!event.shiftKey && (current === last || !container.contains(current))) {
            event.preventDefault();
            focusElement(first);
        }
    };

    return {
        activate() {
            if (active) return;
            active = true;
            returnFocus = options.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
            document.addEventListener("keydown", onKeyDown, true);
            focusInitial();
        },
        deactivate(deactivateOptions = {}) {
            if (!active) return;
            active = false;
            document.removeEventListener("keydown", onKeyDown, true);
            if (deactivateOptions.restore !== false) {
                focusElement(returnFocus);
            }
            returnFocus = null;
        },
        isActive: () => active,
        focusFirst: () => focusFirst(container),
        focusLast: () => focusLast(container)
    };
}

export interface RovingState {
    index: number;
    count: number;
}

export interface RovingAction {
    key: string;
    orientation?: "horizontal" | "vertical" | "both";
    direction?: "ltr" | "rtl";
}

export function nextRovingIndex(state: RovingState, action: RovingAction): number {
    const count = Math.max(0, Math.floor(Number(state.count) || 0));
    if (!count) return -1;
    const current = Math.max(0, Math.min(count - 1, Math.floor(Number(state.index) || 0)));
    const orientation = action.orientation ?? "both";
    const rtl = action.direction === "rtl";

    if (action.key === "Home") return 0;
    if (action.key === "End") return count - 1;

    let delta = 0;
    if (orientation !== "vertical" && action.key === "ArrowRight") delta = rtl ? -1 : 1;
    if (orientation !== "vertical" && action.key === "ArrowLeft") delta = rtl ? 1 : -1;
    if (orientation !== "horizontal" && action.key === "ArrowDown") delta = 1;
    if (orientation !== "horizontal" && action.key === "ArrowUp") delta = -1;
    if (!delta) return current;
    return (current + delta + count) % count;
}

export function applyRovingTabIndex(elements: readonly HTMLElement[], activeIndex: number): void {
    elements.forEach((element, index) => {
        element.tabIndex = index === activeIndex ? 0 : -1;
    });
}

export function handleRovingKeyDown(
    event: KeyboardEvent,
    elements: readonly HTMLElement[],
    options: Omit<RovingAction, "key"> = {}
): number | null {
    const currentIndex = elements.findIndex(element => element === event.currentTarget);
    if (currentIndex < 0) return null;
    const nextIndex = nextRovingIndex(
        { index: currentIndex, count: elements.length },
        { ...options, key: event.key }
    );
    if (nextIndex === currentIndex || nextIndex < 0) return null;
    event.preventDefault();
    applyRovingTabIndex(elements, nextIndex);
    focusElement(elements[nextIndex]);
    return nextIndex;
}

export function createLiveRegion(
    root: HTMLElement = document.body,
    options: { id?: string; politeness?: LivePoliteness } = {}
) {
    const node = document.createElement("div");
    node.id = options.id ?? "experience-live-region";
    node.className = "experience-sr-only";
    node.setAttribute("role", options.politeness === "assertive" ? "alert" : "status");
    node.setAttribute("aria-live", options.politeness ?? "polite");
    node.setAttribute("aria-atomic", "true");
    root.appendChild(node);

    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    return {
        element: node,
        announce(message: string, politeness: LivePoliteness = options.politeness ?? "polite") {
            node.setAttribute("role", politeness === "assertive" ? "alert" : "status");
            node.setAttribute("aria-live", politeness);
            node.textContent = "";
            if (clearTimer) clearTimeout(clearTimer);
            // Replacing the text in a new task causes screen readers to announce
            // repeated equal messages as a fresh status update.
            clearTimer = setTimeout(() => {
                node.textContent = String(message ?? "").trim();
            }, 0);
        },
        clear() {
            if (clearTimer) clearTimeout(clearTimer);
            clearTimer = null;
            node.textContent = "";
        },
        destroy() {
            if (clearTimer) clearTimeout(clearTimer);
            clearTimer = null;
            node.remove();
        }
    };
}

function query(matchMedia: MatchMediaLike | undefined, expression: string): boolean {
    if (!matchMedia) return false;
    try {
        return Boolean(matchMedia(expression).matches);
    } catch (_) {
        return false;
    }
}

export function getMediaPreferenceSnapshot(matchMedia?: MatchMediaLike): MediaPreferenceSnapshot {
    const media = matchMedia ?? (typeof window !== "undefined" ? window.matchMedia?.bind(window) : undefined);
    return {
        reducedMotion: query(media, "(prefers-reduced-motion: reduce)"),
        forcedColors: query(media, "(forced-colors: active)"),
        prefersDark: query(media, "(prefers-color-scheme: dark)"),
        coarsePointer: query(media, "(pointer: coarse)"),
        hoverCapable: query(media, "(hover: hover)")
    };
}

export function subscribeMediaQuery(
    mediaQuery: MediaQueryLike,
    listener: (matches: boolean) => void
): () => void {
    const wrapped = (event: { matches: boolean }) => listener(Boolean(event.matches));
    if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", wrapped);
        return () => mediaQuery.removeEventListener?.("change", wrapped);
    }
    mediaQuery.addListener?.(wrapped);
    return () => mediaQuery.removeListener?.(wrapped);
}

export function installMediaPreferenceObserver(
    listener: (snapshot: MediaPreferenceSnapshot) => void,
    matchMedia?: MatchMediaLike
): () => void {
    const media = matchMedia ?? (typeof window !== "undefined" ? window.matchMedia?.bind(window) : undefined);
    if (!media) return () => {};

    const queries = [
        media("(prefers-reduced-motion: reduce)"),
        media("(forced-colors: active)"),
        media("(prefers-color-scheme: dark)"),
        media("(pointer: coarse)"),
        media("(hover: hover)")
    ];
    const publish = () => listener(getMediaPreferenceSnapshot(media));
    const releases = queries.map(item => subscribeMediaQuery(item, publish));
    publish();
    return () => releases.forEach(release => release());
}

export function ensureSkipTarget(target: HTMLElement): void {
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
}

export function activateSkipTarget(target: HTMLElement | null | undefined): boolean {
    if (!target) return false;
    ensureSkipTarget(target);
    return focusElement(target, false);
}

export function describeKeyboardShortcut(parts: readonly string[]): string {
    const aliases: Record<string, string> = {
        Ctrl: "Kontrol",
        Control: "Kontrol",
        Alt: "Alt",
        Shift: "Shift",
        Meta: "Komut",
        Enter: "Enter",
        Escape: "Escape",
        ArrowUp: "Yukarı ok",
        ArrowDown: "Aşağı ok",
        ArrowLeft: "Sol ok",
        ArrowRight: "Sağ ok"
    };
    return parts.map(part => aliases[part] ?? part).join(" artı ");
}

export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const contentEditable = target.getAttribute("contenteditable");
    const contentEditableProperty = target.contentEditable?.toLowerCase();
    if (
        target.isContentEditable
        || contentEditable === ""
        || contentEditable?.toLowerCase() === "true"
        || contentEditableProperty === "true"
    ) return true;
    if (target.closest?.('[contenteditable=""], [contenteditable="true"]')) return true;
    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorValue = ancestor.contentEditable?.toLowerCase();
        if (ancestorValue === "false") break;
        if (ancestor.isContentEditable || ancestorValue === "true") return true;
    }
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function shouldHandleGlobalShortcut(
    event: Pick<KeyboardEvent, "defaultPrevented" | "isComposing" | "target">
): boolean {
    if (event.defaultPrevented || event.isComposing) return false;
    return !isTypingTarget(event.target);
}

export function touchTargetMeetsMinimum(element: Element, minimum = 44): boolean {
    const rect = element.getBoundingClientRect?.();
    if (!rect) return true;
    return rect.width >= minimum && rect.height >= minimum;
}

export function findSmallTouchTargets(
    root: ParentNode,
    minimum = 44
): HTMLElement[] {
    const controls = root.querySelectorAll<HTMLElement>(
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]'
    );
    return Array.from(controls).filter(control => isFocusableElement(control) && !touchTargetMeetsMinimum(control, minimum));
}
