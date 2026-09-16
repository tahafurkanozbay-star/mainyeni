export type ExperienceTheme = "light" | "dark" | "system";
export type ExperienceDensity = "comfortable" | "compact";
export type ExperienceMapMode = "2d" | "3d";
export type ExperienceMotion = "system" | "reduced" | "full";
export type ExperiencePanelPlacement = "auto" | "left" | "right" | "bottom";
export type ExperienceConnectivity = "online" | "offline" | "unknown";
export type ExperienceViewport = "compact" | "medium" | "wide";

export type ExperienceCommandName =
    | "search"
    | "layers"
    | "legend"
    | "help"
    | "command-palette"
    | "theme-toggle"
    | "map-mode"
    | "map-home"
    | "map-zoom-in"
    | "map-zoom-out"
    | "identify"
    | "measure"
    | "draw"
    | "basemap"
    | "bookmark"
    | "share"
    | "feedback"
    | "focus-map"
    | "focus-sidebar";

export interface ExperiencePreferences {
    theme: ExperienceTheme;
    density: ExperienceDensity;
    motion: ExperienceMotion;
    panelPlacement: ExperiencePanelPlacement;
    lastMapMode: ExperienceMapMode;
    utilityCollapsed: boolean;
    showCoordinateReadout: boolean;
    highContrastMapControls: boolean;
}

export interface ExperienceCommandDefinition {
    name: ExperienceCommandName;
    label: string;
    description: string;
    keywords: readonly string[];
    group: "discover" | "map" | "data" | "accessibility" | "system";
    shortcut?: readonly string[];
}

export interface ExperienceCommandDetail {
    name: ExperienceCommandName;
    source?: string;
    mode?: ExperienceMapMode;
    query?: string;
    timestamp?: number;
    payload?: Readonly<Record<string, unknown>>;
}

export interface ExperienceRuntimeSnapshot {
    preferences: ExperiencePreferences;
    connectivity: ExperienceConnectivity;
    viewport: ExperienceViewport;
    reducedMotion: boolean;
    forcedColors: boolean;
    coarsePointer: boolean;
    standalone: boolean;
}

export interface ExperienceEventMap {
    "kentrehberi:command": ExperienceCommandDetail;
    "kentrehberi:preferences": ExperiencePreferences;
    "kentrehberi:runtime": ExperienceRuntimeSnapshot;
    "kentrehberi:map-mode-changed": { mode: ExperienceMapMode; source?: string };
    "kentrehberi:announcement": { message: string; politeness?: "polite" | "assertive" };
}

export const EXPERIENCE_STORAGE_KEY = "kent-rehberi-experience-preferences-v2";
export const EXPERIENCE_COMMAND_EVENT = "kentrehberi:command" as const;
export const EXPERIENCE_PREFERENCE_EVENT = "kentrehberi:preferences" as const;
export const EXPERIENCE_RUNTIME_EVENT = "kentrehberi:runtime" as const;
export const EXPERIENCE_MAP_MODE_EVENT = "kentrehberi:map-mode-changed" as const;
export const EXPERIENCE_ANNOUNCEMENT_EVENT = "kentrehberi:announcement" as const;

export const DEFAULT_EXPERIENCE_PREFERENCES: Readonly<ExperiencePreferences> = Object.freeze({
    theme: "system",
    density: "comfortable",
    motion: "system",
    panelPlacement: "auto",
    lastMapMode: "2d",
    utilityCollapsed: false,
    showCoordinateReadout: true,
    highContrastMapControls: false
});

const COMMANDS: readonly ExperienceCommandDefinition[] = Object.freeze([
    Object.freeze({
        name: "search",
        label: "Genel arama",
        description: "Adres, yer, kurum ve kayıt aramasını açar.",
        keywords: ["arama", "adres", "yer", "kurum", "bul"],
        group: "discover",
        shortcut: ["Ctrl", "K"]
    }),
    Object.freeze({
        name: "layers",
        label: "Katmanlar",
        description: "Harita katmanlarını görüntüler ve yönetir.",
        keywords: ["katman", "veri", "görünürlük", "liste"],
        group: "data"
    }),
    Object.freeze({
        name: "legend",
        label: "Lejand",
        description: "Haritadaki sembollerin açıklamalarını gösterir.",
        keywords: ["lejand", "açıklama", "sembol", "renk"],
        group: "data"
    }),
    Object.freeze({
        name: "map-mode",
        label: "2B / 3B görünüm",
        description: "Harita görünümünü 2B ve 3B arasında değiştirir.",
        keywords: ["2d", "2b", "3d", "3b", "sahne", "harita", "görünüm"],
        group: "map"
    }),
    Object.freeze({
        name: "map-home",
        label: "Başlangıç görünümü",
        description: "Haritayı başlangıç kapsamına döndürür.",
        keywords: ["başlangıç", "home", "harita", "dön"],
        group: "map"
    }),
    Object.freeze({
        name: "map-zoom-in",
        label: "Yakınlaştır",
        description: "Harita ölçeğini bir kademe yakınlaştırır.",
        keywords: ["zoom", "yakın", "artı", "harita"],
        group: "map",
        shortcut: ["+"]
    }),
    Object.freeze({
        name: "map-zoom-out",
        label: "Uzaklaştır",
        description: "Harita ölçeğini bir kademe uzaklaştırır.",
        keywords: ["zoom", "uzak", "eksi", "harita"],
        group: "map",
        shortcut: ["-"]
    }),
    Object.freeze({
        name: "identify",
        label: "Detay sorgula",
        description: "Haritadaki seçilebilir nesnelerin bilgilerini sorgular.",
        keywords: ["identify", "detay", "bilgi", "sorgu", "nesne"],
        group: "map"
    }),
    Object.freeze({
        name: "measure",
        label: "Ölçüm",
        description: "Mesafe, alan ve desteklenen görünümde yükseklik ölçümü açar.",
        keywords: ["ölç", "mesafe", "alan", "yükseklik"],
        group: "map"
    }),
    Object.freeze({
        name: "draw",
        label: "Çizim",
        description: "Harita üzerinde geçici çizim ve işaretleme araçlarını açar.",
        keywords: ["çiz", "işaret", "geometri", "sketch"],
        group: "map"
    }),
    Object.freeze({
        name: "basemap",
        label: "Altlık harita",
        description: "Kullanılabilir altlık haritalar arasında seçim yapar.",
        keywords: ["altlık", "basemap", "harita", "zemin"],
        group: "map"
    }),
    Object.freeze({
        name: "bookmark",
        label: "Yer imleri",
        description: "Kayıtlı harita görünümlerini açar.",
        keywords: ["yer imi", "bookmark", "konum", "kayıtlı"],
        group: "discover"
    }),
    Object.freeze({
        name: "share",
        label: "Görünümü paylaş",
        description: "Geçerli harita görünümü için paylaşılabilir bağlantı üretir.",
        keywords: ["paylaş", "bağlantı", "link", "url"],
        group: "discover"
    }),
    Object.freeze({
        name: "feedback",
        label: "Geri bildirim",
        description: "Kent Rehberi deneyimi için geri bildirim yüzeyini açar.",
        keywords: ["geri bildirim", "öneri", "hata", "feedback"],
        group: "system"
    }),
    Object.freeze({
        name: "focus-map",
        label: "Haritaya odaklan",
        description: "Klavye odağını ana harita çalışma alanına taşır.",
        keywords: ["odak", "harita", "erişilebilirlik", "klavye"],
        group: "accessibility",
        shortcut: ["Alt", "M"]
    }),
    Object.freeze({
        name: "focus-sidebar",
        label: "Araç paneline odaklan",
        description: "Klavye odağını ana araç paneline taşır.",
        keywords: ["odak", "panel", "sidebar", "klavye"],
        group: "accessibility",
        shortcut: ["Alt", "S"]
    }),
    Object.freeze({
        name: "theme-toggle",
        label: "Temayı değiştir",
        description: "Açık ve koyu görünüm arasında geçiş yapar.",
        keywords: ["tema", "koyu", "açık", "dark", "light"],
        group: "system"
    }),
    Object.freeze({
        name: "help",
        label: "Kısayollar ve yardım",
        description: "Klavye kısayollarını ve hızlı kullanım yardımını gösterir.",
        keywords: ["yardım", "kısayol", "klavye", "help"],
        group: "accessibility",
        shortcut: ["?"]
    }),
    Object.freeze({
        name: "command-palette",
        label: "Komut merkezi",
        description: "Tüm hızlı işlemleri aranabilir tek yüzeyde açar.",
        keywords: ["komut", "palette", "işlem", "ara"],
        group: "discover",
        shortcut: ["Ctrl", "K"]
    })
]);

export const EXPERIENCE_COMMANDS = COMMANDS;

const isObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;

const pickBoolean = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;

export function normalizeExperiencePreferences(value: unknown): ExperiencePreferences {
    const source = isObject(value) ? value : {};
    return {
        theme: pickEnum(source.theme, ["light", "dark", "system"], DEFAULT_EXPERIENCE_PREFERENCES.theme),
        density: pickEnum(source.density, ["comfortable", "compact"], DEFAULT_EXPERIENCE_PREFERENCES.density),
        motion: pickEnum(source.motion, ["system", "reduced", "full"], DEFAULT_EXPERIENCE_PREFERENCES.motion),
        panelPlacement: pickEnum(source.panelPlacement, ["auto", "left", "right", "bottom"], DEFAULT_EXPERIENCE_PREFERENCES.panelPlacement),
        lastMapMode: pickEnum(source.lastMapMode, ["2d", "3d"], DEFAULT_EXPERIENCE_PREFERENCES.lastMapMode),
        utilityCollapsed: pickBoolean(source.utilityCollapsed, DEFAULT_EXPERIENCE_PREFERENCES.utilityCollapsed),
        showCoordinateReadout: pickBoolean(source.showCoordinateReadout, DEFAULT_EXPERIENCE_PREFERENCES.showCoordinateReadout),
        highContrastMapControls: pickBoolean(source.highContrastMapControls, DEFAULT_EXPERIENCE_PREFERENCES.highContrastMapControls)
    };
}

export function parseExperiencePreferences(serialized: string | null | undefined): ExperiencePreferences {
    if (!serialized) return normalizeExperiencePreferences(null);
    try {
        return normalizeExperiencePreferences(JSON.parse(serialized));
    } catch (_) {
        return normalizeExperiencePreferences(null);
    }
}

export function serializeExperiencePreferences(preferences: ExperiencePreferences): string {
    return JSON.stringify(normalizeExperiencePreferences(preferences));
}

export function mergeExperiencePreferences(
    current: ExperiencePreferences,
    patch: Partial<ExperiencePreferences>
): ExperiencePreferences {
    return normalizeExperiencePreferences({ ...current, ...patch });
}

export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem?(key: string): void;
}

export function readExperiencePreferences(storage?: StorageLike | null): ExperiencePreferences {
    if (!storage) return normalizeExperiencePreferences(null);
    try {
        return parseExperiencePreferences(storage.getItem(EXPERIENCE_STORAGE_KEY));
    } catch (_) {
        return normalizeExperiencePreferences(null);
    }
}

export function writeExperiencePreferences(
    storage: StorageLike | null | undefined,
    preferences: ExperiencePreferences
): boolean {
    if (!storage) return false;
    try {
        storage.setItem(EXPERIENCE_STORAGE_KEY, serializeExperiencePreferences(preferences));
        return true;
    } catch (_) {
        return false;
    }
}

export function normalizeSearchText(value: unknown): string {
    return String(value ?? "")
        .toLocaleLowerCase("tr-TR")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ı/g, "i")
        .replace(/[^a-z0-9çğıöşü\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function scoreCommand(command: ExperienceCommandDefinition, query: string): number {
    if (!query) return 1;
    const normalizedQuery = normalizeSearchText(query);
    const label = normalizeSearchText(command.label);
    const description = normalizeSearchText(command.description);
    const keywords = command.keywords.map(normalizeSearchText);

    if (label === normalizedQuery) return 100;
    if (label.startsWith(normalizedQuery)) return 80;
    if (keywords.some(keyword => keyword === normalizedQuery)) return 70;
    if (keywords.some(keyword => keyword.startsWith(normalizedQuery))) return 60;
    if (label.includes(normalizedQuery)) return 50;
    if (keywords.some(keyword => keyword.includes(normalizedQuery))) return 40;
    if (description.includes(normalizedQuery)) return 20;

    const parts = normalizedQuery.split(" ").filter(Boolean);
    if (parts.length > 1) {
        const corpus = [label, description, ...keywords].join(" ");
        const matched = parts.filter(part => corpus.includes(part)).length;
        if (matched === parts.length) return 10 + matched;
    }
    return 0;
}

export function searchExperienceCommands(
    query: string,
    commands: readonly ExperienceCommandDefinition[] = EXPERIENCE_COMMANDS,
    limit = 8
): ExperienceCommandDefinition[] {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 8)));
    return commands
        .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
        .filter(item => item.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, safeLimit)
        .map(item => item.command);
}

export function isExperienceCommandName(value: unknown): value is ExperienceCommandName {
    return typeof value === "string" && EXPERIENCE_COMMANDS.some(command => command.name === value);
}

export function normalizeCommandDetail(value: unknown): ExperienceCommandDetail | null {
    if (!isObject(value) || !isExperienceCommandName(value.name)) return null;
    const detail: ExperienceCommandDetail = {
        name: value.name,
        timestamp: Number.isFinite(Number(value.timestamp)) ? Number(value.timestamp) : Date.now()
    };
    if (typeof value.source === "string" && value.source.trim()) detail.source = value.source.trim();
    if (value.mode === "2d" || value.mode === "3d") detail.mode = value.mode;
    if (typeof value.query === "string") detail.query = value.query;
    if (isObject(value.payload)) detail.payload = Object.freeze({ ...value.payload });
    return detail;
}

export interface EventTargetLike {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
    dispatchEvent(event: Event): boolean;
}

export interface ExperienceBus {
    emit<K extends keyof ExperienceEventMap>(type: K, detail: ExperienceEventMap[K]): boolean;
    on<K extends keyof ExperienceEventMap>(type: K, listener: (detail: ExperienceEventMap[K], event: Event) => void): () => void;
    command(detail: ExperienceCommandDetail): boolean;
}

export function createExperienceBus(target?: EventTargetLike | null): ExperienceBus {
    const eventTarget = target ?? (typeof window !== "undefined" ? window : null);

    const emit = <K extends keyof ExperienceEventMap>(type: K, detail: ExperienceEventMap[K]): boolean => {
        if (!eventTarget || typeof CustomEvent === "undefined") return false;
        return eventTarget.dispatchEvent(new CustomEvent(String(type), { detail }));
    };

    const on = <K extends keyof ExperienceEventMap>(
        type: K,
        listener: (detail: ExperienceEventMap[K], event: Event) => void
    ): (() => void) => {
        if (!eventTarget) return () => {};
        const wrapped: EventListener = event => {
            const detail = (event as CustomEvent<ExperienceEventMap[K]>).detail;
            listener(detail, event);
        };
        eventTarget.addEventListener(String(type), wrapped);
        return () => eventTarget.removeEventListener(String(type), wrapped);
    };

    return {
        emit,
        on,
        command(detail) {
            const normalized = normalizeCommandDetail(detail);
            return normalized ? emit(EXPERIENCE_COMMAND_EVENT, normalized) : false;
        }
    };
}

export interface PreferenceStore {
    get(): ExperiencePreferences;
    set(patch: Partial<ExperiencePreferences>): ExperiencePreferences;
    replace(next: ExperiencePreferences): ExperiencePreferences;
    reset(): ExperiencePreferences;
    subscribe(listener: (preferences: ExperiencePreferences) => void): () => void;
}

export function createPreferenceStore(options: {
    storage?: StorageLike | null;
    bus?: ExperienceBus | null;
    initial?: Partial<ExperiencePreferences>;
} = {}): PreferenceStore {
    const storage = options.storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    const bus = options.bus ?? createExperienceBus();
    let value = mergeExperiencePreferences(readExperiencePreferences(storage), options.initial ?? {});
    const listeners = new Set<(preferences: ExperiencePreferences) => void>();

    const publish = () => {
        writeExperiencePreferences(storage, value);
        bus?.emit(EXPERIENCE_PREFERENCE_EVENT, value);
        listeners.forEach(listener => listener(value));
        return value;
    };

    return {
        get: () => value,
        set(patch) {
            value = mergeExperiencePreferences(value, patch);
            return publish();
        },
        replace(next) {
            value = normalizeExperiencePreferences(next);
            return publish();
        },
        reset() {
            value = normalizeExperiencePreferences(null);
            return publish();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}

export function classifyViewport(width: number): ExperienceViewport {
    const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
    if (safeWidth < 720) return "compact";
    if (safeWidth < 1200) return "medium";
    return "wide";
}

export function resolveConnectivity(navigatorLike?: { onLine?: boolean } | null): ExperienceConnectivity {
    if (!navigatorLike || typeof navigatorLike.onLine !== "boolean") return "unknown";
    return navigatorLike.onLine ? "online" : "offline";
}

export function resolveEffectiveTheme(
    preference: ExperienceTheme,
    prefersDark: boolean
): Exclude<ExperienceTheme, "system"> {
    if (preference === "dark" || preference === "light") return preference;
    return prefersDark ? "dark" : "light";
}

export function resolveReducedMotion(
    preference: ExperienceMotion,
    systemReduced: boolean
): boolean {
    if (preference === "reduced") return true;
    if (preference === "full") return false;
    return systemReduced;
}

export function resolvePanelPlacement(
    preference: ExperiencePanelPlacement,
    viewport: ExperienceViewport
): Exclude<ExperiencePanelPlacement, "auto"> {
    if (preference !== "auto") return preference;
    if (viewport === "compact") return "bottom";
    return "right";
}

export function createRuntimeSnapshot(input: {
    preferences?: Partial<ExperiencePreferences>;
    width?: number;
    online?: boolean;
    systemReducedMotion?: boolean;
    forcedColors?: boolean;
    coarsePointer?: boolean;
    standalone?: boolean;
} = {}): ExperienceRuntimeSnapshot {
    const preferences = mergeExperiencePreferences(
        normalizeExperiencePreferences(null),
        input.preferences ?? {}
    );
    return {
        preferences,
        connectivity: typeof input.online === "boolean" ? (input.online ? "online" : "offline") : "unknown",
        viewport: classifyViewport(Number(input.width ?? 0)),
        reducedMotion: resolveReducedMotion(preferences.motion, Boolean(input.systemReducedMotion)),
        forcedColors: Boolean(input.forcedColors),
        coarsePointer: Boolean(input.coarsePointer),
        standalone: Boolean(input.standalone)
    };
}

export function getCommandByName(name: ExperienceCommandName): ExperienceCommandDefinition | undefined {
    return EXPERIENCE_COMMANDS.find(command => command.name === name);
}

export function formatShortcut(shortcut?: readonly string[]): string {
    return shortcut?.filter(Boolean).join(" + ") ?? "";
}

export function nextMapMode(mode: ExperienceMapMode): ExperienceMapMode {
    return mode === "3d" ? "2d" : "3d";
}

export function mapModeLabel(mode: ExperienceMapMode): string {
    return mode === "3d" ? "3B" : "2B";
}

export function mapModeAnnouncement(mode: ExperienceMapMode): string {
    return mode === "3d"
        ? "3B sahne görünümü etkin. Harita kamera kontrolleri kullanılabilir."
        : "2B harita görünümü etkin.";
}
