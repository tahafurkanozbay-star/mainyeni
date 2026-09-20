import { createLiveRegionCoordinator } from "./liveRegionCoordinator";

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe("LiveRegionCoordinator regions", () => {
    test("creates semantic polite and assertive regions", () => {
        const coordinator = createLiveRegionCoordinator();
        const polite = document.querySelector('[data-experience-live-region="polite"]') as HTMLElement;
        const assertive = document.querySelector('[data-experience-live-region="assertive"]') as HTMLElement;
        expect(polite).toBeTruthy();
        expect(polite.getAttribute("role")).toBe("status");
        expect(polite.getAttribute("aria-live")).toBe("polite");
        expect(polite.getAttribute("aria-atomic")).toBe("true");
        expect(assertive.getAttribute("role")).toBe("alert");
        expect(assertive.getAttribute("aria-live")).toBe("assertive");
        coordinator.destroy();
    });

    test("reuses supplied regions without removing them on destroy", () => {
        const polite = document.createElement("div");
        const assertive = document.createElement("div");
        document.body.append(polite, assertive);
        const coordinator = createLiveRegionCoordinator({ politeRegion: polite, assertiveRegion: assertive });
        coordinator.destroy();
        expect(polite.isConnected).toBe(true);
        expect(assertive.isConnected).toBe(true);
    });
});

describe("LiveRegionCoordinator delivery", () => {
    beforeEach(() => vi.useFakeTimers());

    test("delivers a polite message after the bounded delay", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 40 });
        expect(coordinator.announce("Katman yüklendi")).toBe(true);
        expect(coordinator.snapshot().queued).toBe(1);
        vi.advanceTimersByTime(39);
        expect(coordinator.snapshot().delivered).toBe(0);
        vi.advanceTimersByTime(1);
        expect(document.querySelector('[data-experience-live-region="polite"]')?.textContent).toBe("Katman yüklendi");
        expect(coordinator.snapshot()).toMatchObject({ queued: 0, delivered: 1, lastMessage: "Katman yüklendi" });
        coordinator.destroy();
    });

    test("routes assertive announcements to the alert region", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 0 });
        coordinator.announce({ message: "Bağlantı kesildi", politeness: "assertive", priority: "high" });
        vi.runOnlyPendingTimers();
        expect(document.querySelector('[data-experience-live-region="assertive"]')?.textContent).toBe("Bağlantı kesildi");
        coordinator.destroy();
    });

    test("normalizes whitespace and rejects blank announcements", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 0 });
        expect(coordinator.announce("   ")).toBe(false);
        coordinator.announce("  Harita   hazır  ");
        vi.runOnlyPendingTimers();
        expect(coordinator.snapshot().lastMessage).toBe("Harita hazır");
        coordinator.destroy();
    });

    test("prioritizes high priority ready messages", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 0 });
        coordinator.announce({ message: "Düşük", priority: "low" });
        coordinator.announce({ message: "Yüksek", priority: "high" });
        vi.runOnlyPendingTimers();
        expect(coordinator.snapshot().lastMessage).toBe("Düşük");
        expect(coordinator.snapshot().delivered).toBe(2);
        coordinator.destroy();
    });

    test("supports per-message delays", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 0 });
        coordinator.announce({ message: "Sonra", delayMs: 500 });
        coordinator.announce({ message: "Şimdi", delayMs: 0 });
        vi.advanceTimersByTime(0);
        expect(coordinator.snapshot().lastMessage).toBe("Şimdi");
        vi.advanceTimersByTime(500);
        expect(coordinator.snapshot().lastMessage).toBe("Sonra");
        coordinator.destroy();
    });
});

describe("LiveRegionCoordinator dedupe and bounds", () => {
    beforeEach(() => vi.useFakeTimers());

    test("deduplicates queued messages", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 100 });
        expect(coordinator.announce("Aynı mesaj")).toBe(true);
        expect(coordinator.announce("Aynı mesaj")).toBe(false);
        expect(coordinator.snapshot()).toMatchObject({ queued: 1, deduped: 1 });
        coordinator.destroy();
    });

    test("deduplicates recently delivered messages inside the window", () => {
        let now = 1_000;
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 0, dedupeWindowMs: 500, now: () => now });
        coordinator.announce("Hazır");
        vi.runOnlyPendingTimers();
        now = 1_300;
        expect(coordinator.announce("Hazır")).toBe(false);
        now = 1_501;
        expect(coordinator.announce("Hazır")).toBe(true);
        coordinator.destroy();
    });

    test("supports explicit dedupe keys for equivalent wording", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 100 });
        coordinator.announce({ message: "3 sonuç", dedupeKey: "search-results" });
        expect(coordinator.announce({ message: "Üç sonuç bulundu", dedupeKey: "search-results" })).toBe(false);
        coordinator.destroy();
    });

    test("bounds the queue and counts dropped work", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 1000, maxQueue: 2 });
        coordinator.announce({ message: "Bir", priority: "low" });
        coordinator.announce({ message: "İki", priority: "normal" });
        coordinator.announce({ message: "Üç", priority: "high" });
        expect(coordinator.snapshot()).toMatchObject({ queued: 2, dropped: 1 });
        coordinator.destroy();
    });

    test("expires stale queued announcements", () => {
        let now = 0;
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 1000, now: () => now });
        coordinator.announce({ message: "Eski", ttlMs: 100 });
        now = 1001;
        vi.advanceTimersByTime(1000);
        expect(coordinator.snapshot()).toMatchObject({ queued: 0, delivered: 0, dropped: 1 });
        coordinator.destroy();
    });
});

describe("LiveRegionCoordinator cleanup", () => {
    beforeEach(() => vi.useFakeTimers());

    test("clear removes queued work and region content", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 0 });
        coordinator.announce("Hazır");
        vi.runOnlyPendingTimers();
        coordinator.announce({ message: "Bekleyen", delayMs: 1000 });
        coordinator.clear();
        expect(coordinator.snapshot().queued).toBe(0);
        expect(document.querySelector('[data-experience-live-region="polite"]')?.textContent).toBe("");
        vi.advanceTimersByTime(1000);
        expect(coordinator.snapshot().delivered).toBe(1);
        coordinator.destroy();
    });

    test("clear can preserve dedupe history", () => {
        let now = 100;
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 0, dedupeWindowMs: 500, now: () => now });
        coordinator.announce("Hazır");
        vi.runOnlyPendingTimers();
        coordinator.clear({ dedupeHistory: false });
        now = 200;
        expect(coordinator.announce("Hazır")).toBe(false);
        coordinator.destroy();
    });

    test("destroy cancels queued delivery and removes owned regions", () => {
        const coordinator = createLiveRegionCoordinator({ defaultDelayMs: 500 });
        coordinator.announce("Bekleyen");
        coordinator.destroy();
        vi.advanceTimersByTime(500);
        expect(document.querySelectorAll("[data-experience-live-region]")).toHaveLength(0);
        expect(() => coordinator.announce("Yeni")).toThrow(/destroy/);
    });
});
