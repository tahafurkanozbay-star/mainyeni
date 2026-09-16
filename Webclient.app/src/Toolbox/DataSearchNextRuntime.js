// Compatibility adapter during the staged JavaScript -> TypeScript Data/Search migration.
// Existing legacy callers can keep extensionless imports while the implementation
// and contracts live in the strict TypeScript data-search domain.
export * from '../data-search/index.ts';
