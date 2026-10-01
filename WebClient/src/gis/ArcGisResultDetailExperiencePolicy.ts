export type ResultDetailViewport = 'phone' | 'tablet' | 'desktop';
export type ResultDetailPresentation = 'sheet' | 'drawer' | 'side-panel';
export type ResultDetailFieldKind = 'text' | 'number' | 'date' | 'boolean' | 'url' | 'identifier';
export type ResultDetailSectionTone = 'default' | 'important' | 'warning';

export interface ResultDetailFieldInput {
  readonly id: string;
  readonly label: string;
  readonly value: unknown;
  readonly kind?: ResultDetailFieldKind;
  readonly sensitive?: boolean;
  readonly copyable?: boolean;
  readonly priority?: number;
}

export interface ResultDetailSectionInput {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly ResultDetailFieldInput[];
  readonly expanded?: boolean;
  readonly tone?: ResultDetailSectionTone;
}

export interface ResultDetailInput {
  readonly resultId: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly viewportWidth?: number;
  readonly sections?: readonly ResultDetailSectionInput[];
  readonly selectedSectionId?: string | null;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly canZoom?: boolean;
  readonly canSelectOnMap?: boolean;
  readonly canClose?: boolean;
}

export interface ResultDetailFieldModel {
  readonly id: string;
  readonly label: string;
  readonly displayValue: string;
  readonly kind: ResultDetailFieldKind;
  readonly empty: boolean;
  readonly sensitive: boolean;
  readonly copyable: boolean;
  readonly priority: number;
  readonly accessibleName: string;
}

export interface ResultDetailSectionModel {
  readonly id: string;
  readonly label: string;
  readonly expanded: boolean;
  readonly tone: ResultDetailSectionTone;
  readonly fields: readonly ResultDetailFieldModel[];
  readonly populatedFieldCount: number;
  readonly summary: string;
}

export interface ResultDetailExperienceModel {
  readonly resultId: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly viewport: ResultDetailViewport;
  readonly presentation: ResultDetailPresentation;
  readonly sections: readonly ResultDetailSectionModel[];
  readonly selectedSectionId: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly statusAnnouncement: string;
  readonly closeLabel: string;
  readonly zoomLabel: string | null;
  readonly mapSelectionLabel: string | null;
  readonly dialogLabel: string;
}

export interface ResultDetailKeyboardInput {
  readonly key: string;
  readonly currentSectionIndex: number | null;
  readonly sectionCount: number;
  readonly shiftKey?: boolean;
}

export interface ResultDetailKeyboardResolution {
  readonly handled: boolean;
  readonly nextSectionIndex: number | null;
  readonly action: 'focus-section' | 'toggle-section' | 'close' | 'none';
}

const MAX_SECTIONS = 16;
const MAX_FIELDS_PER_SECTION = 64;
const MAX_TEXT = 240;
const MAX_TITLE = 140;
const MAX_ERROR = 180;

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const clean = (value: unknown, maximum = MAX_TEXT): string => {
  const normalized = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const safeId = (value: unknown): string => clean(value, 96).replace(/[^a-zA-Z0-9._:-]/g, '-');
const safeInteger = (value: number | undefined, fallback: number): number => Number.isFinite(value) ? Math.trunc(value as number) : fallback;

export const resolveResultDetailViewport = (width: number | undefined): ResultDetailViewport => {
  const safeWidth = clamp(safeInteger(width, 1280), 240, 10_000);
  if (safeWidth < 640) return 'phone';
  if (safeWidth < 1024) return 'tablet';
  return 'desktop';
};

export const resolveResultDetailPresentation = (viewport: ResultDetailViewport): ResultDetailPresentation => {
  if (viewport === 'phone') return 'sheet';
  if (viewport === 'tablet') return 'drawer';
  return 'side-panel';
};

const inferKind = (value: unknown, requested: ResultDetailFieldKind | undefined): ResultDetailFieldKind => {
  if (requested === 'number' || requested === 'date' || requested === 'boolean' || requested === 'url' || requested === 'identifier') return requested;
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'text';
};

const formatNumber = (value: unknown): string => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 4 }).format(numeric);
};

const formatBoolean = (value: unknown): string => value === true || value === 'true' || value === 1 ? 'Evet' : value === false || value === 'false' || value === 0 ? 'Hayır' : '—';

const formatDate = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Istanbul' }).format(date);
};

const formatUrl = (value: unknown): string => {
  const text = clean(value, 320);
  if (!text) return '—';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '—';
    return clean(url.toString(), 320);
  } catch {
    return '—';
  }
};

const formatFieldValue = (value: unknown, kind: ResultDetailFieldKind, sensitive: boolean): string => {
  if (sensitive) return 'Gizli bilgi';
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'number') return formatNumber(value);
  if (kind === 'boolean') return formatBoolean(value);
  if (kind === 'date') return formatDate(value);
  if (kind === 'url') return formatUrl(value);
  return clean(value);
};

const normalizeField = (field: ResultDetailFieldInput): ResultDetailFieldModel | null => {
  const id = safeId(field.id);
  const label = clean(field.label, 120);
  if (!id || !label) return null;
  const sensitive = field.sensitive === true;
  const kind = inferKind(field.value, field.kind);
  const displayValue = formatFieldValue(field.value, kind, sensitive);
  const empty = displayValue === '—';
  const priority = clamp(safeInteger(field.priority, 50), 0, 100);
  const copyable = field.copyable === true && !sensitive && !empty && kind !== 'url';
  return Object.freeze({ id, label, displayValue, kind, empty, sensitive, copyable, priority, accessibleName: `${label}: ${displayValue}` });
};

const normalizeSection = (section: ResultDetailSectionInput): ResultDetailSectionModel | null => {
  const id = safeId(section.id);
  const label = clean(section.label, 120);
  if (!id || !label) return null;
  const seen = new Set<string>();
  const fields: ResultDetailFieldModel[] = [];
  for (const field of section.fields.slice(0, MAX_FIELDS_PER_SECTION)) {
    const model = normalizeField(field);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    fields.push(model);
  }
  fields.sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label, 'tr'));
  const populatedFieldCount = fields.filter((field) => !field.empty).length;
  const tone: ResultDetailSectionTone = section.tone === 'important' || section.tone === 'warning' ? section.tone : 'default';
  return Object.freeze({
    id,
    label,
    expanded: section.expanded === true || tone === 'important',
    tone,
    fields: Object.freeze(fields),
    populatedFieldCount,
    summary: `${label}, ${populatedFieldCount} dolu alan`,
  });
};

export const normalizeResultDetailSections = (sections: readonly ResultDetailSectionInput[] | undefined): readonly ResultDetailSectionModel[] => {
  const seen = new Set<string>();
  const result: ResultDetailSectionModel[] = [];
  for (const section of (sections ?? []).slice(0, MAX_SECTIONS)) {
    const model = normalizeSection(section);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return Object.freeze(result);
};

const normalizeError = (error: string | null | undefined): string | null => {
  const text = clean(error, MAX_ERROR);
  if (!text) return null;
  return text.replace(/https?:\/\/\S+/gi, '[bağlantı gizlendi]').replace(/\b(?:token|secret|password|authorization)\s*[:=]\s*\S+/gi, '[gizli bilgi]');
};

export const createResultDetailExperienceModel = (input: ResultDetailInput): ResultDetailExperienceModel => {
  const resultId = safeId(input.resultId) || 'result';
  const title = clean(input.title, MAX_TITLE) || 'Sonuç ayrıntısı';
  const subtitle = clean(input.subtitle, MAX_TITLE) || null;
  const viewport = resolveResultDetailViewport(input.viewportWidth);
  const presentation = resolveResultDetailPresentation(viewport);
  const sections = normalizeResultDetailSections(input.sections);
  const requestedSection = safeId(input.selectedSectionId);
  const selectedSectionId = sections.some((section) => section.id === requestedSection) ? requestedSection : sections[0]?.id ?? null;
  const busy = input.busy === true;
  const error = normalizeError(input.error);
  const statusAnnouncement = error ? `Ayrıntı yüklenemedi. ${error}` : busy ? `${title} ayrıntıları yükleniyor` : `${title} ayrıntıları hazır`;
  return Object.freeze({
    resultId,
    title,
    subtitle,
    viewport,
    presentation,
    sections,
    selectedSectionId,
    busy,
    error,
    statusAnnouncement,
    closeLabel: input.canClose === false ? 'Ayrıntı görünümü' : 'Ayrıntıyı kapat',
    zoomLabel: input.canZoom === true ? `${title} konumuna yaklaş` : null,
    mapSelectionLabel: input.canSelectOnMap === true ? `${title} sonucunu haritada seç` : null,
    dialogLabel: `${title} ayrıntıları`,
  });
};

export const resolveResultDetailKeyboard = (input: ResultDetailKeyboardInput): ResultDetailKeyboardResolution => {
  const count = clamp(safeInteger(input.sectionCount, 0), 0, MAX_SECTIONS);
  if (input.key === 'Escape') return Object.freeze({ handled: true, nextSectionIndex: input.currentSectionIndex, action: 'close' });
  if (count === 0) return Object.freeze({ handled: false, nextSectionIndex: null, action: 'none' });
  const current = input.currentSectionIndex === null || !Number.isInteger(input.currentSectionIndex) ? 0 : clamp(input.currentSectionIndex, 0, count - 1);
  if (input.key === 'ArrowDown') return Object.freeze({ handled: true, nextSectionIndex: (current + 1) % count, action: 'focus-section' });
  if (input.key === 'ArrowUp') return Object.freeze({ handled: true, nextSectionIndex: (current - 1 + count) % count, action: 'focus-section' });
  if (input.key === 'Home') return Object.freeze({ handled: true, nextSectionIndex: 0, action: 'focus-section' });
  if (input.key === 'End') return Object.freeze({ handled: true, nextSectionIndex: count - 1, action: 'focus-section' });
  if (input.key === 'Enter' || input.key === ' ') return Object.freeze({ handled: true, nextSectionIndex: current, action: 'toggle-section' });
  return Object.freeze({ handled: false, nextSectionIndex: current, action: 'none' });
};

export const resolveResultDetailFocusTarget = (
  previousSectionId: string | null | undefined,
  nextSections: readonly ResultDetailSectionModel[],
): string | null => {
  const previous = safeId(previousSectionId);
  if (previous && nextSections.some((section) => section.id === previous)) return previous;
  return nextSections[0]?.id ?? null;
};

export const describeResultDetailChange = (
  previous: ResultDetailExperienceModel | null,
  next: ResultDetailExperienceModel,
): string | null => {
  if (!previous) return `${next.title} ayrıntıları açıldı`;
  if (previous.resultId !== next.resultId) return `${next.title} ayrıntıları açıldı`;
  if (!previous.error && next.error) return `Ayrıntı hatası: ${next.error}`;
  if (previous.busy && !next.busy && !next.error) return `${next.title} ayrıntıları yüklendi`;
  if (previous.selectedSectionId !== next.selectedSectionId && next.selectedSectionId) {
    const section = next.sections.find((candidate) => candidate.id === next.selectedSectionId);
    return section ? `${section.label} bölümü seçildi` : null;
  }
  return null;
};
