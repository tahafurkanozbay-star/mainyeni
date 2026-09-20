import { createOverlayCoordinator, type OverlayDismissReason } from "./overlayCoordinator";

const setup = () => {
    document.body.innerHTML = `
        <main id="app">
            <button id="trigger">Detay aç</button>
            <section id="content"><a href="#x">İçerik</a></section>
            <div id="portal"></div>
        </main>`;
    const app = document.querySelector("#app") as HTMLElement;
    const portal = document.querySelector("#portal") as HTMLElement;
    const trigger = document.querySelector("#trigger") as HTMLButtonElement;
    return { app, portal, trigger };
};

const dialog = (portal: HTMLElement, id = "dialog"): HTMLElement => {
    const node = document.createElement("section");
    node.id = id;
    node.setAttribute("aria-label", "Detay");
    node.innerHTML = `<button id="${id}-first">İlk</button><button id="${id}-last">Son</button>`;
    portal.append(node);
    return node;
};

const key = (target: HTMLElement, value: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
};

const flushFocus = (): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
};

afterEach(() => {
    document.body.replaceChildren();
    document.body.style.overflow = "";
});

describe("OverlayCoordinator semantics", () => {
    test("adds dialog and modal semantics without replacing an authored role", () => {
        const { app, portal } = setup();
        const node = dialog(portal);
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "details", element: node, kind: "dialog" });
        expect(node.getAttribute("role")).toBe("dialog");
        expect(node.getAttribute("aria-modal")).toBe("true");
        expect(node.getAttribute("data-overlay-kind")).toBe("dialog");
        expect(node.hasAttribute("data-overlay-topmost")).toBe(true);
        coordinator.destroy();
    });

    test("non-modal map panels do not claim aria-modal", () => {
        const { app, portal } = setup();
        const node = dialog(portal);
        node.setAttribute("role", "region");
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "layers", element: node, kind: "map-panel", modality: "non-modal" });
        expect(node.getAttribute("role")).toBe("region");
        expect(node.hasAttribute("aria-modal")).toBe(false);
        coordinator.destroy();
    });

    test("rejects blank and duplicate identifiers", () => {
        const { app, portal } = setup();
        const coordinator = createOverlayCoordinator({ appRoot: app });
        expect(() => coordinator.open({ id: " ", element: dialog(portal), kind: "dialog" })).toThrow(/boş/);
        coordinator.open({ id: "same", element: dialog(portal, "one"), kind: "dialog" });
        expect(() => coordinator.open({ id: "same", element: dialog(portal, "two"), kind: "dialog" })).toThrow(/zaten açık/);
        coordinator.destroy();
    });

    test("rejects detached overlay nodes", () => {
        const { app } = setup();
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const detached = document.createElement("section");
        expect(() => coordinator.open({ id: "detached", element: detached, kind: "dialog" })).toThrow(/DOM/);
        coordinator.destroy();
    });
});

describe("OverlayCoordinator stack lifecycle", () => {
    test("tracks deterministic topmost order", () => {
        const { app, portal } = setup();
        const first = dialog(portal, "first");
        const second = dialog(portal, "second");
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const firstHandle = coordinator.open({ id: "first", element: first, kind: "drawer" });
        coordinator.open({ id: "second", element: second, kind: "sheet" });
        expect(coordinator.snapshot()).toMatchObject({ size: 2, modalCount: 2, topmostId: "second" });
        expect(first.hasAttribute("data-overlay-topmost")).toBe(false);
        expect(second.hasAttribute("data-overlay-topmost")).toBe(true);
        firstHandle.bringToFront();
        expect(coordinator.snapshot().topmostId).toBe("first");
        expect(first.hasAttribute("data-overlay-topmost")).toBe(true);
        coordinator.destroy();
    });

    test("emits immutable snapshots after mutations", () => {
        const { app, portal } = setup();
        const snapshots: string[] = [];
        const coordinator = createOverlayCoordinator({ appRoot: app, onChange: (value) => snapshots.push(`${value.size}:${value.topmostId}`) });
        const handle = coordinator.open({ id: "details", element: dialog(portal), kind: "dialog" });
        handle.update({ kind: "drawer" });
        handle.close();
        expect(snapshots).toEqual(["1:details", "1:details", "0:null"]);
        coordinator.destroy();
    });

    test("handle reports open state and close is idempotent", () => {
        const { app, portal } = setup();
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const handle = coordinator.open({ id: "details", element: dialog(portal), kind: "dialog" });
        expect(handle.isOpen()).toBe(true);
        handle.close();
        handle.close();
        expect(handle.isOpen()).toBe(false);
        expect(coordinator.snapshot().size).toBe(0);
        coordinator.destroy();
    });
});

describe("OverlayCoordinator focus and dismissal", () => {
    test("focuses the first control and restores the trigger", () => {
        const { app, portal, trigger } = setup();
        trigger.focus();
        const node = dialog(portal);
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const handle = coordinator.open({ id: "details", element: node, kind: "dialog", trigger });
        expect(document.activeElement?.id).toBe("dialog-first");
        handle.close();
        expect(document.activeElement).toBe(trigger);
        coordinator.destroy();
    });

    test("supports an explicit initial focus target", () => {
        const { app, portal } = setup();
        const node = dialog(portal);
        const last = node.querySelector("#dialog-last") as HTMLElement;
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "details", element: node, kind: "dialog", initialFocus: last });
        expect(document.activeElement).toBe(last);
        coordinator.destroy();
    });

    test("cycles Tab from last to first", () => {
        const { app, portal } = setup();
        const node = dialog(portal);
        const first = node.querySelector("#dialog-first") as HTMLElement;
        const last = node.querySelector("#dialog-last") as HTMLElement;
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "details", element: node, kind: "dialog" });
        last.focus();
        const event = key(last, "Tab");
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(first);
        coordinator.destroy();
    });

    test("cycles Shift+Tab from first to last", () => {
        const { app, portal } = setup();
        const node = dialog(portal);
        const first = node.querySelector("#dialog-first") as HTMLElement;
        const last = node.querySelector("#dialog-last") as HTMLElement;
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "details", element: node, kind: "dialog" });
        first.focus();
        const event = key(first, "Tab", { shiftKey: true });
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(last);
        coordinator.destroy();
    });

    test("routes Escape only to the topmost overlay", () => {
        const { app, portal } = setup();
        const reasons: string[] = [];
        const first = dialog(portal, "first");
        const second = dialog(portal, "second");
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "first", element: first, kind: "dialog", onRequestClose: (reason) => reasons.push(`first:${reason}`) });
        coordinator.open({ id: "second", element: second, kind: "dialog", onRequestClose: (reason) => reasons.push(`second:${reason}`) });
        const event = key(second, "Escape");
        expect(event.defaultPrevented).toBe(true);
        expect(reasons).toEqual(["second:escape"]);
        coordinator.destroy();
    });

    test("honors closeOnEscape false", () => {
        const { app, portal } = setup();
        const reasons: OverlayDismissReason[] = [];
        const node = dialog(portal);
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "details", element: node, kind: "dialog", closeOnEscape: false, onRequestClose: (reason) => reasons.push(reason) });
        const event = key(node, "Escape");
        expect(event.defaultPrevented).toBe(false);
        expect(reasons).toEqual([]);
        coordinator.destroy();
    });

    test("requestClose can be delegated to controlled UI state", () => {
        const { app, portal } = setup();
        const reasons: OverlayDismissReason[] = [];
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const handle = coordinator.open({ id: "details", element: dialog(portal), kind: "dialog", onRequestClose: (reason) => reasons.push(reason) });
        handle.requestClose("backdrop");
        expect(reasons).toEqual(["backdrop"]);
        expect(handle.isOpen()).toBe(true);
        coordinator.destroy();
    });

    test("requestClose closes uncontrolled overlays", () => {
        const { app, portal } = setup();
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const handle = coordinator.open({ id: "details", element: dialog(portal), kind: "dialog" });
        handle.requestClose("backdrop");
        expect(handle.isOpen()).toBe(false);
        coordinator.destroy();
    });

    test("closeOnBackdrop false blocks backdrop dismissal", () => {
        const { app, portal } = setup();
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const handle = coordinator.open({ id: "details", element: dialog(portal), kind: "dialog", closeOnBackdrop: false });
        handle.requestClose("backdrop");
        expect(handle.isOpen()).toBe(true);
        coordinator.destroy();
    });
});

describe("OverlayCoordinator inert and scroll policy", () => {
    test("inerts siblings of the overlay portal while a modal is open", () => {
        const { app, portal } = setup();
        const content = document.querySelector("#content") as HTMLElement;
        const trigger = document.querySelector("#trigger") as HTMLElement;
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const handle = coordinator.open({ id: "details", element: dialog(portal), kind: "dialog" });
        expect(content.hasAttribute("inert")).toBe(true);
        expect(content.getAttribute("aria-hidden")).toBe("true");
        expect(trigger.hasAttribute("inert")).toBe(true);
        expect(portal.hasAttribute("inert")).toBe(false);
        handle.close();
        expect(content.hasAttribute("inert")).toBe(false);
        expect(content.hasAttribute("aria-hidden")).toBe(false);
        coordinator.destroy();
    });

    test("preserves authored inert and aria-hidden state", () => {
        const { app, portal } = setup();
        const content = document.querySelector("#content") as HTMLElement;
        content.setAttribute("inert", "");
        content.setAttribute("aria-hidden", "false");
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const handle = coordinator.open({ id: "details", element: dialog(portal), kind: "dialog" });
        handle.close();
        expect(content.hasAttribute("inert")).toBe(true);
        expect(content.getAttribute("aria-hidden")).toBe("false");
        coordinator.destroy();
    });

    test("locks and restores body scrolling for modal overlays", () => {
        const { app, portal } = setup();
        document.body.style.overflow = "clip";
        const coordinator = createOverlayCoordinator({ appRoot: app });
        const handle = coordinator.open({ id: "details", element: dialog(portal), kind: "dialog" });
        expect(document.body.style.overflow).toBe("hidden");
        handle.close();
        expect(document.body.style.overflow).toBe("clip");
        coordinator.destroy();
    });

    test("non-modal map panels neither inert app content nor lock scroll", () => {
        const { app, portal } = setup();
        const content = document.querySelector("#content") as HTMLElement;
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "layers", element: dialog(portal), kind: "map-panel", modality: "non-modal" });
        expect(content.hasAttribute("inert")).toBe(false);
        expect(document.body.style.overflow).toBe("");
        coordinator.destroy();
    });

    test("modal policy can opt out of sibling inerting and scroll lock", () => {
        const { app, portal } = setup();
        const content = document.querySelector("#content") as HTMLElement;
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({
            id: "details",
            element: dialog(portal),
            kind: "dialog",
            inertSiblings: false,
            lockDocumentScroll: false
        });
        expect(content.hasAttribute("inert")).toBe(false);
        expect(document.body.style.overflow).toBe("");
        coordinator.destroy();
    });
});

describe("OverlayCoordinator cleanup", () => {
    test("destroy removes policy side effects and blocks future opens", () => {
        const { app, portal } = setup();
        const node = dialog(portal);
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "details", element: node, kind: "dialog" });
        coordinator.destroy();
        expect(document.body.style.overflow).toBe("");
        expect(node.hasAttribute("data-overlay-topmost")).toBe(false);
        expect(() => coordinator.open({ id: "again", element: node, kind: "dialog" })).toThrow(/destroy/);
    });

    test("closing a top modal reactivates focus containment for the next modal", () => {
        const { app, portal } = setup();
        const first = dialog(portal, "first");
        const second = dialog(portal, "second");
        const coordinator = createOverlayCoordinator({ appRoot: app });
        coordinator.open({ id: "first", element: first, kind: "dialog" });
        const secondHandle = coordinator.open({ id: "second", element: second, kind: "dialog" });
        secondHandle.close();
        const outside = document.querySelector("#content a") as HTMLElement;
        outside.focus();
        flushFocus();
        expect(first.contains(document.activeElement)).toBe(true);
        coordinator.destroy();
    });
});
