import {
    GEOCODING_ADAPTER_VERSION,
    GEOCODING_STATUS,
    GeocodingAdapterError,
    createGeocodingAdapter,
    createGeocodingCache,
    createGeocodingProviderRegistry,
    createGeocodingQualityReport,
    createGeocodingRequestKey,
    createStaticGeocodingProvider,
    normalizeGeocodingCandidate,
    normalizeGeocodingConfidence,
    normalizeGeocodingLimit,
    normalizeGeocodingPayload,
    normalizeGeocodingRequest,
    rankGeocodingCandidates,
    throwIfGeocodingAborted
} from "./GeocodingAdapterRuntime";

const candidates = [
    {
        id: "hosdere-10",
        formattedAddress: "Hoşdere Caddesi 10, Ayrancı, Çankaya",
        latitude: 39.895,
        longitude: 32.847,
        confidence: 0.95,
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi",
        door: "10"
    },
    {
        id: "hosdere-12",
        label: "Hoşdere Caddesi 12, Ayrancı, Çankaya",
        location: { lat: 39.8953, lng: 32.8472 },
        score: 88,
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi",
        door: "12"
    },
    {
        id: "tunali-50",
        address: "Tunalı Hilmi Caddesi 50, Kavaklıdere, Çankaya",
        geometry: { x: 32.8607, y: 39.9085 },
        relevance: 0.7,
        district: "Çankaya",
        neighborhood: "Kavaklıdere",
        street: "Tunalı Hilmi Caddesi",
        door: "50"
    }
];

describe("GeocodingAdapterRuntime", () => {
    test("publishes a deterministic adapter version", () => {
        expect(GEOCODING_ADAPTER_VERSION).toBe("1.0.0");
        expect(Object.values(GEOCODING_STATUS)).toEqual(expect.arrayContaining([
            "ok", "empty", "invalid", "aborted", "failed"
        ]));
    });

    test("normalizes limits and confidence values", () => {
        expect(normalizeGeocodingLimit(0)).toBeGreaterThan(0);
        expect(normalizeGeocodingLimit(9999)).toBeLessThanOrEqual(100);
        expect(normalizeGeocodingConfidence(95)).toBe(0.95);
        expect(normalizeGeocodingConfidence(0.42)).toBe(0.42);
        expect(normalizeGeocodingConfidence(-1)).toBe(0);
        expect(normalizeGeocodingConfidence(120)).toBe(1);
        expect(normalizeGeocodingConfidence("unknown")).toBeNull();
    });

    test("normalizes forward request text and Turkish address aliases", () => {
        expect(normalizeGeocodingRequest({
            query: "  Hoşdere Cd. 10 ",
            district: " Çankaya ",
            countryCode: "tr",
            language: "TR",
            limit: 5
        })).toEqual(expect.objectContaining({
            query: "Hoşdere Cd. 10",
            normalizedQuery: "hosdere cadde 10",
            district: "Çankaya",
            countryCode: "TR",
            language: "tr",
            limit: 5
        }));
    });

    test("normalizes reverse request coordinate shapes", () => {
        expect(normalizeGeocodingRequest({ coordinates: [32.847, 39.895] }).coordinates)
            .toEqual({ latitude: 39.895, longitude: 32.847 });
        expect(normalizeGeocodingRequest({ center: { lat: 39.895, lng: 32.847 } }).coordinates)
            .toEqual({ latitude: 39.895, longitude: 32.847 });
    });

    test("creates equivalent cache keys for canonical road aliases", () => {
        const left = createGeocodingRequestKey({ query: "Hoşdere Cd. 10", limit: 5 });
        const right = createGeocodingRequestKey({ query: "hosdere caddesi 10", limit: 5 });
        expect(left).toBe(right);
    });

    test("normalizes provider candidates from common coordinate contracts", () => {
        const first = normalizeGeocodingCandidate(candidates[0], 0, "fixture");
        const second = normalizeGeocodingCandidate(candidates[1], 1, "fixture");
        const third = normalizeGeocodingCandidate(candidates[2], 2, "fixture");
        expect(first).toEqual(expect.objectContaining({
            providerId: "fixture",
            id: "hosdere-10",
            canonicalLabel: "hosdere cadde 10 ayranci cankaya",
            coordinates: { latitude: 39.895, longitude: 32.847 },
            confidence: 0.95
        }));
        expect(second.confidence).toBe(0.88);
        expect(third.coordinates).toEqual({ latitude: 39.9085, longitude: 32.8607 });
    });

    test("rejects candidates without valid coordinates", () => {
        expect(normalizeGeocodingCandidate({ id: 1, label: "Invalid" }, 0, "fixture")).toBeNull();
        expect(normalizeGeocodingCandidate({ coordinates: [500, 500] }, 0, "fixture")).toBeNull();
        expect(normalizeGeocodingCandidate(null, 0, "fixture")).toBeNull();
    });

    test.each([
        [{ results: candidates }, "results"],
        [{ features: candidates }, "features"],
        [{ candidates }, "candidates"],
        [{ items: candidates }, "items"],
        [candidates, "array"]
    ])("normalizes %s payload contract", (payload) => {
        const normalized = normalizeGeocodingPayload(payload, { providerId: "fixture" });
        expect(normalized.candidates).toHaveLength(3);
        expect(normalized.diagnostics).toEqual(expect.objectContaining({
            providerId: "fixture",
            rawCount: 3,
            returnedCount: 3,
            invalidCount: 0
        }));
    });

    test("deduplicates provider payloads by id and coordinate-label fallback", () => {
        const duplicate = { ...candidates[0] };
        const normalized = normalizeGeocodingPayload([candidates[0], duplicate], { providerId: "fixture" });
        expect(normalized.candidates).toHaveLength(1);
        expect(normalized.diagnostics.duplicateCount).toBe(1);
    });

    test("ranks exact query and locality matches above weaker candidates", () => {
        const normalized = normalizeGeocodingPayload(candidates, { providerId: "fixture" }).candidates;
        const ranked = rankGeocodingCandidates(normalized, {
            query: "Hoşdere Caddesi 10, Ayrancı, Çankaya",
            district: "Çankaya",
            neighborhood: "Ayrancı",
            street: "Hoşdere Caddesi"
        });
        expect(ranked[0].id).toBe("hosdere-10");
        expect(ranked[0].geocodingScore).toBeGreaterThan(ranked[2].geocodingScore);
    });

    test("implements bounded TTL/LRU cache behavior", () => {
        const cache = createGeocodingCache({ maxEntries: 2, ttlMs: 1000 });
        cache.set("a", 1, 0);
        cache.set("b", 2, 0);
        expect(cache.get("a", 500)).toBe(1);
        cache.set("c", 3, 500);
        expect(cache.get("b", 500)).toBeUndefined();
        expect(cache.get("a", 500)).toBe(1);
        expect(cache.get("a", 1500)).toBeUndefined();
        expect(cache.diagnostics(1500)).toEqual(expect.objectContaining({
            evictions: 1,
            expirations: expect.any(Number),
            maxEntries: 2,
            ttlMs: 1000
        }));
    });

    test("registers providers only when they expose explicit capabilities", () => {
        const registry = createGeocodingProviderRegistry();
        expect(() => registry.register("", { forward: jest.fn() })).toThrow(GeocodingAdapterError);
        expect(() => registry.register("bad", {})).toThrow(GeocodingAdapterError);
        registry.register("forward-only", { forward: jest.fn() });
        registry.register("reverse-only", { reverse: jest.fn() });
        expect(registry.list()).toEqual(expect.arrayContaining([
            { id: "forward-only", canForward: true, canReverse: false },
            { id: "reverse-only", canForward: false, canReverse: true }
        ]));
        expect(registry.unregister("forward-only")).toBe(true);
    });

    test("throws AbortError before a provider call when already aborted", () => {
        const controller = new AbortController();
        controller.abort();
        expect(() => throwIfGeocodingAborted(controller.signal)).toThrow(expect.objectContaining({
            name: "AbortError",
            code: "GEOCODING_ABORTED"
        }));
    });

    test("executes injected provider without adding a network endpoint", async () => {
        const forward = jest.fn(async request => candidates.filter(candidate => (
            candidate.formattedAddress || candidate.label || candidate.address
        ).toLocaleLowerCase("tr-TR").includes(request.query.split(" ")[0].toLocaleLowerCase("tr-TR"))));
        const adapter = createGeocodingAdapter({ defaultProviderId: "fixture" });
        adapter.registerProvider("fixture", { forward });
        const result = await adapter.forward(null, { query: "Hoşdere", limit: 5 });
        expect(forward).toHaveBeenCalledTimes(1);
        expect(result.status).toBe(GEOCODING_STATUS.Ok);
        expect(result.providerId).toBe("fixture");
        expect(result.candidates.map(candidate => candidate.id)).toEqual([
            "hosdere-10", "hosdere-12"
        ]);
    });

    test("returns invalid status instead of invoking provider for empty forward query", async () => {
        const forward = jest.fn(async () => candidates);
        const adapter = createGeocodingAdapter();
        adapter.registerProvider("fixture", { forward });
        const result = await adapter.forward("fixture", { query: "" });
        expect(result.status).toBe(GEOCODING_STATUS.Invalid);
        expect(result.candidates).toEqual([]);
        expect(forward).not.toHaveBeenCalled();
    });

    test("returns invalid status instead of invoking provider for invalid reverse coordinates", async () => {
        const reverse = jest.fn(async () => candidates);
        const adapter = createGeocodingAdapter();
        adapter.registerProvider("fixture", { reverse });
        const result = await adapter.reverse("fixture", { coordinates: "invalid" });
        expect(result.status).toBe(GEOCODING_STATUS.Invalid);
        expect(reverse).not.toHaveBeenCalled();
    });

    test("deduplicates simultaneous identical provider calls", async () => {
        let resolveProvider;
        const forward = jest.fn(() => new Promise(resolve => {
            resolveProvider = resolve;
        }));
        const adapter = createGeocodingAdapter();
        adapter.registerProvider("fixture", { forward });
        const first = adapter.forward("fixture", { query: "Hoşdere" });
        const second = adapter.forward("fixture", { query: "Hoşdere" });
        expect(forward).toHaveBeenCalledTimes(1);
        resolveProvider(candidates);
        const [left, right] = await Promise.all([first, second]);
        expect(left).toEqual(right);
        expect(adapter.diagnostics().dedupedCalls).toBe(1);
    });

    test("caches successful provider results by normalized request", async () => {
        const forward = jest.fn(async () => candidates);
        const adapter = createGeocodingAdapter();
        adapter.registerProvider("fixture", { forward });
        const first = await adapter.forward("fixture", { query: "Hoşdere Cd.", limit: 3 }, { now: 100 });
        const second = await adapter.forward("fixture", { query: "hosdere caddesi", limit: 3 }, { now: 200 });
        expect(first.status).toBe(GEOCODING_STATUS.Ok);
        expect(second).toEqual(first);
        expect(forward).toHaveBeenCalledTimes(1);
        expect(adapter.diagnostics(200).cacheHits).toBe(1);
    });

    test("supports explicit cache bypass", async () => {
        const forward = jest.fn(async () => candidates);
        const adapter = createGeocodingAdapter();
        adapter.registerProvider("fixture", { forward });
        await adapter.forward("fixture", { query: "Hoşdere" }, { useCache: false });
        await adapter.forward("fixture", { query: "Hoşdere" }, { useCache: false });
        expect(forward).toHaveBeenCalledTimes(2);
    });

    test("wraps provider failures with a typed adapter error", async () => {
        const adapter = createGeocodingAdapter();
        adapter.registerProvider("fixture", { forward: async () => { throw new Error("downstream"); } });
        await expect(adapter.forward("fixture", { query: "Hoşdere" })).rejects.toEqual(expect.objectContaining({
            name: "GeocodingAdapterError",
            code: "PROVIDER_EXECUTION_FAILED"
        }));
        expect(adapter.diagnostics().failures).toBe(1);
    });

    test("rejects unsupported provider capabilities", async () => {
        const adapter = createGeocodingAdapter();
        adapter.registerProvider("fixture", { forward: async () => candidates });
        await expect(adapter.reverse("fixture", { coordinates: [32.85, 39.92] })).rejects.toEqual(expect.objectContaining({
            code: "PROVIDER_CAPABILITY_MISSING"
        }));
    });

    test("requires an explicitly registered provider", async () => {
        const adapter = createGeocodingAdapter();
        await expect(adapter.forward("missing", { query: "Hoşdere" })).rejects.toEqual(expect.objectContaining({
            code: "PROVIDER_NOT_FOUND"
        }));
    });

    test("honors abort after provider execution begins", async () => {
        const controller = new AbortController();
        const adapter = createGeocodingAdapter();
        adapter.registerProvider("fixture", {
            forward: async () => {
                controller.abort();
                return candidates;
            }
        });
        await expect(adapter.forward("fixture", { query: "Hoşdere" }, { signal: controller.signal }))
            .rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
        expect(adapter.diagnostics().aborts).toBe(1);
    });

    test("creates an endpoint-free static provider for deterministic local records", async () => {
        const provider = createStaticGeocodingProvider(candidates, { id: "local" });
        const forward = await provider.forward(normalizeGeocodingRequest({ query: "Hoşdere", limit: 10 }));
        expect(forward).toHaveLength(2);
        const reverse = await provider.reverse(normalizeGeocodingRequest({
            coordinates: [32.847, 39.895],
            limit: 2
        }));
        expect(reverse[0].id).toBe("hosdere-10");
    });

    test("creates aggregate adapter health metrics", async () => {
        const adapter = createGeocodingAdapter();
        adapter.registerProvider("local", createStaticGeocodingProvider(candidates, { id: "local" }));
        await adapter.forward("local", { query: "Hoşdere" });
        expect(createGeocodingQualityReport(adapter)).toEqual(expect.objectContaining({
            version: GEOCODING_ADAPTER_VERSION,
            providerCount: 1,
            providerCalls: 1,
            failureCount: 0,
            failureRatio: 0,
            healthy: true
        }));
    });
});