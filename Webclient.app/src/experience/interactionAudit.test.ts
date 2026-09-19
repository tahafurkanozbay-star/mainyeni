import { auditInteractionQuality, formatInteractionAudit } from "./interactionAudit";

const fixture = (html: string): HTMLElement => {
    document.body.innerHTML = `<main id="fixture">${html}</main>`;
    return document.querySelector("#fixture") as HTMLElement;
};

afterEach(() => document.body.replaceChildren());

describe("interactionAudit", () => {
    test("accepts semantic controls with valid disclosure contracts", () => {
        const root = fixture(`
            <button aria-expanded="false" aria-controls="panel">Katmanlar</button>
            <section id="panel">İçerik</section>
            <a href="/help" aria-current="page">Yardım</a>
        `);
        expect(auditInteractionQuality(root).issues).toEqual([]);
    });

    test("reports pointer-only generic elements", () => {
        const root = fixture('<div onclick="void 0">Haritayı aç</div>');
        expect(auditInteractionQuality(root).counts["pointer-only-action"]).toBe(1);
    });

    test("accepts pointer handlers on native controls", () => {
        const root = fixture('<button onclick="void 0">Haritayı aç</button>');
        expect(auditInteractionQuality(root).counts["pointer-only-action"]).toBe(0);
    });

    test("reports nested interactive controls", () => {
        const root = fixture('<button>Menü <a href="/x">Detay</a></button>');
        const result = auditInteractionQuality(root);
        expect(result.counts["nested-interactive"]).toBe(1);
        expect(result.errors).toBe(1);
    });

    test("reports aria-disabled controls that remain tabbable", () => {
        const root = fixture('<div role="button" tabindex="0" aria-disabled="true">Sil</div>');
        expect(auditInteractionQuality(root).counts["disabled-but-focusable"]).toBe(1);
    });

    test("allows intentional focus on aria-disabled controls", () => {
        const root = fixture('<div role="button" tabindex="0" aria-disabled="true" data-allow-disabled-focus="true">Sil</div>');
        expect(auditInteractionQuality(root).counts["disabled-but-focusable"]).toBe(0);
    });

    test("validates aria-expanded values", () => {
        const root = fixture('<button aria-expanded="mixed">Menü</button>');
        expect(auditInteractionQuality(root).counts["invalid-aria-expanded"]).toBe(1);
    });

    test("validates aria-controls targets", () => {
        const root = fixture('<button aria-expanded="true" aria-controls="missing">Menü</button>');
        expect(auditInteractionQuality(root).counts["invalid-aria-controls"]).toBe(1);
    });

    test("accepts multiple aria-controls targets", () => {
        const root = fixture('<button aria-expanded="true" aria-controls="one two">Menü</button><div id="one"></div><div id="two"></div>');
        expect(auditInteractionQuality(root).counts["invalid-aria-controls"]).toBe(0);
    });

    test("requires complete tab semantics", () => {
        const root = fixture('<button role="tab">Harita</button>');
        expect(auditInteractionQuality(root).counts["invalid-tab-contract"]).toBe(2);
    });

    test("accepts complete tab semantics", () => {
        const root = fixture('<button role="tab" aria-selected="true" aria-controls="map-panel">Harita</button><section id="map-panel" role="tabpanel"></section>');
        expect(auditInteractionQuality(root).counts["invalid-tab-contract"]).toBe(0);
    });

    test("validates aria-current token", () => {
        const root = fixture('<a href="/" aria-current="selected">Ana sayfa</a>');
        expect(auditInteractionQuality(root).counts["invalid-current-contract"]).toBe(1);
    });

    test.each(["page", "step", "location", "date", "time", "true", "false"])("accepts aria-current=%s", token => {
        const root = fixture(`<a href="/" aria-current="${token}">Konum</a>`);
        expect(auditInteractionQuality(root).counts["invalid-current-contract"]).toBe(0);
    });

    test("requires announcement semantics for dynamic status", () => {
        const root = fixture('<div data-dynamic-status="true">12 sonuç bulundu</div>');
        expect(auditInteractionQuality(root).counts["unannounced-live-region"]).toBe(1);
    });

    test("accepts role=status dynamic status", () => {
        const root = fixture('<div data-dynamic-status="true" role="status">12 sonuç bulundu</div>');
        expect(auditInteractionQuality(root).counts["unannounced-live-region"]).toBe(0);
    });

    test("accepts polite live region", () => {
        const root = fixture('<div data-dynamic-status="true" aria-live="polite">Yükleniyor</div>');
        expect(auditInteractionQuality(root).counts["unannounced-live-region"]).toBe(0);
    });

    test("warns for autofocus", () => {
        const root = fixture('<input autofocus>');
        const result = auditInteractionQuality(root);
        expect(result.counts.autofocus).toBe(1);
        expect(result.warnings).toBe(1);
    });

    test("requires reduced-motion contract for marked motion", () => {
        const root = fixture('<div data-motion="panel-slide"></div>');
        expect(auditInteractionQuality(root).counts["motion-without-opt-out"]).toBe(1);
    });

    test("accepts explicit reduced-motion support", () => {
        const root = fixture('<div data-motion="panel-slide" data-reduced-motion="supported"></div>');
        expect(auditInteractionQuality(root).counts["motion-without-opt-out"]).toBe(0);
    });

    test("does not require motion opt-out while reduced motion is active", () => {
        const root = fixture('<div data-motion="panel-slide"></div>');
        expect(auditInteractionQuality(root, { reducedMotion: true }).counts["motion-without-opt-out"]).toBe(0);
    });

    test("geometry audit reports undersized touch targets", () => {
        const root = fixture('<button id="tiny">+</button>');
        const button = root.querySelector("#tiny") as HTMLButtonElement;
        button.getBoundingClientRect = () => ({ width: 24, height: 20, top: 0, left: 0, right: 24, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
        expect(auditInteractionQuality(root, { inspectGeometry: true }).counts["tiny-touch-target"]).toBe(1);
    });

    test("geometry audit accepts 44px target", () => {
        const root = fixture('<button id="ok">+</button>');
        const button = root.querySelector("#ok") as HTMLButtonElement;
        button.getBoundingClientRect = () => ({ width: 44, height: 44, top: 0, left: 0, right: 44, bottom: 44, x: 0, y: 0, toJSON: () => ({}) });
        expect(auditInteractionQuality(root, { inspectGeometry: true }).counts["tiny-touch-target"]).toBe(0);
    });

    test("minimum touch size cannot be weakened below 24px", () => {
        const root = fixture('<button id="tiny">+</button>');
        const button = root.querySelector("#tiny") as HTMLButtonElement;
        button.getBoundingClientRect = () => ({ width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
        expect(auditInteractionQuality(root, { inspectGeometry: true, minimumTouchSize: 1 }).counts["tiny-touch-target"]).toBe(1);
    });

    test("format returns concise clean result", () => {
        expect(formatInteractionAudit(auditInteractionQuality(fixture('<button>Harita</button>')))).toBe("Etkileşim denetimi sorun bulmadı.");
    });

    test("format reports errors and warnings", () => {
        const result = auditInteractionQuality(fixture('<div onclick="void 0"></div><input autofocus>'));
        const text = formatInteractionAudit(result);
        expect(text).toContain("1 hata");
        expect(text).toContain("1 uyarı");
    });
});
