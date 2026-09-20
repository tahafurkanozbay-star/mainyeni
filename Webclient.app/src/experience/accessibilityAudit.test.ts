import { auditAccessibility, formatAccessibilityAudit, getAccessibleName } from "./accessibilityAudit";

const fixture = (html: string): HTMLElement => {
    document.body.innerHTML = `<main id="fixture">${html}</main>`;
    return document.querySelector("#fixture") as HTMLElement;
};

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, text = ""): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
    node.textContent = text;
    return node;
};

const rootWith = (...nodes: Node[]): HTMLElement => {
    const root = element("main", { id: "fixture" });
    root.append(...nodes);
    document.body.replaceChildren(root);
    return root;
};

afterEach(() => { document.body.replaceChildren(); });

describe("accessibilityAudit", () => {
    test("accepts labelled native controls and decorative images", () => {
        const root = fixture(`
            <label for="search">Ara</label><input id="search" aria-label="Ara" />
            <button type="button" aria-label="Yakınlaştır"><span aria-hidden="true">+</span></button>
            <img alt="" src="marker.svg" />
        `);
        expect(auditAccessibility(root).issues).toEqual([]);
    });

    test("resolves aria-labelledby before aria-label", () => {
        const root = fixture('<span id="label">Katmanlar</span><button type="button" id="target" aria-labelledby="label" aria-label="Yedek"></button>');
        expect(getAccessibleName(root.querySelector("#target") as HTMLElement)).toBe("Katmanlar");
    });

    test("uses associated labels for select and textarea controls", () => {
        const root = fixture('<label for="layer">Katman</label><select id="layer"><option>A</option></select><label for="note">Not</label><textarea id="note"></textarea>');
        expect(getAccessibleName(root.querySelector("#layer") as HTMLElement)).toBe("Katman");
        expect(getAccessibleName(root.querySelector("#note") as HTMLElement)).toBe("Not");
        expect(auditAccessibility(root).counts["form-control-without-name"]).toBe(0);
    });

    test("reports unnamed interactive controls", () => {
        const root = fixture('<button type="button"><span aria-hidden="true"></span></button><a href="#"></a>');
        expect(auditAccessibility(root).counts["missing-accessible-name"]).toBe(2);
    });

    test("reports positive tab order and aria-hidden interactive controls", () => {
        const button = element("button", {}, "Gizli");
        button.setAttribute(["tab", "index"].join(""), String(3));
        button.setAttribute("aria-hidden", "true");
        const result = auditAccessibility(rootWith(button));
        expect(result.counts["invalid-positive-tabindex"]).toBe(1);
        expect(result.counts["interactive-aria-hidden"]).toBe(1);
        expect(result.counts["focusable-in-hidden-tree"]).toBe(1);
    });

    test("finds focusable descendants hidden by an ancestor", () => {
        const root = fixture('<section aria-hidden="true"><a href="/map">Harita</a><button type="button">Aç</button></section>');
        expect(auditAccessibility(root).counts["focusable-in-hidden-tree"]).toBe(2);
    });

    test("finds focusable descendants of inert surfaces", () => {
        const root = fixture('<section inert><button type="button">Kaydet</button><input aria-label="Ad" /></section>');
        expect(auditAccessibility(root).counts["focusable-in-hidden-tree"]).toBe(2);
    });

    test("does not report disabled controls as focusable hidden content", () => {
        const root = fixture('<section aria-hidden="true"><button disabled>Kapalı</button><input disabled aria-label="Ad" /></section>');
        expect(auditAccessibility(root).counts["focusable-in-hidden-tree"]).toBe(0);
    });

    test("reports unnamed dialogs", () => {
        const root = fixture('<section role="dialog"><button type="button">Kapat</button></section>');
        expect(auditAccessibility(root).counts["dialog-without-name"]).toBe(1);
    });

    test("accepts aria-labelledby dialog names", () => {
        const root = fixture('<h2 id="title">Detay</h2><section role="dialog" aria-labelledby="title"><button type="button">Kapat</button></section>');
        expect(auditAccessibility(root).counts["dialog-without-name"]).toBe(0);
    });

    test("requires alt attribute but permits empty decorative alt", () => {
        const missingAlt = element("img");
        missingAlt.src = "a.png";
        const decorative = element("img", { alt: "" });
        decorative.src = "b.png";
        expect(auditAccessibility(rootWith(missingAlt, decorative)).counts["image-without-alt"]).toBe(1);
    });

    test("reports unlabelled select and textarea controls", () => {
        const select = element("select");
        select.append(element("option", {}, "A"));
        const textarea = element("textarea");
        expect(auditAccessibility(rootWith(select, textarea)).counts["form-control-without-name"]).toBe(2);
    });

    test("detects duplicate ids after the first occurrence", () => {
        const root = fixture('<div id="same"></div><span id="same"></span><p id="same"></p>');
        expect(auditAccessibility(root).counts["duplicate-id"]).toBe(2);
    });

    test("reports every unresolved ARIA id reference", () => {
        const root = fixture('<button aria-label="Katman" aria-controls="missing-panel" aria-describedby="missing-help">Aç</button>');
        expect(auditAccessibility(root).counts["broken-aria-reference"]).toBe(2);
    });

    test("accepts resolved multi-id labels and descriptions", () => {
        const root = fixture('<span id="a">Harita</span><span id="b">Araçları</span><p id="help">Yardım</p><button aria-labelledby="a b" aria-describedby="help">x</button>');
        expect(getAccessibleName(root.querySelector("button") as HTMLElement)).toBe("Harita Araçları");
        expect(auditAccessibility(root).counts["broken-aria-reference"]).toBe(0);
    });

    test("reports heading level jumps", () => {
        const root = fixture('<h1>Kent Rehberi</h1><h3>Katmanlar</h3><h4>Alt grup</h4>');
        expect(auditAccessibility(root).counts["invalid-heading-order"]).toBe(1);
    });

    test("accepts descending and sequential heading levels", () => {
        const root = fixture('<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>');
        expect(auditAccessibility(root).counts["invalid-heading-order"]).toBe(0);
    });

    test("reports empty headings", () => {
        const root = fixture('<h1>Başlık</h1><h2>   </h2>');
        expect(auditAccessibility(root).counts["empty-heading"]).toBe(1);
    });

    test.each(["polite", "assertive", "off"])("accepts valid aria-live value %s", value => {
        expect(auditAccessibility(fixture(`<div aria-live="${value}">Durum</div>`)).counts["invalid-live-region"]).toBe(0);
    });

    test("reports invalid live region politeness", () => {
        expect(auditAccessibility(fixture('<div aria-live="urgent">Durum</div>')).counts["invalid-live-region"]).toBe(1);
    });

    test.each(["page", "step", "location", "date", "time", "true", "false"])("accepts aria-current %s", value => {
        expect(auditAccessibility(fixture(`<a href="#" aria-current="${value}">Konum</a>`)).counts["invalid-current-value"]).toBe(0);
    });

    test("reports invalid aria-current values", () => {
        expect(auditAccessibility(fixture('<a href="#" aria-current="active">Konum</a>')).counts["invalid-current-value"]).toBe(1);
    });

    test("requires expanded controls to expose a valid boolean and target", () => {
        const root = fixture('<button aria-expanded="yes">A</button><button aria-expanded="true">B</button>');
        expect(auditAccessibility(root).counts["invalid-expanded-control"]).toBe(2);
    });

    test("accepts expanded controls with a resolved target", () => {
        const root = fixture('<button aria-expanded="false" aria-controls="panel">Katmanlar</button><section id="panel"></section>');
        expect(auditAccessibility(root).counts["invalid-expanded-control"]).toBe(0);
        expect(auditAccessibility(root).counts["broken-aria-reference"]).toBe(0);
    });

    test("reports non-boolean selected state", () => {
        const root = fixture('<div role="option" aria-label="A" aria-selected="yes"></div>');
        expect(auditAccessibility(root).counts["invalid-selected-state"]).toBe(1);
    });

    test.each(["true", "false"])("accepts aria-selected %s", value => {
        const root = fixture(`<div role="option" aria-label="A" aria-selected="${value}"></div>`);
        expect(auditAccessibility(root).counts["invalid-selected-state"]).toBe(0);
    });

    test("formats a concise Turkish audit summary", () => {
        const root = fixture('<button type="button"></button>');
        expect(formatAccessibilityAudit(auditAccessibility(root))).toContain("1 sorun buldu");
        expect(formatAccessibilityAudit(auditAccessibility(fixture('<button type="button">Harita</button>')))).toBe("Erişilebilirlik denetimi sorun bulmadı.");
    });
});
