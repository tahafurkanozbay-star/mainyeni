# Webclient Runtime Contract

The production web client uses Node 24 and npm 11 with the lockfile committed under `Webclient.app`.

## Runtime and build

- React 19.3 with `createRoot`
- Vite 8.3 / Rolldown production builds
- TypeScript 7 in strict incremental-migration mode (`allowJs: true`)
- Oxlint for fast static analysis
- Vitest 5 + jsdom 30 for tests
- Redux 5 with the legacy store API retained only while state slices migrate incrementally
- Native Fetch through `platform/http/httpClient`; new business code must not introduce a second HTTP client

## Quality gates

Run `npm run verify` for lint, strict type checking, tests, production build and bundle verification. CI additionally runs a production-only dependency audit and the build-budget regression suite.

Production builds must not emit source maps or unresolved CRA placeholders. Bundle budgets are enforced by `scripts/verify-build.mjs` and `scripts/web-build-budget.mjs`.

## Migration rules

New or materially rewritten UI/runtime modules should be TypeScript (`.ts`/`.tsx`). Existing JavaScript with JSX is supported by the Vite Oxc compatibility transform so migration can proceed without a risky big-bang rewrite.

Do not add WMS/WFS fallbacks, invent ArcGIS service URLs, or bypass the shared same-origin HTTP policy. Browser secrets, authorization headers and privileged credentials are not part of the frontend contract.
