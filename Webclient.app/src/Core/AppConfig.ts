import { runtimeConfig } from '../platform/config/runtimeConfig';

export const AppConfig = Object.freeze({
  App: Object.freeze({
    Title1: 'Ankara Büyükşehir Belediyesi',
    Title2: 'Kent Rehberi',
    Version: runtimeConfig.release,
    EsriApiVersion: runtimeConfig.esriApiVersion || '4.21',
    IsFullVersion: true,
  }),
  Api: Object.freeze({
    BaseUrl: runtimeConfig.apiBaseUrl,
    TkgmCityId: runtimeConfig.tkgmCityId,
  }),
  Keys: Object.freeze({
    // Namespace identifier only; never place authentication material in client constants.
    LocalStorageKey: '3453-5948-1928-3885',
  }),
} as const);

export type AppConfiguration = typeof AppConfig;
