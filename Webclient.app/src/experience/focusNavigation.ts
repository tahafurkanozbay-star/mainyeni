export type FocusDirection = "first" | "last" | "next" | "previous";
export type RovingOrientation = "horizontal" | "vertical" | "both";

export interface FocusCandidateOptions {
    includeContainer?: boolean;
    includeNegativeTabIndex?: boolean;
    visibleOnly?: boolean;
}

export interface FocusMoveResult {
    moved: boolean;
    from: HTMLElement | null;
    to: HTMLElement | null;
    wrapped: boolean;
}

export interface FocusTrapOptions {
    container: HTMLElement;
    initialFocus?: HTMLElement | (() => HTMLElement | null) | null;
    fallbackFocus?: HTMLElement | (() => HTMLElement | null) | null;
    returnFocus?: HTMLElement | (() => HTMLElement | null) | null;
    escapeDeactivates?: boolean;
    onEscape?: () => void;
    onActivate?: () => void;
    onDeactivate?: () => void;
}

export interface FocusTrapController {
    activate(): void;
    deactivate(options?: { restoreFocus?: boolean }): void;
    refresh(): void;
    isActive(): boolean;
}

export interface RovingFocusOptions {
    container: HTMLElement;
    itemSelector: string;
    orientation?: RovingOrientation;
    loop?: boolean;
    homeEnd?: boolean;
    typeahead?: boolean;
    typeaheadTimeoutMs?: number;
    disabled?: (element: HTMLElement) => boolean;
    onCurrentChange?: (element: HTMLElement, index: number) => void;
}

export interface RovingFocusController {
    getCurrent(): HTMLElement | null;
    setCurrent(target: HTMLElement | number, options?: { focus?: boolean }): boolean;
    refresh(): void;
    destroy(): void;
}

const INTERACTIVE_SELECTOR = [
    "a[href]", "area[href]", "button", "input", "select", "textarea", "summary", "iframe",
    "audio[controls]", "video[controls]", "[contenteditable]", "[tabindex]"
].join(",");

const elementFrom = (value: HTMLElement | (() => HTMLElement | null) | null | undefined): HTMLElement | null =>
    typeof value === "function" ? value() : value ?? null;

const numericTabIndex = (element: HTMLElement): number => {
    const value = element.getAttribute("tabindex");
    if (value === null) return element.tabIndex;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : element.tabIndex;
};

export function isElementHidden(element: HTMLElement): boolean {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return true;
    if (element.closest("[hidden], [inert], [aria-hidden='true']")) return true;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) return false;
    return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
}

export function isElementDisabled(element: HTMLElement): boolean {
    if (element.matches(":disabled")) return true;
    if (element.getAttribute("aria-disabled") === "true") return true;
    return Boolean(element.closest("fieldset[disabled]"));
}

export function isFocusable(element: HTMLElement, options: FocusCandidateOptions = {}): boolean {
    if (!element.isConnected || isElementDisabled(element)) return false;
    if (options.visibleOnly !== false && isElementHidden(element)) return false;
    if (element.matches("input[type='hidden']") || !element.matches(INTERACTIVE_SELECTOR)) return false;
    if (!options.includeNegativeTabIndex && numericTabIndex(element) < 0) return false;
    return true;
}

export function getFocusCandidates(container: HTMLElement, options: FocusCandidateOptions = {}): HTMLElement[] {
    const candidates = Array.from(container.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
    if (options.includeContainer && container.matches(INTERACTIVE_SELECTOR)) candidates.unshift(container);
    return candidates.filter((candidate) => isFocusable(candidate, options));
}

export function focusSafely(element: HTMLElement | null | undefined, preventScroll = true): boolean {
    if (!element || !element.isConnected || isElementHidden(element) || isElementDisabled(element)) return false;
    try {
        element.focus({ preventScroll });
        return element.ownerDocument.activeElement === element;
    } catch {
        return false;
    }
}

export function moveFocus(
    container: HTMLElement,
    direction: FocusDirection,
    options: FocusCandidateOptions & { loop?: boolean } = {}
): FocusMoveResult {
    const candidates = getFocusCandidates(container, options);
    const active = container.ownerDocument.activeElement instanceof HTMLElement ? container.ownerDocument.activeElement : null;
    if (candidates.length === 0) return { moved: false, from: active, to: null, wrapped: false };

    const currentIndex = active ? candidates.indexOf(active) : -1;
    let targetIndex = 0;
    let wrapped = false;
    if (direction === "last") targetIndex = candidates.length - 1;
    if (direction === "next") {
        if (currentIndex < 0) targetIndex = 0;
        else if (currentIndex + 1 < candidates.length) targetIndex = currentIndex + 1;
        else if (options.loop !== false) { targetIndex = 0; wrapped = true; }
        else return { moved: false, from: active, to: active, wrapped: false };
    }
    if (direction === "previous") {
        if (currentIndex < 0) targetIndex = candidates.length - 1;
        else if (currentIndex > 0) targetIndex = currentIndex - 1;
        else if (options.loop !== false) { targetIndex = candidates.length - 1; wrapped = true; }
        else return { moved: false, from: active, to: active, wrapped: false };
    }
    const target = candidates[targetIndex] ?? null;
    return { moved: focusSafely(target), from: active, to: target, wrapped };
}

function ensureFallbackFocusable(container: HTMLElement): () => void {
    const previous = container.getAttribute("tabindex");
    if (numericTabIndex(container) < 0 && previous === null) container.setAttribute("tabindex", "-1");
    return () => {
        if (previous === null) container.removeAttribute("tabindex");
        else container.setAttribute("tabindex", previous);
    };
}

export function createFocusTrap(options: FocusTrapOptions): FocusTrapController {
    const { container } = options;
    const document = container.ownerDocument;
    let active = false;
    let restoreFallback: (() => void) | undefined;
    let activationOrigin: HTMLElement | null = null;

    const preferredInitial = (): HTMLElement | null =>
        elementFrom(options.initialFocus) ?? getFocusCandidates(container)[0] ?? elementFrom(options.fallbackFocus) ?? container;

    const keepInside = (event: FocusEvent): void => {
        if (!active) return;
        const target = event.target;
        if (target instanceof Node && container.contains(target)) return;
        focusSafely(preferredInitial());
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (!active) return;
        if (event.key === "Escape" && options.escapeDeactivates !== false) {
            event.preventDefault();
            options.onEscape?.();
            return;
        }
        if (event.key !== "Tab") return;
        const candidates = getFocusCandidates(container);
        if (candidates.length === 0) {
            event.preventDefault();
            focusSafely(container);
            return;
        }
        const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const first = candidates[0] ?? null;
        const last = candidates.at(-1) ?? null;
        if (event.shiftKey && (current === first || !current || !container.contains(current))) {
            event.preventDefault();
            focusSafely(last);
        } else if (!event.shiftKey && current === last) {
            event.preventDefault();
            focusSafely(first);
        }
    };

    const refresh = (): void => {
        if (!active) return;
        const current = document.activeElement;
        if (!(current instanceof Node) || !container.contains(current)) focusSafely(preferredInitial());
    };

    return {
        activate: () => {
            if (active) return;
            active = true;
            activationOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            restoreFallback = ensureFallbackFocusable(container);
            document.addEventListener("keydown", onKeyDown, true);
            document.addEventListener("focusin", keepInside, true);
            focusSafely(preferredInitial());
            options.onActivate?.();
        },
        deactivate: ({ restoreFocus = true } = {}) => {
            if (!active) return;
            active = false;
            document.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("focusin", keepInside, true);
            restoreFallback?.();
            restoreFallback = undefined;
            const target = elementFrom(options.returnFocus) ?? activationOrigin;
            if (restoreFocus) focusSafely(target);
            activationOrigin = null;
            options.onDeactivate?.();
        },
        refresh,
        isActive: () => active
    };
}

const normalizedText = (element: HTMLElement): string =>
    (element.getAttribute("aria-label") || element.textContent || "").trim().toLocaleLowerCase("tr-TR");

export function createRovingFocus(options: RovingFocusOptions): RovingFocusController {
    const orientation = options.orientation ?? "both";
    const loop = options.loop !== false;
    const homeEnd = options.homeEnd !== false;
    const typeahead = options.typeahead !== false;
    const timeout = Math.max(100, options.typeaheadTimeoutMs ?? 650);
    let items: HTMLElement[] = [];
    let currentIndex = 0;
    let buffer = "";
    let bufferTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;

    const disabled = (item: HTMLElement): boolean => options.disabled?.(item) ?? isElementDisabled(item);
    const enabledIndexes = (): number[] => items.map((item, index) => disabled(item) ? -1 : index).filter((index) => index >= 0);

    const applyCurrent = (index: number, focus: boolean): boolean => {
        const target = items[index];
        if (!target || disabled(target)) return false;
        currentIndex = index;
        items.forEach((item, itemIndex) => item.setAttribute("tabindex", itemIndex === currentIndex ? "0" : "-1"));
        if (focus) focusSafely(target);
        options.onCurrentChange?.(target, currentIndex);
        return true;
    };

    const refresh = (): void => {
        if (destroyed) return;
        const previous = items[currentIndex];
        items = Array.from(options.container.querySelectorAll<HTMLElement>(options.itemSelector));
        const enabled = enabledIndexes();
        if (enabled.length === 0) {
            items.forEach((item) => item.setAttribute("tabindex", "-1"));
            currentIndex = 0;
            return;
        }
        const preserved = previous ? items.indexOf(previous) : -1;
        const authored = items.findIndex((item) => item.getAttribute("tabindex") === "0" && !disabled(item));
        const preservedItem = preserved >= 0 ? items[preserved] : undefined;
        currentIndex = preservedItem && !disabled(preservedItem) ? preserved : authored >= 0 ? authored : (enabled[0] ?? 0);
        items.forEach((item, index) => item.setAttribute("tabindex", index === currentIndex ? "0" : "-1"));
    };

    const step = (delta: 1 | -1): void => {
        const enabled = enabledIndexes();
        if (enabled.length === 0) return;
        const position = enabled.indexOf(currentIndex);
        let nextPosition = position < 0 ? 0 : position + delta;
        if (loop) nextPosition = (nextPosition + enabled.length) % enabled.length;
        else nextPosition = Math.max(0, Math.min(enabled.length - 1, nextPosition));
        const nextIndex = enabled[nextPosition];
        if (nextIndex !== undefined) applyCurrent(nextIndex, true);
    };

    const search = (character: string): void => {
        buffer += character.toLocaleLowerCase("tr-TR");
        if (bufferTimer) clearTimeout(bufferTimer);
        bufferTimer = setTimeout(() => { buffer = ""; }, timeout);
        const enabled = enabledIndexes();
        if (enabled.length === 0) return;
        const ordered = [...enabled.filter((index) => index > currentIndex), ...enabled.filter((index) => index <= currentIndex)];
        const matches = (index: number): boolean => {
            const item = items[index];
            return item ? normalizedText(item).startsWith(buffer) : false;
        };
        let match = ordered.find(matches);
        if (match === undefined && buffer.length > 1) {
            buffer = character.toLocaleLowerCase("tr-TR");
            match = ordered.find(matches);
        }
        if (match !== undefined) applyCurrent(match, true);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || !options.container.contains(target)) return;
        const horizontal = orientation === "horizontal" || orientation === "both";
        const vertical = orientation === "vertical" || orientation === "both";
        if ((horizontal && event.key === "ArrowRight") || (vertical && event.key === "ArrowDown")) {
            event.preventDefault(); step(1); return;
        }
        if ((horizontal && event.key === "ArrowLeft") || (vertical && event.key === "ArrowUp")) {
            event.preventDefault(); step(-1); return;
        }
        if (homeEnd && event.key === "Home") {
            event.preventDefault();
            const first = enabledIndexes()[0];
            if (first !== undefined) applyCurrent(first, true);
            return;
        }
        if (homeEnd && event.key === "End") {
            event.preventDefault();
            const last = enabledIndexes().at(-1);
            if (last !== undefined) applyCurrent(last, true);
            return;
        }
        if (typeahead && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) search(event.key);
    };

    options.container.addEventListener("keydown", onKeyDown);
    refresh();

    return {
        getCurrent: () => items[currentIndex] ?? null,
        setCurrent: (target, config = {}) => {
            const index = typeof target === "number" ? target : items.indexOf(target);
            return applyCurrent(index, config.focus !== false);
        },
        refresh,
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            options.container.removeEventListener("keydown", onKeyDown);
            if (bufferTimer) clearTimeout(bufferTimer);
            bufferTimer = undefined;
            buffer = "";
        }
    };
}
