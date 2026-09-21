# Webclient Runtime Contract

The production web client uses Node 24 and npm 11 with the lockfile committed under `Webclient.app`.

## Runtime and build

- React 19.3 with `createRoot` and root-level caught/uncaught/recoverable error hooks
- Vite 8.3 / Rolldown production builds using `baseline-widely-available`
- TypeScript 7 in strict incremental-migration mode (`allowJs: true`)
- Oxlint for fast static analysis
- Vitest 5 + jsdom 30 for browser/runtime tests
- Node 24 native `node:test` for build/dependency/release-tooling regressions
- Redux 5 with the legacy store API retained only while state slices migrate incrementally
- Native Fetch through `platform/http/httpClient`; new business code must not introduce a second HTTP client
- bounded stale-deployment recovery for Vite preload/dynamic-import failures; one session-scoped reload is allowed and reload loops are suppressed

`Webclient.app/src` is a strict TypeScript/TSX-only source tree. JavaScript/JSX/MJS/CJS files under `src` are rejected by the typed-source boundary and must not be restored as shadow copies beside typed modules. If a local workspace contains stale `.js`/`.jsx` files after updating, treat that workspace as dirty or outdated and refresh it from current `main` rather than adding a JSX-in-JS compatibility transform.

## Quality gates

Run `npm run verify` for dependency/lockfile validation, strict lint, Experience/Vite migration audits, strict type checking, Vitest, native tooling tests, production build, release provenance/SBOM verification, bundle integrity and size-budget verification.

`scripts/dependency-contract.mjs` scans source package imports and requires them to match `package.json` and the lockfile-v3 root contract. Runtime source may not rely on dev-only dependencies, non-release dependency specifiers are rejected, and CRA `react-scripts` cannot be reintroduced.

Production builds must not emit source maps, unresolved CRA placeholders, uncontrolled remote script/stylesheet tags or un-fingerprinted output. `npm run build` first emits `build/release-manifest.json` with SHA-256 fingerprints and source revision metadata plus `build/sbom.cdx.json` as a CycloneDX 1.6 dependency inventory, then creates `build/asset-integrity.json` with SHA-384 integrity for the complete release artifact set. `scripts/verify-build.mjs` recomputes the release inventory and the complete integrity manifest before release. Size budgets are independently enforced by `scripts/web-build-budget.mjs`.

## Environment and network policy

Browser configuration is read from Vite `import.meta.env`, with an explicit temporary `REACT_APP_*` compatibility path only for staged migration. Only `VITE_*` custom browser values are exposed by Vite. API base configuration is canonicalized to a same-origin relative application path and rejects query/hash credentials, traversal, backslashes and cross-origin URLs.

Never store tokens, authorization headers, API keys, passwords, personal addresses, search terms or coordinates in browser diagnostics. Runtime error/telemetry text is bounded and sanitizes credential fragments and URL query strings before retention. Deployment recovery records only bounded reason/cooldown/error-type metadata and never persists request URLs or user data.

## Dependency policy

Runtime packages must correspond to verified source usage. Do not retain packages only because they existed in the old CRA manifest. Current event date filtering intentionally depends on `react-datepicker` and `date-fns`; HTTP calls use the shared Fetch runtime rather than Axios.

`esri-loader` remains a compatibility dependency for the existing GIS surface, not a long-term architecture choice. ArcGIS script and CSS are resolved together from the single validated `VITE_ESRI_API_VERSION`/runtime config value so mismatched SDK/CSS versions cannot be hard-coded in `index.html`. Replacing `esri-loader` with `@arcgis/core` is a separate GIS-runtime migration and must preserve verified service URLs, cancellation, ownership, 2D/3D behavior and performance contracts rather than being performed as an unmeasured package swap.

## Migration rules

Application UI/runtime source under `Webclient.app/src` must remain TypeScript (`.ts`/`.tsx`). Do not add JavaScript/JSX compatibility transforms or keep generated/stale `.js` shadow files beside canonical typed modules; the typed-source boundary intentionally fails closed on JavaScript reintroduction.

Do not add WMS/WFS fallbacks, invent ArcGIS service URLs, create a second icon authority, or bypass the shared same-origin HTTP policy. Browser secrets, authorization headers and privileged credentials are not part of the frontend contract.
