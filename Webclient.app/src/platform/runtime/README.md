# Adaptive Platform Runtime

This directory is the TypeScript 7 runtime foundation for the Kent Rehberi web client. It is intentionally framework-neutral so React rendering, GIS engines, search, and backend-facing business modules can consume the same bounded scheduling, resilience, privacy, and resource contracts without creating parallel implementations.

## Design goals

- Preserve the existing production shell while JavaScript modules migrate incrementally to strict TypeScript.
- Prefer measurable runtime budgets over device-name or browser-name heuristics.
- Keep cancellation, timeout, retry, queue pressure, and ownership explicit.
- Never treat browser-visible network traffic as secret.
- Keep telemetry local and privacy-safe unless a separately reviewed transport is introduced later.
- Avoid WMS/WFS assumptions; GIS-specific transport policy remains owned by the GIS service capability layer.
- Keep the existing JSON icon registry as the single icon authority.

## Modules

### `contracts.ts`

Defines the shared runtime language: lifecycle phases, capability profiles, adaptive budgets, scheduler snapshots, telemetry events, retry/circuit contracts, resource reservations, state snapshots, and safe utility functions.

### `capabilityProfile.ts`

Builds a bounded capability profile from feature detection and optional browser signals. Hardware concurrency, device memory, effective network type, downlink, RTT, Save-Data, reduced motion, WebGL2, workers, observers, and selected platform APIs contribute to an adaptive `minimal`, `balanced`, or `enhanced` tier. The profile watcher reacts to connectivity and preference changes without user fingerprinting or remote telemetry.

### `resourceBudget.ts`

Maps the capability tier to explicit resource budgets. It owns reservations for network, CPU, memory, render, and storage pressure. Reservations can be scoped by owner, expired by TTL, released deterministically, and inspected through aggregate snapshots.

### `taskScheduler.ts`

Provides priority-aware scheduling with bounded queues, per-resource concurrency, key-based deduplication, queued replacement, AbortSignal cancellation, timeouts, drain support, and aggregate metrics. It is intended for expensive platform work that should not fan out without backpressure.

### `resilience.ts`

Provides exponential retry with bounded jitter, circuit breakers, timeout composition, AbortSignal composition, and Retry-After parsing. Cancellation is never converted into a retry.

### `privacyTelemetry.ts`

Keeps a bounded local event ring and accepts only allowlisted operational attributes. Sensitive key families such as credentials, tokens, cookies, user identity, addresses, queries, and coordinates are rejected before storage. No network sink exists in this module.

### `stateStore.ts`

Provides immutable versioned state, optimistic compare-and-set, conflict-detecting transactions, subscriptions, optional persistence adapters, bounded history, and abortable state waits.

### `runtimeKernel.ts`

Composes capability observation, budgets, scheduling, telemetry, resilience, circuits, resource reservations, warmups, and module lifecycle hooks. Modules can participate in start/ready/suspend/resume/stop without owning global runtime state.

## Migration contract

JavaScript compatibility files such as `runtimeKernel.js` and `index.js` re-export the TypeScript implementation. Existing JavaScript callers can therefore keep stable imports while new code receives strict TypeScript contracts. This pattern is also used by the platform HTTP layer and by the migrated cache, config, error, endpoint-policy, diagnostics, and performance modules.

A compatibility adapter should be removed only after its remaining JavaScript callers have moved to TypeScript and the supported bundler/test matrix no longer requires the old path.

## Runtime safety rules

1. Queue and resource limits are mandatory; do not add an unbounded scheduler or cache beside this runtime.
2. Always propagate `AbortSignal` when the caller owns cancellation.
3. Deduplication keys must describe equivalent work; never deduplicate requests with different authorization or semantic inputs.
4. Do not put raw URLs with query parameters, search text, coordinates, credentials, names, addresses, or personal identifiers in telemetry.
5. Retry only operations known to be safe to repeat. Mutating operations require an idempotency strategy before retry can be enabled.
6. Circuit breakers isolate repeated transient failure; they do not replace error handling or server-side authorization.
7. Resource reservations are ownership-scoped. A feature must release only resources it owns.
8. Save-Data, reduced-motion, low-memory, and low-connectivity signals reduce budgets; they must never be used to deny core functionality.
9. GIS feature budgets are ceilings, not permission to render every record. The GIS runtime remains responsible for spatial filtering, pagination, LOD, clustering/generalization policy, and geometry integrity.
10. Runtime snapshots contain aggregates only and are suitable for diagnostics, not user tracking.

## Validation

`runtime.test.js` exercises capability decisions, resource pressure, telemetry privacy, state transactions, retries, circuit breaking, scheduler priority/deduplication/cancellation/backpressure, and kernel lifecycle. The existing Webclient Quality workflow additionally runs strict TypeScript 7 platform typecheck, the full Jest regression suite, and the production build.
