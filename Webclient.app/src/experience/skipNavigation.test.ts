import { createSkipNavigation } from "./skipNavigation";

const setup = () => {
    document.body.innerHTML = '<nav id="skip"></nav><main id="main"><button type="button">İçerik</button></main><aside id="map"></aside>';
    return {
        container: document.querySelector("#skip") as HTMLElement,
        main: document.querySelector("#main") as HTMLElement,
        map: document.querySelector("#map") as HTMLElement
    };
};

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe("skip navigation", () => {
    test("renders deterministic accessible links", () => {
        const view = setup();
        const controller = createSkipNavigation({
            container: view.container,
            targets: [
                { id: "main", label: "Ana içeriğe geç", target: view.main },
                { id: "map", label: "Haritaya geç", target: view.map }
            ],
            className: "skip-link"
        });
        const links = [...view.container.querySelectorAll("a")];
        expect(links.map((link) => link.textContent)).toEqual(["Ana içeriğe geç", "Haritaya geç"]);
        expect(links.map((link) => link.getAttribute("href"))).toEqual(["#main", "#map"]);
        expect(links.every((link) => link.className === "skip-link")).toBe(true);
        controller.destroy();
    });

    test("makes non-focusable landmarks programmatically focusable and restores them", () => {
        const view = setup();
        view.main.removeAttribute("tabindex");
        const controller = createSkipNavigation({ container: view.container, targets: [{ id: "main", label: "İçerik", target: view.main }] });
        expect(view.main.getAttribute("tabindex")).toBe("-1");
        controller.destroy();
        expect(view.main.hasAttribute("tabindex")).toBe(false);
    });

    test("preserves authored tabindex", () => {
        const view = setup();
        view.main.setAttribute("tabindex", "0");
        const controller = createSkipNavigation({ container: view.container, targets: [{ id: "main", label: "İçerik", target: view.main }] });
        controller.destroy();
        expect(view.main.getAttribute("tabindex")).toBe("0");
    });

    test("focuses and reports navigation on activation", () => {
        const view = setup();
        const onNavigate = vi.fn();
        const scrollIntoView = vi.fn();
        view.main.scrollIntoView = scrollIntoView;
        const controller = createSkipNavigation({ container: view.container, targets: [{ id: "main", label: "İçerik", target: view.main }], onNavigate });
        const link = view.container.querySelector("a") as HTMLAnchorElement;
        link.click();
        expect(document.activeElement).toBe(view.main);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
        expect(onNavigate).toHaveBeenCalledWith("main");
        controller.destroy();
    });

    test("filters blank, duplicate and detached targets", () => {
        const view = setup();
        const detached = document.createElement("section");
        const controller = createSkipNavigation({
            container: view.container,
            targets: [
                { id: "", label: "Boş", target: view.main },
                { id: "main", label: "İçerik", target: view.main },
                { id: "main", label: "Tekrar", target: view.map },
                { id: "detached", label: "Detached", target: detached }
            ]
        });
        expect(view.container.querySelectorAll("a")).toHaveLength(1);
        controller.destroy();
    });

    test("filters targets whose labels are blank", () => {
        const view = setup();
        const controller = createSkipNavigation({
            container: view.container,
            targets: [
                { id: "main", label: "   ", target: view.main },
                { id: "map", label: "Haritaya geç", target: view.map }
            ]
        });
        expect(view.container.querySelectorAll("a")).toHaveLength(1);
        expect(view.container.querySelector("a")?.dataset.skipNavigation).toBe("map");
        controller.destroy();
    });

    test("refresh restores temporary tabindex before applying the next target set", () => {
        const view = setup();
        view.main.removeAttribute("tabindex");
        view.map.removeAttribute("tabindex");
        const controller = createSkipNavigation({ container: view.container, targets: [{ id: "main", label: "İçerik", target: view.main }] });
        expect(view.main.getAttribute("tabindex")).toBe("-1");
        controller.refresh([{ id: "map", label: "Harita", target: view.map }]);
        expect(view.main.hasAttribute("tabindex")).toBe(false);
        expect(view.map.getAttribute("tabindex")).toBe("-1");
        controller.destroy();
    });

    test("refresh replaces the active target set", () => {
        const view = setup();
        const controller = createSkipNavigation({ container: view.container, targets: [{ id: "main", label: "İçerik", target: view.main }] });
        controller.refresh([{ id: "map", label: "Harita", target: view.map }]);
        expect(view.container.querySelectorAll("a")).toHaveLength(1);
        expect(view.container.querySelector("a")?.dataset.skipNavigation).toBe("map");
        controller.destroy();
    });

    test("destroy is idempotent and leaves the container empty", () => {
        const view = setup();
        const controller = createSkipNavigation({ container: view.container, targets: [{ id: "main", label: "İçerik", target: view.main }] });
        controller.destroy();
        controller.destroy();
        expect(view.container.childElementCount).toBe(0);
        controller.refresh([{ id: "map", label: "Harita", target: view.map }]);
        expect(view.container.childElementCount).toBe(0);
    });
});
