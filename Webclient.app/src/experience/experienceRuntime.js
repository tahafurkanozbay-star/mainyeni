// CRA 4 filters .ts from extension discovery unless a root tsconfig is present.
// Keep the legacy build stable while the Experience domain migrates: this tiny
// adapter resolves the typed module explicitly, so Babel transpiles the .ts
// source while strict TypeScript validation remains isolated in CI.
export * from "./experienceRuntime.ts";
