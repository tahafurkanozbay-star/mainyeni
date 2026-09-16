import {
  create3DGraphicModel,
  createListIconModel,
  createPictureMarkerSymbol,
  getIconKey,
  resolveRecordIcon,
} from '../gis-engine/iconPresentation';
import type { NormalizedRecord, SearchHit } from './contracts';

export interface SharedIconModel {
  readonly key: string;
  readonly src: string;
  readonly alt: string;
  readonly isFallback: boolean;
  readonly matchedBy: string | null;
}

export interface SharedMarkerModel {
  readonly type: string;
  readonly url: string;
  readonly width: string;
  readonly height: string;
  readonly angle: number;
}

export interface Shared3DModel {
  readonly iconKey: string;
  readonly billboard: string;
  readonly label: string;
  readonly isFallback: boolean;
}

export interface SearchPresentationModel {
  readonly id: string | null;
  readonly title: string;
  readonly category: string;
  readonly type: string;
  readonly address: string;
  readonly score: number;
  readonly distanceMeters: number | null;
  readonly icon: SharedIconModel;
  readonly iconKey: string;
  readonly marker2d: SharedMarkerModel;
  readonly graphic3d: Shared3DModel;
  readonly reasons: readonly string[];
  readonly source: NormalizedRecord;
}

const iconInputForRecord = (record: NormalizedRecord): Readonly<Record<string, unknown>> => Object.freeze({
  id: record.id,
  title: record.title,
  name: record.title,
  category: record.category,
  categoryKey: record.categoryKey,
  type: record.type,
  typeKey: record.typeKey,
  address: record.address,
  ...record.fields,
});

const normalizeListIcon = (value: unknown): SharedIconModel => {
  const model = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return Object.freeze({
    key: String(model.key ?? 'default'),
    src: String(model.src ?? 'images/icons/map/pictureMarker.png'),
    alt: String(model.alt ?? 'Harita nesnesi'),
    isFallback: model.isFallback === true,
    matchedBy: model.matchedBy === null || model.matchedBy === undefined
      ? null
      : String(model.matchedBy),
  });
};

const normalizeMarker = (value: unknown): SharedMarkerModel => {
  const model = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return Object.freeze({
    type: String(model.type ?? 'picture-marker'),
    url: String(model.url ?? 'images/icons/map/pictureMarker.png'),
    width: String(model.width ?? '28px'),
    height: String(model.height ?? '32px'),
    angle: Number.isFinite(Number(model.angle)) ? Number(model.angle) : 0,
  });
};

const normalize3DModel = (value: unknown): Shared3DModel => {
  const model = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return Object.freeze({
    iconKey: String(model.iconKey ?? 'default'),
    billboard: String(model.billboard ?? 'images/icons/map/pictureMarker.png'),
    label: String(model.label ?? ''),
    isFallback: model.isFallback === true,
  });
};

export const createRecordPresentation = (
  record: NormalizedRecord,
  options: { readonly zoom?: number; readonly fallback?: string } = {},
): Omit<SearchPresentationModel, 'score' | 'distanceMeters' | 'reasons'> => {
  const iconInput = iconInputForRecord(record);
  const iconOptions = options.fallback ? { fallback: options.fallback } : {};
  const icon = normalizeListIcon(createListIconModel(iconInput, iconOptions));
  const iconKey = String(getIconKey(iconInput, iconOptions) ?? icon.key ?? 'default');
  const marker2d = normalizeMarker(createPictureMarkerSymbol(
    iconInput,
    Number.isFinite(Number(options.zoom)) ? Number(options.zoom) : 12,
    iconOptions,
  ));
  const graphic3d = normalize3DModel(create3DGraphicModel(iconInput, iconOptions));
  return Object.freeze({
    id: record.id,
    title: record.title,
    category: record.category,
    type: record.type,
    address: record.address,
    icon,
    iconKey,
    marker2d,
    graphic3d,
    source: record,
  });
};

export const createSearchHitPresentation = (
  hit: SearchHit,
  options: { readonly zoom?: number; readonly fallback?: string } = {},
): SearchPresentationModel => Object.freeze({
  ...createRecordPresentation(hit.record, options),
  score: hit.score,
  distanceMeters: hit.distanceMeters,
  reasons: Object.freeze([...hit.reasons]),
});

export const createSearchPresentations = (
  hits: readonly SearchHit[],
  options: { readonly zoom?: number; readonly fallback?: string } = {},
): readonly SearchPresentationModel[] => Object.freeze(
  hits.map(hit => createSearchHitPresentation(hit, options)),
);

export interface IconCoverageReport {
  readonly total: number;
  readonly resolved: number;
  readonly fallback: number;
  readonly fallbackRatio: number;
  readonly keys: Readonly<Record<string, number>>;
  readonly matchedBy: Readonly<Record<string, number>>;
}

export const createIconCoverageReport = (
  records: readonly NormalizedRecord[],
): IconCoverageReport => {
  let fallback = 0;
  const keys: Record<string, number> = {};
  const matchedBy: Record<string, number> = {};
  for (const record of records) {
    const input = iconInputForRecord(record);
    const resolved = resolveRecordIcon(input) as Record<string, unknown>;
    const key = String(resolved.id ?? 'default');
    const match = String(resolved.matchedBy ?? 'fallback');
    keys[key] = (keys[key] ?? 0) + 1;
    matchedBy[match] = (matchedBy[match] ?? 0) + 1;
    if (resolved.isFallback === true || key === 'default') fallback += 1;
  }
  const total = records.length;
  return Object.freeze({
    total,
    resolved: total - fallback,
    fallback,
    fallbackRatio: total ? fallback / total : 0,
    keys: Object.freeze(keys),
    matchedBy: Object.freeze(matchedBy),
  });
};
