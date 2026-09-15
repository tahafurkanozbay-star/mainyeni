export function normalizeCommandQuery(value) {
    return String(value || "")
        .toLocaleLowerCase("tr-TR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function isTouchViewport() {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(pointer: coarse)").matches || window.innerWidth < 768;
}

export function clamp(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return min;
    return Math.min(max, Math.max(min, numeric));
}
