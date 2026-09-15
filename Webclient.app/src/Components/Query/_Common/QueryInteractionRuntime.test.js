import {
    DEFAULT_BUFFER_UNITS,
    MAX_BUFFER_UNITS,
    MIN_BUFFER_UNITS,
    bufferUnitsToMeters,
    buildGoogleDirectionsUrl,
    createGeolocationRequest,
    createLatestRequestGate,
    createOwnedResourceRegistry,
    getGeometryCoordinates,
    metersToBufferUnits,
    normalizeBufferUnits,
    normalizeErrorMessage,
    normalizeFiniteNumber,
    openExternalSafely,
    safeClientLog
} from "./QueryInteractionRuntime";

describe("QueryInteractionRuntime", () => {
    describe("number and distance normalization", () => {
        test("normalizes finite numeric values", () => {
            expect(normalizeFiniteNumber(12)).toBe(12);
            expect(normalizeFiniteNumber("12.5")).toBe(12.5);
            expect(normalizeFiniteNumber(0)).toBe(0);
        });

        test("rejects empty and non-finite numeric values", () => {
            expect(normalizeFiniteNumber(null)).toBeNull();
            expect(normalizeFiniteNumber(undefined)).toBeNull();
            expect(normalizeFiniteNumber("")).toBeNull();
            expect(normalizeFiniteNumber("abc")).toBeNull();
            expect(normalizeFiniteNumber(Infinity)).toBeNull();
        });

        test("clamps buffer units to the supported range", () => {
            expect(normalizeBufferUnits(-50)).toBe(MIN_BUFFER_UNITS);
            expect(normalizeBufferUnits(999)).toBe(MAX_BUFFER_UNITS);
            expect(normalizeBufferUnits(18.6)).toBe(19);
            expect(normalizeBufferUnits(null)).toBe(DEFAULT_BUFFER_UNITS);
        });

        test("converts query buffer units to meters", () => {
            expect(bufferUnitsToMeters(1)).toBe(100);
            expect(bufferUnitsToMeters(20)).toBe(2000);
            expect(bufferUnitsToMeters(100)).toBe(10000);
        });

        test("converts meter input back to supported query units", () => {
            expect(metersToBufferUnits(100)).toBe(1);
            expect(metersToBufferUnits(2000)).toBe(20);
            expect(metersToBufferUnits(10000)).toBe(100);
            expect(metersToBufferUnits(50000)).toBe(100);
        });
    });

    describe("geometry helpers", () => {
        test("reads ArcGIS latitude and longitude coordinates", () => {
            expect(getGeometryCoordinates({ latitude: 39.93, longitude: 32.85 })).toEqual({
                latitude: 39.93,
                longitude: 32.85
            });
        });

        test("reads x and y coordinates", () => {
            expect(getGeometryCoordinates({ x: 32.85, y: 39.93 })).toEqual({
                latitude: 39.93,
                longitude: 32.85
            });
        });

        test("prefers an extent center for non-point geometries", () => {
            expect(getGeometryCoordinates({
                extent: { center: { x: 32.8, y: 39.9 } },
                x: 0,
                y: 0
            })).toEqual({ latitude: 39.9, longitude: 32.8 });
        });

        test("uses a centroid when available", () => {
            expect(getGeometryCoordinates({ centroid: { longitude: 32.7, latitude: 39.8 } })).toEqual({
                latitude: 39.8,
                longitude: 32.7
            });
        });

        test("rejects incomplete coordinates", () => {
            expect(getGeometryCoordinates({ latitude: 39.9 })).toBeNull();
            expect(getGeometryCoordinates({ longitude: 32.8 })).toBeNull();
            expect(getGeometryCoordinates(null)).toBeNull();
        });

        test("builds an encoded Google Maps directions URL", () => {
            expect(buildGoogleDirectionsUrl({ latitude: 39.92, longitude: 32.85 }))
                .toBe("https://www.google.com.tr/maps?saddr=My+Location&daddr=39.92%2C32.85");
        });

        test("returns null when directions cannot be built", () => {
            expect(buildGoogleDirectionsUrl({})).toBeNull();
            expect(buildGoogleDirectionsUrl(null)).toBeNull();
        });
    });

    describe("external navigation", () => {
        test("opens external links with noopener and noreferrer", () => {
            const openedWindow = { opener: {} };
            const opener = jest.fn(() => openedWindow);
            expect(openExternalSafely("https://example.com", opener)).toBe(true);
            expect(opener).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
            expect(openedWindow.opener).toBeNull();
        });

        test("reports blocked popups", () => {
            const opener = jest.fn(() => null);
            expect(openExternalSafely("https://example.com", opener)).toBe(false);
        });

        test("does not call opener for an empty URL", () => {
            const opener = jest.fn();
            expect(openExternalSafely(null, opener)).toBe(false);
            expect(opener).not.toHaveBeenCalled();
        });
    });

    describe("error and logging helpers", () => {
        test("prefers explicit error messages", () => {
            expect(normalizeErrorMessage(new Error("boom"))).toBe("boom");
            expect(normalizeErrorMessage({ errorMessage: "service failed" })).toBe("service failed");
            expect(normalizeErrorMessage("plain failure")).toBe("plain failure");
        });

        test("uses a fallback for empty errors", () => {
            expect(normalizeErrorMessage(null, "fallback")).toBe("fallback");
            expect(normalizeErrorMessage({}, "fallback")).toBe("fallback");
        });

        test("safeClientLog resolves true for successful log calls", async () => {
            const logger = { CreateClientLog: jest.fn(() => Promise.resolve()) };
            await expect(safeClientLog(logger, "event", "payload")).resolves.toBe(true);
            expect(logger.CreateClientLog).toHaveBeenCalledWith("event", "payload");
        });

        test("safeClientLog absorbs rejected logging requests", async () => {
            const logger = { CreateClientLog: jest.fn(() => Promise.reject(new Error("offline"))) };
            await expect(safeClientLog(logger, "event", "payload")).resolves.toBe(false);
        });

        test("safeClientLog absorbs synchronous logger failures", async () => {
            const logger = { CreateClientLog: jest.fn(() => { throw new Error("bad logger"); }) };
            await expect(safeClientLog(logger, "event", "payload")).resolves.toBe(false);
        });
    });

    describe("latest request gate", () => {
        test("only considers the latest issued request current", () => {
            const gate = createLatestRequestGate();
            const first = gate.next();
            expect(gate.isCurrent(first)).toBe(true);
            const second = gate.next();
            expect(gate.isCurrent(first)).toBe(false);
            expect(gate.isCurrent(second)).toBe(true);
            expect(gate.current()).toBe(second);
        });

        test("invalidates outstanding requests", () => {
            const gate = createLatestRequestGate();
            const request = gate.next();
            gate.invalidate();
            expect(gate.isCurrent(request)).toBe(false);
        });
    });

    describe("owned resource registry", () => {
        test("tracks and removes layers independently", () => {
            const removeLayer = jest.fn();
            const registry = createOwnedResourceRegistry({ removeLayer });
            const first = { id: "a" };
            const second = { id: "b" };
            registry.trackLayer(first);
            registry.trackLayer(second);
            expect(registry.sizes()).toEqual({ layers: 2, graphics: 0 });
            registry.removeLayer(first);
            expect(removeLayer).toHaveBeenCalledWith(first);
            expect(registry.sizes()).toEqual({ layers: 1, graphics: 0 });
        });

        test("tracks and removes graphics independently", () => {
            const removeGraphic = jest.fn();
            const registry = createOwnedResourceRegistry({ removeGraphic });
            const graphic = { id: "graphic" };
            registry.trackGraphic(graphic);
            registry.removeGraphic(graphic);
            expect(removeGraphic).toHaveBeenCalledWith(graphic);
            expect(registry.sizes()).toEqual({ layers: 0, graphics: 0 });
        });

        test("clear removes every tracked resource once", () => {
            const removeLayer = jest.fn();
            const removeGraphic = jest.fn();
            const registry = createOwnedResourceRegistry({ removeLayer, removeGraphic });
            const layer = { id: "layer" };
            const graphic = { id: "graphic" };
            registry.trackLayer(layer);
            registry.trackGraphic(graphic);
            registry.clear();
            expect(removeLayer).toHaveBeenCalledTimes(1);
            expect(removeGraphic).toHaveBeenCalledTimes(1);
            expect(registry.sizes()).toEqual({ layers: 0, graphics: 0 });
        });

        test("clear is idempotent", () => {
            const removeLayer = jest.fn();
            const registry = createOwnedResourceRegistry({ removeLayer });
            registry.trackLayer({ id: "layer" });
            registry.clear();
            registry.clear();
            expect(removeLayer).toHaveBeenCalledTimes(1);
        });

        test("cleanup failures do not prevent the remaining resources from being cleared", () => {
            const removeLayer = jest.fn(layer => {
                if (layer.id === "bad") throw new Error("cannot remove");
            });
            const registry = createOwnedResourceRegistry({ removeLayer });
            registry.trackLayer({ id: "bad" });
            registry.trackLayer({ id: "good" });
            expect(() => registry.clear()).not.toThrow();
            expect(removeLayer).toHaveBeenCalledTimes(2);
            expect(registry.sizes().layers).toBe(0);
        });
    });

    describe("geolocation wrapper", () => {
        test("resolves normalized coordinates", async () => {
            const geolocation = {
                getCurrentPosition: callback => callback({
                    coords: { latitude: 39.93, longitude: 32.85, accuracy: 12 }
                })
            };
            await expect(createGeolocationRequest({ geolocation })).resolves.toEqual({
                latitude: 39.93,
                longitude: 32.85,
                accuracy: 12
            });
        });

        test("rejects unsupported geolocation", async () => {
            await expect(createGeolocationRequest({ geolocation: {} }))
                .rejects.toThrow("Konum servisi");
        });

        test("rejects invalid coordinates", async () => {
            const geolocation = {
                getCurrentPosition: callback => callback({ coords: { latitude: null, longitude: 32.85 } })
            };
            await expect(createGeolocationRequest({ geolocation })).rejects.toThrow("geçersiz");
        });

        test("forwards geolocation errors", async () => {
            const geolocation = {
                getCurrentPosition: (success, error) => error({ message: "permission denied" })
            };
            await expect(createGeolocationRequest({ geolocation })).rejects.toThrow("permission denied");
        });

        test("requests a bounded and cache-friendly geolocation lookup", async () => {
            const getCurrentPosition = jest.fn(callback => callback({
                coords: { latitude: 39.93, longitude: 32.85 }
            }));
            await createGeolocationRequest({ geolocation: { getCurrentPosition }, timeout: 4321 });
            expect(getCurrentPosition.mock.calls[0][2]).toEqual({
                enableHighAccuracy: false,
                timeout: 4321,
                maximumAge: 60000
            });
        });
    });
});
