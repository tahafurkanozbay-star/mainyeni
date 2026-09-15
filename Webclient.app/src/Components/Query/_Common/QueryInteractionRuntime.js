export const DEFAULT_BUFFER_UNITS = 20;
export const MIN_BUFFER_UNITS = 1;
export const MAX_BUFFER_UNITS = 100;
export const METERS_PER_BUFFER_UNIT = 100;

export const normalizeFiniteNumber = value => {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const normalizeBufferUnits = (
    value,
    fallback = DEFAULT_BUFFER_UNITS,
    min = MIN_BUFFER_UNITS,
    max = MAX_BUFFER_UNITS
) => {
    const numeric = normalizeFiniteNumber(value);
    if (numeric === null) return clamp(fallback, min, max);
    return clamp(Math.round(numeric), min, max);
};

export const bufferUnitsToMeters = value => normalizeBufferUnits(value) * METERS_PER_BUFFER_UNIT;

export const metersToBufferUnits = value => {
    const meters = normalizeFiniteNumber(value);
    if (meters === null) return DEFAULT_BUFFER_UNITS;
    return normalizeBufferUnits(meters / METERS_PER_BUFFER_UNIT);
};

export const normalizeCoordinate = value => {
    const numeric = normalizeFiniteNumber(value);
    return numeric === null ? null : numeric;
};

export const getGeometryCoordinates = geometry => {
    if (!geometry) return null;
    const target = geometry.extent?.center || geometry.centroid || geometry;
    const latitude = normalizeCoordinate(target.latitude ?? target.y);
    const longitude = normalizeCoordinate(target.longitude ?? target.x);
    if (latitude === null || longitude === null) return null;
    return { latitude, longitude };
};

export const buildGoogleDirectionsUrl = geometry => {
    const coordinates = getGeometryCoordinates(geometry);
    if (!coordinates) return null;
    const destination = `${coordinates.latitude},${coordinates.longitude}`;
    return `https://www.google.com.tr/maps?saddr=My+Location&daddr=${encodeURIComponent(destination)}`;
};

export const openExternalSafely = (url, opener = window.open) => {
    if (!url || typeof opener !== "function") return false;
    const opened = opener(url, "_blank", "noopener,noreferrer");
    if (opened) {
        try {
            opened.opener = null;
        } catch (error) {
            // Some browser implementations expose a read-only opener reference.
        }
    }
    return Boolean(opened);
};

export const normalizeErrorMessage = (error, fallback = "İşlem tamamlanamadı. Lütfen tekrar deneyin.") => {
    if (typeof error === "string" && error.trim()) return error.trim();
    if (error?.message && String(error.message).trim()) return String(error.message).trim();
    if (error?.errorMessage && String(error.errorMessage).trim()) return String(error.errorMessage).trim();
    return fallback;
};

export const safeClientLog = (logger, eventName, payload) => {
    if (!logger || typeof logger.CreateClientLog !== "function") return Promise.resolve(false);
    try {
        return Promise.resolve(logger.CreateClientLog(eventName, payload))
            .then(() => true)
            .catch(() => false);
    } catch (error) {
        return Promise.resolve(false);
    }
};

export const createLatestRequestGate = () => {
    let sequence = 0;
    return {
        next: () => {
            sequence += 1;
            return sequence;
        },
        current: () => sequence,
        isCurrent: requestId => requestId === sequence,
        invalidate: () => {
            sequence += 1;
            return sequence;
        }
    };
};

export const createOwnedResourceRegistry = ({ removeLayer, removeGraphic } = {}) => {
    const layers = new Set();
    const graphics = new Set();

    const safely = callback => {
        try {
            callback?.();
        } catch (error) {
            // Cleanup should be idempotent and never block closing a query surface.
        }
    };

    return {
        trackLayer: layer => {
            if (layer) layers.add(layer);
            return layer;
        },
        untrackLayer: layer => {
            if (layer) layers.delete(layer);
            return layer;
        },
        trackGraphic: graphic => {
            if (graphic) graphics.add(graphic);
            return graphic;
        },
        untrackGraphic: graphic => {
            if (graphic) graphics.delete(graphic);
            return graphic;
        },
        removeLayer: layer => {
            if (!layer) return;
            layers.delete(layer);
            safely(() => removeLayer?.(layer));
        },
        removeGraphic: graphic => {
            if (!graphic) return;
            graphics.delete(graphic);
            safely(() => removeGraphic?.(graphic));
        },
        clearLayers: () => {
            [...layers].forEach(layer => {
                safely(() => removeLayer?.(layer));
                layers.delete(layer);
            });
        },
        clearGraphics: () => {
            [...graphics].forEach(graphic => {
                safely(() => removeGraphic?.(graphic));
                graphics.delete(graphic);
            });
        },
        clear: () => {
            [...layers].forEach(layer => safely(() => removeLayer?.(layer)));
            [...graphics].forEach(graphic => safely(() => removeGraphic?.(graphic)));
            layers.clear();
            graphics.clear();
        },
        sizes: () => ({ layers: layers.size, graphics: graphics.size })
    };
};

export const createGeolocationRequest = ({ geolocation, timeout = 10000 } = {}) => {
    const source = geolocation || (typeof navigator !== "undefined" ? navigator.geolocation : null);
    if (!source?.getCurrentPosition) {
        return Promise.reject(new Error("Konum servisi bu tarayıcıda desteklenmiyor."));
    }

    return new Promise((resolve, reject) => {
        source.getCurrentPosition(
            position => {
                const latitude = normalizeCoordinate(position?.coords?.latitude);
                const longitude = normalizeCoordinate(position?.coords?.longitude);
                if (latitude === null || longitude === null) {
                    reject(new Error("Konum bilgisi geçersiz döndü."));
                    return;
                }
                resolve({ latitude, longitude, accuracy: normalizeCoordinate(position?.coords?.accuracy) });
            },
            error => {
                const message = error?.message || "Konum izni alınamadı.";
                reject(new Error(message));
            },
            {
                enableHighAccuracy: false,
                timeout,
                maximumAge: 60000
            }
        );
    });
};
