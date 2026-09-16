// Explicitly bridge the typed accessibility runtime into the legacy CRA 4
// resolver. The product consumes the TypeScript implementation; CI validates it
// with the dedicated strict/noEmit configuration without changing the root
// lockfile or forcing unrelated legacy modules through TypeScript at once.
export * from "./accessibilityRuntime.ts";
