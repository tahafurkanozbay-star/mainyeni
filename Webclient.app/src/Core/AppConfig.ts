import { runtimeConfig } from '../platform/config/runtimeConfig';

export const AppConfig = Object.freeze({
  App: Object.freeze({
    Title1: 'Ankara Büyükşehir Belediyesi',
    Title2: 'Kent Rehberi',
    Version: runtimeConfig.release,
    EsriApiVersion: runtimeConfig.esriApiVersion || '5.1.24',
    IsFullVersion: true,
  }),
  Keys: Object.freeze({
    LocalStorageKey: '3453-5948-1928-3885',
  }),
} as const);

export type AppConfiguration = typeof AppConfig;
