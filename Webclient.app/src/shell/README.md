# Shared Shell Runtime

This directory is the strict-TypeScript coordination boundary for application-shell state.

## Ownership

The shell owns notification state, managed-window lifecycle, sidebar discovery/search, lazy-resource lifecycle and command registration. It does not own GIS transport, business APIs or performance instrumentation.

Performance measurement, budgets, baselines and lifecycle capture are canonical under `src/performance/*`. `ShellKernel` may read a `PerformanceRuntime` snapshot but never resets or duplicates the application-owned performance runtime.

## Bounded state

All mutable shell collections are bounded. Notification capacity, window registration, command registration and lazy-resource caching reject or evict work deterministically rather than growing without limit.

Notification records support TTL expiry and duplicate collapse without background polling. Lazy resources support TTL, in-flight deduplication, subscriber cancellation and explicit teardown.

## Security and privacy

The shell introduces no endpoint and no telemetry transport. It does not add WMS/WFS/WMTS, a CDN or a remote executable asset.

Secret-like metadata keys are filtered from notification and window state. Unsupported function/symbol/bigint metadata is not persisted.

Observer failures are counted instead of silently swallowed so diagnostics remain evidence-bearing without allowing a UI observer to replace the business outcome.

## Language migration

Canonical shared status/loading/message/icon surfaces are TypeScript/TSX. The migration tests reject JavaScript shadows and TypeScript diagnostic opt-outs for the migrated stems.

The dedicated `tsconfig.shared-shell.json` uses `allowJs=false` and is wired into the normal Webclient typecheck chain. Legacy Business and GIS code continues to be migrated by its owning domain rather than copied into this boundary.

## Integration

Use `createShellKernel` when a consumer needs multiple shell services under one teardown lifecycle. Focused consumers may construct individual runtimes directly.

The kernel does not implicitly call `performanceRuntime.capture()`; page-lifecycle capture remains owned by the performance domain. Kernel teardown destroys only shell-owned mutable state.

React components should keep rendering concerns in components and put deterministic state transitions in these framework-light runtimes.
