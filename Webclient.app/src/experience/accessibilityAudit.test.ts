import { auditAccessibility, formatAccessibilityAudit, getAccessibleName } from "./accessibilityAudit";

const fixture = (html: string): HTMLElement => {
    document.body.innerHTML = `<main id="fixture">${html}</main>`;
    return document.querySelector("#fixture") as HTMLElement;
};

afterEach(() => { document.body.replaceChildren(); });

describe("accessibilityAudit", () => {
    test("accepts labelled native controls and decorative images", () => {
        const root = fixture(`
            <label for="search">Ara</label><input id="search" />
            <button aria-label="Yakınlaştır"><span aria-hidden="true">+</span></button>
            <img alt="" src="marker.svg" />
        `);
        expect(auditAccessibility(root).issues).toEqual([]);
    });

    test("resolves aria-labelledby before aria-label", () => {
        const root = fixture('<span id="label">Katmanlar</span><button id="target" aria-labelledby="label" aria-label="Yedek"></button>');
        expect(getAccessibleName(root.querySelector("#target") as HTMLElement)).toBe("Katmanlar");
    });

    test("reports unnamed interactive controls", () => {
        const root = fixture('<button><span aria-hidden="true"></span></button><a href="#"></a>');
        const result = auditAccessibility(root);
        expect(result.counts["missing-accessible-name"]).toBe(2);
    });

    test("reports positive tabindex and aria-hidden interactive controls", () => {
        const root = fixture('<button tabindex="3" aria-hidden="true">Gizli</button>');
        const result = auditAccessibility(root);
        expect(result.counts["invalid-positive-tabindex"]).toBe(1);
        expect(result.counts["interactive-aria-hidden"]).toBe(1);
    });

    test("reports unnamed dialogs", () => {
        const root = fixture('<section role="dialog"><button>Kapat</button></section>');
        expect(auditAccessibility(root).counts["dialog-without-name"]).toBe(1);
    });

    test("accepts aria-labelledby dialog names", () => {
        const root = fixture('<h2 id="title">Detay</h2><section role="dialog" aria-labelledby="title"><button>Kapat</button></section>');
        expect(auditAccessibility(root).counts["dialog-without-name"]).toBe(0);
    });

    test("requires alt attribute but permits empty decorative alt", () => {
        const root = fixture('<img src="a.png"><img src="b.png" alt="">');
        expect(auditAccessibility(root).counts["image-without-alt"]).toBe(1);
    });

    test("reports unlabelled select and textarea controls", () => {
        const root = fixture('<select><option>A</option></select><textarea></textarea>');
        const result = auditAccessibility(root);
        expect(result.counts["form-control-without-name"]).toBe(2);
    });

    test("detects duplicate ids after the first occurrence", () => {
        const root = fixture('<div id="same"></div><span id="same"></span><p id="same"></p>');
        expect(auditAccessibility(root).counts["duplicate-id"]).toBe(2);
    });

    test("formats a concise Turkish audit summary", () => {
        const root = fixture('<button></button>');
        expect(formatAccessibilityAudit(auditAccessibility(root))).toContain("1 sorun buldu");
        expect(formatAccessibilityAudit(auditAccessibility(fixture('<button>Harita</button>')))).toBe("Erişilebilirlik denetimi sorun bulmadı.");
    });
});
