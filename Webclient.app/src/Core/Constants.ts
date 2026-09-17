export const Constants_LoadingStatus = Object.freeze({
  NOT_SUBMITTED: 0,
  LOADING: 1,
  COMPLETED: 2,
  ERROR: 3,
} as const);

export type LoadingStatus = typeof Constants_LoadingStatus[keyof typeof Constants_LoadingStatus];

export const Constants_MessageType = Object.freeze({
  Success: 'success',
  Warning: 'warning',
  Info: 'info',
  Error: 'danger',
} as const);

export type MessageType = typeof Constants_MessageType[keyof typeof Constants_MessageType];

export const Constants_ServiceResultType = Object.freeze({
  Success: 10,
  Error: 20,
} as const);

export type ServiceResultType = typeof Constants_ServiceResultType[keyof typeof Constants_ServiceResultType];

export const Constants_LayerType = Object.freeze({
  MapImageLayer: 0,
  FeatureLayer: 2,
  /** @deprecated Legacy compatibility only. Modern GIS engine rejects WMS/OGC service variants. */
  WMSLayer: 3,
  GeoJSONLayer: 5,
} as const);

export type LayerType = typeof Constants_LayerType[keyof typeof Constants_LayerType];

export interface SimpleSymbol {
  readonly type: string;
  readonly color?: string | readonly number[];
  readonly outline?: Readonly<Record<string, unknown>>;
  readonly style?: string;
  readonly size?: number;
  readonly width?: number;
}

export const Constants_Symbols = Object.freeze({
  activeFillSymbol: Object.freeze({
    type: 'simple-fill',
    color: Object.freeze([55, 55, 55, 0.3]),
    outline: Object.freeze({ color: '#b0ff5b', width: 3 }),
  }),
  polylineSymbol: Object.freeze({ type: 'simple-line', color: '#b0ff5b', width: 4 }),
  pointSymbol: Object.freeze({
    type: 'simple-marker',
    style: 'circle',
    size: 8,
    color: Object.freeze([64, 64, 255]),
    outline: Object.freeze({ color: '#b0ff5b', width: 4 }),
  }),
  polygonSymbol: Object.freeze({
    type: 'simple-fill',
    color: Object.freeze([255, 255, 255, 0.7]),
    outline: Object.freeze({ color: '#b0ff5b', width: 3 }),
  }),
} as const);

export const Constants_ConfigKeys = Object.freeze({
  BOOKMARKS: 'a8s1xiapslcqxefef34jk',
  THEME_CHOICE: 'kent-rehberi-theme-choice',
} as const);

export const Constants_UserMesssages = Object.freeze({
  LOCATION_ALLOWED: 'Konumunuz kullanılıyor',
  LOCATION_REJECTED: 'Konumunuz alınamadı, varsayılan konumdan itibaren arama yapılıyor',
} as const);
