// Compatibility adapter during the staged JavaScript -> TypeScript platform migration.
// CRA consumers keep the current import path while Vite-ready typed configuration lives in runtimeConfig.ts.
export * from './runtimeConfig.ts';
