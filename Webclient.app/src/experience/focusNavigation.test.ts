import {
    createFocusTrap,
    createRovingFocus,
    focusSafely,
    getFocusCandidates,
    isElementDisabled,
    isElementHidden,
    isFocusable,
    moveFocus
} from "./focusNavigation";

const mount = (html: string): HTMLElement => {
    document.body.innerHTML = `<main id="root">${html}</main>`;
    return document.querySelector("#root") as HTMLElement;
};

const key = (target: HTMLElement | Document, value: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
};

const button = (label: string): HTMLButtonElement => {
    const result = document.createElement("button");
    result.textContent = label;
    return result;
};

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe("focus candidate discovery", () => {
    test("discovers native controls and links in document order", () => {
        const root = mount('<button id="a">A</button><a id="b" href="#x">B</a><input id="c" />');
        expect(getFocusCandidates(root).map((item) => item.id)).toEqual(["a", "b", "c"]);
    });

    test("excludes disabled, hidden and negative-order controls by default", () => {
        const root = mount('<button id="a" disabled>A</button><button id="b" hidden>B</button><button id="c">C</button>');
        const negative = button("D");
        negative.id = "d";
        negative.setAttribute("tabindex", "-1");
        root.append(negative);
        expect(getFocusCandidates(root).map((item) => item.id)).toEqual(["c"]);
        expect(getFocusCandidates(root, { includeNegativeTabIndex: true }).map((item) => item.id)).toEqual(["c", "d"]);
    });

    test("honors inert and aria-hidden ancestors", () => {
        const root = mount('<section inert><button id="a">A</button></section><section aria-hidden="true"><button id="b">B</button></section><button id="c">C</button>');
        expect(getFocusCandidates(root).map((item) => item.id)).toEqual(["c"]);
    });

    test("recognizes hidden input as non-focusable", () => {
        const root = mount('<input id="secret" type="hidden" /><input id="visible" />');
        expect(isFocusable(root.querySelector("#secret") as HTMLElement)).toBe(false);
        expect(isFocusable(root.querySelector("#visible") as HTMLElement)).toBe(true);
    });

    test("reports disabled semantics from native and aria contracts", () => {
        const root = mount('<button id="native" disabled>N</button><button id="aria" aria-disabled="true">A</button>');
        expect(isElementDisabled(root.querySelector("#native") as HTMLElement)).toBe(true);
        expect(isElementDisabled(root.querySelector("#aria") as HTMLElement)).toBe(true);
    });

    test("reports hidden semantics from element and ancestor contracts", () => {
        const root = mount('<div hidden><button id="nested">N</button></div><button id="visible">V</button>');
        expect(isElementHidden(root.querySelector("#nested") as HTMLElement)).toBe(true);
        expect(isElementHidden(root.querySelector("#visible") as HTMLElement)).toBe(false);
    });

    test("can include a focusable container", () => {
        const root = mount('<button id="child">Child</button>');
        root.setAttribute("tabindex", "0");
        expect(getFocusCandidates(root, { includeContainer: true })).toEqual([root, root.querySelector("#child")]);
    });
});

describe("safe focus and sequential movement", () => {
    test("focuses connected controls", () => {
        const root = mount('<button id="target">Target</button>');
        const target = root.querySelector("#target") as HTMLElement;
        expect(focusSafely(target)).toBe(true);
        expect(document.activeElement).toBe(target);
    });

    test("refuses detached controls", () => {
        expect(focusSafely(button("Detached"))).toBe(false);
    });

    test("moves to first and last candidates", () => {
        const root = mount('<button id="a">A</button><button id="b">B</button>');
        expect(moveFocus(root, "first").to?.id).toBe("a");
        expect(moveFocus(root, "last").to?.id).toBe("b");
    });

    test("moves next and previous from active control", () => {
        const root = mount('<button id="a">A</button><button id="b">B</button><button id="c">C</button>');
        (root.querySelector("#b") as HTMLElement).focus();
        expect(moveFocus(root, "next").to?.id).toBe("c");
        expect(moveFocus(root, "previous").to?.id).toBe("b");
    });

    test("wraps sequential movement by default", () => {
        const root = mount('<button id="a">A</button><button id="b">B</button>');
        (root.querySelector("#b") as HTMLElement).focus();
        const result = moveFocus(root, "next");
        expect(result.to?.id).toBe("a");
        expect(result.wrapped).toBe(true);
    });

    test("can stop at sequence boundaries", () => {
        const root = mount('<button id="a">A</button><button id="b">B</button>');
        (root.querySelector("#b") as HTMLElement).focus();
        const result = moveFocus(root, "next", { loop: false });
        expect(result.moved).toBe(false);
        expect(result.to?.id).toBe("b");
    });

    test("returns an empty result when no candidates exist", () => {
        const root = mount('<div>Static</div>');
        expect(moveFocus(root, "first")).toMatchObject({ moved: false, to: null, wrapped: false });
    });
});

describe("focus trap", () => {
    test("moves initial focus into the trap", () => {
        const root = mount('<button id="outside">Outside</button><section id="dialog"><button id="first">First</button><button id="last">Last</button></section>');
        const outside = root.querySelector("#outside") as HTMLElement;
        outside.focus();
        const trap = createFocusTrap({ container: root.querySelector("#dialog") as HTMLElement });
        trap.activate();
        expect((document.activeElement as HTMLElement).id).toBe("first");
        trap.deactivate();
        expect(document.activeElement).toBe(outside);
    });

    test("uses an explicit initial focus target", () => {
        const root = mount('<section id="dialog"><button id="first">First</button><button id="last">Last</button></section>');
        const last = root.querySelector("#last") as HTMLElement;
        const trap = createFocusTrap({ container: root.querySelector("#dialog") as HTMLElement, initialFocus: last });
        trap.activate();
        expect(document.activeElement).toBe(last);
        trap.deactivate({ restoreFocus: false });
    });

    test("wraps Tab from the last control", () => {
        const root = mount('<section id="dialog"><button id="first">First</button><button id="last">Last</button></section>');
        const dialog = root.querySelector("#dialog") as HTMLElement;
        const first = root.querySelector("#first") as HTMLElement;
        const last = root.querySelector("#last") as HTMLElement;
        const trap = createFocusTrap({ container: dialog });
        trap.activate();
        last.focus();
        const event = key(document, "Tab");
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(first);
        trap.deactivate({ restoreFocus: false });
    });

    test("wraps reverse Tab from the first control", () => {
        const root = mount('<section id="dialog"><button id="first">First</button><button id="last">Last</button></section>');
        const dialog = root.querySelector("#dialog") as HTMLElement;
        const first = root.querySelector("#first") as HTMLElement;
        const last = root.querySelector("#last") as HTMLElement;
        const trap = createFocusTrap({ container: dialog });
        trap.activate();
        first.focus();
        key(document, "Tab", { shiftKey: true });
        expect(document.activeElement).toBe(last);
        trap.deactivate({ restoreFocus: false });
    });

    test("recovers focus that escapes the trap", () => {
        const root = mount('<button id="outside">Outside</button><section id="dialog"><button id="inside">Inside</button></section>');
        const outside = root.querySelector("#outside") as HTMLElement;
        const trap = createFocusTrap({ container: root.querySelector("#dialog") as HTMLElement });
        trap.activate();
        outside.focus();
        outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        expect((document.activeElement as HTMLElement).id).toBe("inside");
        trap.deactivate({ restoreFocus: false });
    });

    test("focuses the container when the trap has no controls", () => {
        const root = mount('<section id="dialog"><p>Bilgi</p></section>');
        const dialog = root.querySelector("#dialog") as HTMLElement;
        const trap = createFocusTrap({ container: dialog });
        trap.activate();
        expect(document.activeElement).toBe(dialog);
        expect(dialog.getAttribute("tabindex")).toBe("-1");
        trap.deactivate({ restoreFocus: false });
        expect(dialog.hasAttribute("tabindex")).toBe(false);
    });

    test("signals escape without silently deactivating lifecycle", () => {
        const root = mount('<section id="dialog"><button>Inside</button></section>');
        const onEscape = vi.fn();
        const trap = createFocusTrap({ container: root.querySelector("#dialog") as HTMLElement, onEscape });
        trap.activate();
        const event = key(document, "Escape");
        expect(event.defaultPrevented).toBe(true);
        expect(onEscape).toHaveBeenCalledTimes(1);
        expect(trap.isActive()).toBe(true);
        trap.deactivate({ restoreFocus: false });
    });

    test("can preserve Escape for an owning surface", () => {
        const root = mount('<section id="dialog"><button>Inside</button></section>');
        const onEscape = vi.fn();
        const trap = createFocusTrap({ container: root.querySelector("#dialog") as HTMLElement, escapeDeactivates: false, onEscape });
        trap.activate();
        const event = key(document, "Escape");
        expect(event.defaultPrevented).toBe(false);
        expect(onEscape).not.toHaveBeenCalled();
        trap.deactivate({ restoreFocus: false });
    });

    test("activation and deactivation are idempotent", () => {
        const root = mount('<section id="dialog"><button>Inside</button></section>');
        const onActivate = vi.fn();
        const onDeactivate = vi.fn();
        const trap = createFocusTrap({ container: root.querySelector("#dialog") as HTMLElement, onActivate, onDeactivate });
        trap.activate(); trap.activate();
        trap.deactivate({ restoreFocus: false }); trap.deactivate({ restoreFocus: false });
        expect(onActivate).toHaveBeenCalledTimes(1);
        expect(onDeactivate).toHaveBeenCalledTimes(1);
    });
});

describe("roving focus", () => {
    const setup = (extra: Partial<Parameters<typeof createRovingFocus>[0]> = {}) => {
        const root = mount('<div id="tabs"><button data-item id="a">Adres</button><button data-item id="b">Bina</button><button data-item id="c">Cadde</button></div>');
        const container = root.querySelector("#tabs") as HTMLElement;
        const controller = createRovingFocus({ container, itemSelector: "[data-item]", ...extra });
        return { root, container, controller };
    };

    test("creates one natural tab stop", () => {
        const { container, controller } = setup();
        expect(Array.from(container.querySelectorAll("button")).map((item) => item.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
        controller.destroy();
    });

    test("moves with horizontal arrows", () => {
        const { container, controller } = setup({ orientation: "horizontal" });
        const first = container.querySelector("#a") as HTMLElement;
        first.focus();
        key(first, "ArrowRight");
        expect((document.activeElement as HTMLElement).id).toBe("b");
        key(document.activeElement as HTMLElement, "ArrowLeft");
        expect((document.activeElement as HTMLElement).id).toBe("a");
        controller.destroy();
    });

    test("ignores vertical arrows for horizontal groups", () => {
        const { container, controller } = setup({ orientation: "horizontal" });
        const first = container.querySelector("#a") as HTMLElement;
        first.focus();
        key(first, "ArrowDown");
        expect(document.activeElement).toBe(first);
        controller.destroy();
    });

    test("wraps arrow navigation", () => {
        const { container, controller } = setup({ orientation: "horizontal" });
        controller.setCurrent(2);
        const last = container.querySelector("#c") as HTMLElement;
        key(last, "ArrowRight");
        expect((document.activeElement as HTMLElement).id).toBe("a");
        controller.destroy();
    });

    test("can clamp arrow navigation", () => {
        const { container, controller } = setup({ orientation: "horizontal", loop: false });
        controller.setCurrent(2);
        const last = container.querySelector("#c") as HTMLElement;
        key(last, "ArrowRight");
        expect(document.activeElement).toBe(last);
        controller.destroy();
    });

    test("supports Home and End", () => {
        const { container, controller } = setup();
        controller.setCurrent(1);
        key(container.querySelector("#b") as HTMLElement, "End");
        expect((document.activeElement as HTMLElement).id).toBe("c");
        key(document.activeElement as HTMLElement, "Home");
        expect((document.activeElement as HTMLElement).id).toBe("a");
        controller.destroy();
    });

    test("skips disabled items", () => {
        const { container, controller } = setup({ disabled: (item) => item.id === "b" });
        const first = container.querySelector("#a") as HTMLElement;
        first.focus();
        key(first, "ArrowRight");
        expect((document.activeElement as HTMLElement).id).toBe("c");
        controller.destroy();
    });

    test("supports Turkish-aware typeahead", () => {
        const { container, controller } = setup();
        const first = container.querySelector("#a") as HTMLElement;
        first.focus();
        key(first, "c");
        expect((document.activeElement as HTMLElement).id).toBe("c");
        controller.destroy();
    });

    test("resets typeahead buffer after timeout", () => {
        vi.useFakeTimers();
        const { container, controller } = setup({ typeaheadTimeoutMs: 200 });
        const first = container.querySelector("#a") as HTMLElement;
        first.focus();
        key(first, "b");
        expect((document.activeElement as HTMLElement).id).toBe("b");
        vi.advanceTimersByTime(250);
        key(document.activeElement as HTMLElement, "a");
        expect((document.activeElement as HTMLElement).id).toBe("a");
        controller.destroy();
    });

    test("preserves the current item across refresh when possible", () => {
        const { container, controller } = setup();
        controller.setCurrent(1, { focus: false });
        container.append(button("Durak"));
        controller.refresh();
        expect(controller.getCurrent()?.id).toBe("b");
        controller.destroy();
    });

    test("falls back when the current item disappears", () => {
        const { container, controller } = setup();
        controller.setCurrent(1, { focus: false });
        container.querySelector("#b")?.remove();
        controller.refresh();
        expect(controller.getCurrent()?.id).toBe("a");
        controller.destroy();
    });

    test("setCurrent rejects unknown targets", () => {
        const { controller } = setup();
        expect(controller.setCurrent(button("Unknown"))).toBe(false);
        controller.destroy();
    });

    test("emits current change with stable index", () => {
        const onCurrentChange = vi.fn();
        const { controller } = setup({ onCurrentChange });
        controller.setCurrent(2, { focus: false });
        expect(onCurrentChange).toHaveBeenLastCalledWith(expect.any(HTMLElement), 2);
        controller.destroy();
    });

    test("destroy detaches keyboard behavior", () => {
        const { container, controller } = setup();
        const first = container.querySelector("#a") as HTMLElement;
        first.focus();
        controller.destroy();
        key(first, "ArrowRight");
        expect(document.activeElement).toBe(first);
    });
});
