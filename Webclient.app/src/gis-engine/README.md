# GIS Engine

The GIS engine is the strict TypeScript runtime boundary for Kent Rehberi. Production modules and tests under `src/gis-engine` are TypeScript-only; the remaining JavaScript migration outside this directory is handled by the owning Platform, Business and Experience workstreams.

## Runtime contracts

`contracts.ts` and `runtimeContracts.ts` define the shared domain language for services, layers, geometries, view state, icons, performance budgets and cancellation. Runtime modules should prefer these contracts over ad-hoc object shapes so 2D and 3D behavior share the same deterministic state and resource policies.

`modernGisKernel.ts` is the production composition boundary. In addition to query, service-health, layer-lifecycle, rendering and scene-streaming coordination, it exposes the operational runtimes below:

- `temporalLayerRuntime.ts`: bounded time extents, cursor/window planning and deterministic playback for time-aware 2D/3D layers.
- `editTransactionRuntime.ts`: bounded add/update/delete transactions with optimistic revisions, cancellation, rollback and adapter-owned commits.
- `mapStatePersistenceRuntime.ts`: versioned map-session serialization with TTL, tamper fingerprints, selection/layer limits and secret-like metadata redaction.
- `exportPlanRuntime.ts`: deterministic PNG/JPEG/PDF render planning with DPI, pixel, dimension, layer and working-memory budgets.

These modules plan and validate work; they do not invent service endpoints or bypass server-owned authorization.

## ArcGIS and network policy

The engine uses the pinned `@arcgis/core` ESM boundary and the repository's verified ArcGIS service contracts. New WMS/WFS/WMTS integrations are not introduced by this engine. Service URLs must come from existing verified configuration and same-origin/server-owned policy rather than component-local or client-invented endpoints.

ArcGIS loading is centralized through the ESM module catalog/runtime and bounded load governor. Query execution, pagination, request scheduling and service health use explicit cancellation, deduplication, cardinality and memory limits.

## Icon authority

`iconRegistry.json` remains the only record/category-to-icon configuration authority. `iconResolver.ts` and `iconPresentation.ts` are the shared deterministic resolver/presentation path used by list/table, 2D marker, popup and 3D surfaces. Do not add a second icon map in a component.

## Spatial, render and view state

Spatial-reference, geometry-integrity, query-contract, snapshot, cache and analysis runtimes fail closed on malformed or unsupported input. Render and scene planners bound clustering, LOD, resident memory, request concurrency and streaming decisions. `viewState.ts` and related coordinators keep 2D/3D state transitions serializable and deterministic.

Temporary query results and operational layers must use scoped ownership/cleanup helpers instead of global map clears. Long-running work must accept or propagate `AbortSignal` where an adapter performs asynchronous I/O.

## TypeScript boundary

`tsconfig.gis-modern-core.json` is the strict GIS compilation boundary used by Webclient Quality. New operational runtime tests are included directly in that boundary. Legacy `.js`, `.jsx`, `.mjs` and `.cjs` files must not be reintroduced under `src/gis-engine`.

## Migration rule

Keep `main` as the canonical integration source. Long-lived or diverged branches must not receive new modernization work; refresh from current `main`, preserve validated behavior, and let exact-head CI verify typecheck, lint, tests, release audit, build integrity and bundle budgets before merge.
