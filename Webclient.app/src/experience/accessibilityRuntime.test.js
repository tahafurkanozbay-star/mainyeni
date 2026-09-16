import {
    FOCUSABLE_SELECTOR,
    activateSkipTarget,
    applyRovingTabIndex,
    createFocusTrap,
    createLiveRegion,
    describeKeyboardShortcut,
    ensureSkipTarget,
    findSmallTouchTargets,
    focusElement,
    focusFirst,
    focusLast,
    getFocusableElements,
    getMediaPreferenceSnapshot,
    handleRovingKeyDown,
    installMediaPreferenceObserver,
    isFocusableElement,
    isTypingTarget,
    moveFocus,
    nextRovingIndex,
    shouldHandleGlobalShortcut,
    subscribeMediaQuery,
    touchTargetMeetsMinimum
} from "./accessibilityRuntime";

const appendFixture = html => {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
};

const rect = (width, height) => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({})
});

class FakeMediaQuery {
    constructor(matches = false) {
        this.matches = matches;
        this.listeners = new Set();
    }

    addEventListener(_type, listener) {
        this.listeners.add(listener);
    }

    removeEventListener(_type, listener) {
        this.listeners.delete(listener);
    }

    emit(matches) {
        this.matches = matches;
        this.listeners.forEach(listener => listener({ matches }));
    }
}

describe("accessibilityRuntime focus helpers", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("focusable selector covers native controls and explicit tabindex", () => {
        expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
        expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
        expect(FOCUSABLE_SELECTOR).toContain("summary");
    });

    test("filters disabled, hidden and negative-tabindex candidates", () => {
        const root = appendFixture(`
            <button id="a">A</button>
            <button id="disabled" disabled>Disabled</button>
            <a id="link" href="#x">Link</a>
            <button id="aria-hidden" aria-hidden="true">Hidden</button>
            <div id="custom" tabindex="0">Custom</div>
            <div id="negative" tabindex="-1">Negative</div>
        `);
        const ids = getFocusableElements(root).map(element => element.id);
        expect(ids).toEqual(["a", "link", "custom"]);
        expect(isFocusableElement(root.querySelector("#a"))).toBe(true);
        expect(isFocusableElement(root.querySelector("#disabled"))).toBe(false);
        expect(isFocusableElement(root.querySelector("#negative"))).toBe(false);
    });

    test("focusElement returns false for missing controls and focuses valid controls", () => {
        const root = appendFixture('<button id="a">A</button>');
        const button = root.querySelector("#a");
        expect(focusElement(null)).toBe(false);
        expect(focusElement(button)).toBe(true);
        expect(document.activeElement).toBe(button);
    });

    test("focusFirst and focusLast use DOM order", () => {
        const root = appendFixture(`
            <button id="first">First</button>
            <button id="middle">Middle</button>
            <button id="last">Last</button>
        `);
        expect(focusFirst(root)).toBe(true);
        expect(document.activeElement.id).toBe("first");
        expect(focusLast(root)).toBe(true);
        expect(document.activeElement.id).toBe("last");
    });

    test("moveFocus wraps in both directions", () => {
        const root = appendFixture(`
            <button id="first">First</button>
            <button id="second">Second</button>
            <button id="third">Third</button>
        `);
        const first = root.querySelector("#first");
        const second = root.querySelector("#second");
        const third = root.querySelector("#third");

        expect(moveFocus(root, first, "next")).toBe(second);
        expect(moveFocus(root, third, "next")).toBe(first);
        expect(moveFocus(root, first, "previous")).toBe(third);
        expect(moveFocus(root, second, "first")).toBe(first);
        expect(moveFocus(root, second, "last")).toBe(third);
    });

    test("moveFocus can stop at boundaries when wrapping is disabled", () => {
        const root = appendFixture('<button id="first">First</button><button id="last">Last</button>');
        const first = root.querySelector("#first");
        const last = root.querySelector("#last");
        expect(moveFocus(root, last, "next", false)).toBeNull();
        expect(moveFocus(root, first, "previous", false)).toBeNull();
    });
});

describe("accessibilityRuntime focus trap", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("activates with requested initial focus and restores the opener", () => {
        const opener = document.createElement("button");
        opener.textContent = "Open";
        document.body.appendChild(opener);
        const root = appendFixture('<button id="first">First</button><button id="last">Last</button>');
        const last = root.querySelector("#last");
        opener.focus();

        const trap = createFocusTrap(root, { initialFocus: last });
        trap.activate();
        expect(trap.isActive()).toBe(true);
        expect(document.activeElement).toBe(last);

        trap.deactivate();
        expect(trap.isActive()).toBe(false);
        expect(document.activeElement).toBe(opener);
    });

    test("cycles Tab and Shift+Tab at focus boundaries", () => {
        const root = appendFixture('<button id="first">First</button><button id="last">Last</button>');
        const first = root.querySelector("#first");
        const last = root.querySelector("#last");
        const trap = createFocusTrap(root);
        trap.activate();
        expect(document.activeElement).toBe(first);

        last.focus();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(first);

        first.focus();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(last);
        trap.deactivate({ restore: false });
    });

    test("reports Escape only when escape closing is enabled", () => {
        const root = appendFixture('<button>Action</button>');
        const onEscape = jest.fn();
        const trap = createFocusTrap(root, { onEscape });
        trap.activate();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        expect(onEscape).toHaveBeenCalledTimes(1);
        trap.deactivate({ restore: false });

        const disabled = createFocusTrap(root, { onEscape, closeOnEscape: false });
        disabled.activate();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        expect(onEscape).toHaveBeenCalledTimes(1);
        disabled.deactivate({ restore: false });
    });

    test("focuses the container when no descendants are focusable", () => {
        const root = appendFixture('<span>No controls</span>');
        const trap = createFocusTrap(root);
        trap.activate();
        expect(root).toHaveAttribute("tabindex", "-1");
        expect(document.activeElement).toBe(root);
        trap.deactivate({ restore: false });
    });
});

describe("accessibilityRuntime roving navigation", () => {
    test.each([
        [{ index: 0, count: 3 }, { key: "ArrowRight" }, 1],
        [{ index: 2, count: 3 }, { key: "ArrowRight" }, 0],
        [{ index: 0, count: 3 }, { key: "ArrowLeft" }, 2],
        [{ index: 1, count: 3 }, { key: "ArrowDown", orientation: "vertical" }, 2],
        [{ index: 1, count: 3 }, { key: "ArrowUp", orientation: "vertical" }, 0],
        [{ index: 2, count: 3 }, { key: "Home" }, 0],
        [{ index: 0, count: 3 }, { key: "End" }, 2]
    ])("computes next roving index", (state, action, expected) => {
        expect(nextRovingIndex(state, action)).toBe(expected);
    });

    test("reverses horizontal arrows in RTL", () => {
        expect(nextRovingIndex(
            { index: 1, count: 3 },
            { key: "ArrowRight", direction: "rtl", orientation: "horizontal" }
        )).toBe(0);
    });

    test("ignores arrows excluded by orientation", () => {
        expect(nextRovingIndex(
            { index: 1, count: 3 },
            { key: "ArrowDown", orientation: "horizontal" }
        )).toBe(1);
    });

    test("applies one tabbable item at a time", () => {
        const elements = [document.createElement("button"), document.createElement("button"), document.createElement("button")];
        applyRovingTabIndex(elements, 1);
        expect(elements.map(element => element.tabIndex)).toEqual([-1, 0, -1]);
    });

    test("keyboard handler moves focus and prevents handled arrow keys", () => {
        const root = appendFixture('<button id="a">A</button><button id="b">B</button><button id="c">C</button>');
        const elements = Array.from(root.querySelectorAll("button"));
        applyRovingTabIndex(elements, 0);
        elements[0].focus();
        const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
        Object.defineProperty(event, "currentTarget", { value: elements[0] });
        expect(handleRovingKeyDown(event, elements, { orientation: "horizontal" })).toBe(1);
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(elements[1]);
    });
});

describe("accessibilityRuntime announcements and media", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.useRealTimers();
    });

    test("creates, updates and destroys a live region", () => {
        jest.useFakeTimers();
        const live = createLiveRegion(document.body, { id: "live-test" });
        expect(live.element).toHaveAttribute("role", "status");
        expect(live.element).toHaveAttribute("aria-live", "polite");

        live.announce("Harita hazır");
        jest.runOnlyPendingTimers();
        expect(live.element).toHaveTextContent("Harita hazır");

        live.announce("Kritik uyarı", "assertive");
        jest.runOnlyPendingTimers();
        expect(live.element).toHaveAttribute("role", "alert");
        expect(live.element).toHaveTextContent("Kritik uyarı");

        live.clear();
        expect(live.element).toHaveTextContent("");
        live.destroy();
        expect(document.querySelector("#live-test")).toBeNull();
    });

    test("reads all supported media preferences", () => {
        const states = {
            "(prefers-reduced-motion: reduce)": true,
            "(forced-colors: active)": true,
            "(prefers-color-scheme: dark)": false,
            "(pointer: coarse)": true,
            "(hover: hover)": false
        };
        const matchMedia = query => ({ matches: Boolean(states[query]) });
        expect(getMediaPreferenceSnapshot(matchMedia)).toEqual({
            reducedMotion: true,
            forcedColors: true,
            prefersDark: false,
            coarsePointer: true,
            hoverCapable: false
        });
    });

    test("subscribes with modern media-query listeners", () => {
        const media = new FakeMediaQuery(false);
        const listener = jest.fn();
        const release = subscribeMediaQuery(media, listener);
        media.emit(true);
        expect(listener).toHaveBeenCalledWith(true);
        release();
        media.emit(false);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test("observer republishes a complete snapshot when one query changes", () => {
        const queries = new Map();
        const matchMedia = query => {
            if (!queries.has(query)) queries.set(query, new FakeMediaQuery(false));
            return queries.get(query);
        };
        const listener = jest.fn();
        const release = installMediaPreferenceObserver(listener, matchMedia);
        expect(listener).toHaveBeenCalledTimes(1);

        queries.get("(prefers-color-scheme: dark)").emit(true);
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ prefersDark: true }));
        release();
    });
});

describe("accessibilityRuntime skip links, shortcuts and touch targets", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("prepares and activates a skip target", () => {
        const target = document.createElement("main");
        document.body.appendChild(target);
        ensureSkipTarget(target);
        expect(target).toHaveAttribute("tabindex", "-1");
        expect(activateSkipTarget(target)).toBe(true);
        expect(document.activeElement).toBe(target);
    });

    test("describes keyboard shortcuts for screen-reader copy", () => {
        expect(describeKeyboardShortcut(["Ctrl", "K"])).toBe("Kontrol artı K");
        expect(describeKeyboardShortcut(["Alt", "ArrowDown"])).toBe("Alt artı Aşağı ok");
    });

    test("detects typing targets before handling global shortcuts", () => {
        const input = document.createElement("input");
        const textarea = document.createElement("textarea");
        const button = document.createElement("button");
        const editable = document.createElement("div");
        editable.contentEditable = "true";
        document.body.append(input, textarea, button, editable);

        expect(isTypingTarget(input)).toBe(true);
        expect(isTypingTarget(textarea)).toBe(true);
        expect(isTypingTarget(button)).toBe(false);
        expect(isTypingTarget(editable)).toBe(true);
        expect(shouldHandleGlobalShortcut({ defaultPrevented: false, isComposing: false, target: button })).toBe(true);
        expect(shouldHandleGlobalShortcut({ defaultPrevented: false, isComposing: false, target: input })).toBe(false);
        expect(shouldHandleGlobalShortcut({ defaultPrevented: true, isComposing: false, target: button })).toBe(false);
        expect(shouldHandleGlobalShortcut({ defaultPrevented: false, isComposing: true, target: button })).toBe(false);
    });

    test("checks minimum touch target geometry", () => {
        const large = document.createElement("button");
        const small = document.createElement("button");
        large.getBoundingClientRect = () => rect(48, 48);
        small.getBoundingClientRect = () => rect(28, 30);
        document.body.append(large, small);

        expect(touchTargetMeetsMinimum(large)).toBe(true);
        expect(touchTargetMeetsMinimum(small)).toBe(false);
        expect(findSmallTouchTargets(document.body)).toEqual([small]);
    });
});
