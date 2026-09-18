# Shared Shell Runtime

This directory is the framework-light TypeScript boundary for application-shell coordination.

## Why this boundary exists

The legacy client historically mixed window state, message mutation, lazy loading, sidebar lookup and performance callbacks directly into React components. The shell runtime keeps those policies deterministic and testable without inventing a second network or GIS layer.

## Runtime modules

- `notificationCenter.ts` owns bounded notification state, TTL expiry, duplicate collapse, safe metadata and observer isolation.
- `windowLifecycleRuntime.ts` owns registration, visibility, minimization and activation order for managed windows.
- `sidebarCatalogRuntime.ts` validates sidebar groups/items and provides deterministic Turkish-aware search.
- `performanceBudgetRuntime.ts` evaluates locally collected Web Vitals samples against caller-provided budgets.
- `lazyResourceRuntime.ts` provides bounded in-memory lazy-resource caching, in-flight de-duplication, TTL and cancellation.
- `commandRegistryRuntime.ts` owns typed shell commands, normalized keyboard shortcuts, predicates and deterministic search/ranking.
- `shellKernel.ts` composes the mutable runtimes behind one lifecycle and aggregate snapshot.

## Security and privacy rules

The shell runtime does not send analytics or telemetry and does not introduce any endpoint. Web Vitals collection remains local until an explicit, separately reviewed consumer decides how to use a metric.

Notification and window metadata remove secret-like keys. Runtimes reject unsafe function/symbol/bigint metadata where metadata is persisted in state.

No token, password, credential or API key should be placed in shell metadata.

## Performance rules

Every mutable collection is bounded. There are no background polling loops.

Lazy resources use explicit capacity and TTL. Subscriber cancellation does not incorrectly cancel shared work, while explicit eviction/destroy can abort the shared loader.

Performance budgets are injected policy rather than hidden constants, so product thresholds remain reviewable and environment-specific.

## TypeScript migration rules

New production files in this directory are TypeScript-only and are compiled by `tsconfig.shared-shell.json`.

Shared surfaces migrated in the same cutover must not regain JavaScript shadows. The regression suite checks canonical typed paths and rejects TypeScript diagnostic opt-outs.

Legacy Business and Experience areas are migrated by their owning workstreams. This shell boundary must not copy or fork their configuration.

## Integration guidance

React components should keep rendering concerns in components and put deterministic state transitions here.

GIS service URLs and ArcGIS request policy remain owned by the GIS/platform layers. Shell lazy resources may load any caller-supplied resource, but the runtime itself never invents transport.

Use `createShellKernel` for new shell composition. Direct runtime construction remains supported for focused tests and isolated consumers.

Destroy the kernel during application teardown so in-flight lazy resources are aborted and mutable registries are cleared.
