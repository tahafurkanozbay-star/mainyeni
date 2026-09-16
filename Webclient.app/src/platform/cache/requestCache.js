// Compatibility adapter during the staged JavaScript -> TypeScript platform migration.
// Existing HTTP consumers retain the stable module path while the cache implementation is typed.
export * from './requestCache.ts';
