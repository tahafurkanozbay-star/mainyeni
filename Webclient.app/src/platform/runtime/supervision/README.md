# Platform Runtime Supervision

This package is the coordination layer above the existing typed platform runtime primitives. It does not replace the HTTP client, runtime kernel, resource budget, scheduler, resilience helpers, GIS lifecycle, or the shared icon authority. Its purpose is to make startup, readiness, failure containment, and bounded asynchronous work deterministic at application scale.

## Design goals

- deterministic dependency-aware startup and reverse shutdown
- explicit required, optional, and ordering-only dependencies
- fail-closed handling for critical runtime components
- best-effort continuation for optional capabilities
- bounded startup/shutdown deadlines, including legacy operations that ignore `AbortSignal`
- rollback of already-started components after fatal startup failure
- one health/readiness registry with TTL and staleness semantics
- bounded global and per-lane request concurrency
- same-key in-flight deduplication with subscriber-aware cancellation
- observer isolation so telemetry/listener failures never replace business outcomes
- deterministic snapshots suitable for diagnostics without storing raw user queries or secrets

## Dependency graph

`DependencyGraphRegistry` owns component metadata and compiles it into an immutable graph snapshot. A dependency can be:

- `required`: the dependency must exist and be running before the component starts.
- `optional`: if present, it participates in ordering, but absence does not invalidate the graph.
- `after`: an ordering hint only; it does not become a runtime readiness dependency.

Compilation rejects duplicate component ids, required missing dependencies, self-cycles, and multi-node cycles. The compiled graph exposes startup levels, startup order, reverse shutdown order, dependents, required dependencies, transitive dependencies, and a deterministic longest dependency path.

Startup levels are intentionally preserved instead of flattening everything into a single serial list. The lifecycle coordinator can therefore start independent components in the same level concurrently while preserving dependency correctness.

## Lifecycle coordinator

`LifecycleCoordinator` registers typed components with `start` and optional `stop` callbacks. Startup follows the compiled graph and records a state snapshot for every component:

- `registered`
- `starting`
- `running`
- `stopping`
- `stopped`
- `failed`

Critical components are automatically included in readiness requirements. Startup or shutdown callbacks receive an `AbortSignal`; a hard deadline is also enforced with `Promise.race`, so a legacy callback that ignores the signal cannot keep the caller blocked forever.

A fatal startup failure triggers reverse-order rollback for components that already reached `running`. Optional failures can be configured to continue. Important failures are fatal by default and can be explicitly relaxed for controlled migrations.

Restarting one component computes its transitive dependents, stops that affected subgraph in reverse order, and starts it again in dependency order. Unrelated components remain running.

## Health and readiness

`HealthRegistry` stores normalized component health signals with bounded text/details and optional TTL. A health record is marked stale when its TTL expires or when a configured freshness policy is exceeded.

Readiness is evaluated only against explicitly required components. The report separates:

- healthy
- degraded
- unhealthy
- unknown
- disabled
- stale

Unhealthy, unknown, and stale required components block readiness by default. Degraded and disabled components produce degraded readiness unless policy makes them blocking. This gives the application a deterministic signal for whether critical platform work may proceed without pretending optional observability or enhancement services are mandatory.

No raw request payload, address query, token, secret, or arbitrary object is retained in the health registry. Diagnostic details are restricted to bounded scalar values.

## Request coordinator

`RequestCoordinator` provides bounded asynchronous work scheduling for browser-side platform activity such as data refreshes, configuration lookups, metadata probes, and other shared runtime work.

It enforces:

- global concurrency
- global queue bounds
- per-lane concurrency
- per-lane queue bounds
- deterministic priority ordering for queued work
- unique request keys
- optional same-key in-flight deduplication
- independent subscriber cancellation
- underlying operation cancellation when all subscribers disappear
- lane-wide and global cancellation
- explicit disposal

Deduplication shares one operation while keeping each subscriber's cancellation independent. Cancelling one view does not cancel work still needed by another view. When the last subscriber cancels, the underlying operation signal is aborted and queued orphan work is removed.

The coordinator never assumes that cancellation makes network activity invisible. Server-side authorization, least privilege, and data minimization remain the security boundary.

## Runtime supervisor

`RuntimeSupervisor` composes lifecycle, health, and request coordination. It offers one snapshot containing the compiled dependency graph, component lifecycle states, readiness, request queue metrics, and a bounded event history.

Work submitted through the supervisor is readiness-gated by default. Callers can opt out only for explicit recovery/bootstrap operations. A request can also be bound to a component id; component-bound work fails closed if that component is not running, is unhealthy, or has stale health.

The supervisor records bounded lifecycle/health/request state transitions for local diagnostics. Event observers are isolated and cannot interfere with runtime control flow.

## Security and privacy

The supervision package adds no endpoint, analytics transport, remote font, CDN, secret, token, WMS, WFS, or service-provider assumption. It is purely an in-process coordination layer.

Identifiers reject control characters and are length-bounded. Health diagnostic text and details are bounded. Observer exceptions are isolated. Queue limits prevent unbounded browser memory growth under repeated work submission.

## Performance characteristics

Graph compilation is deterministic and intended for the relatively small set of application runtime components. Compiled ordinary snapshots are cached by the registry until mutation.

Request scheduling uses bounded queues and lane counters. Health snapshots are bounded by the number of registered component signals. Event history is bounded by configuration and defaults to 256 entries.

No polling loop or background timer is introduced by the supervision layer. Timers exist only for active lifecycle deadlines.

## Integration boundaries

This package should be used for platform component orchestration, not as a second GIS layer manager or a second search engine. GIS-specific layer/view ownership remains under the existing GIS runtime. Search ranking/index semantics remain under the data-search runtime. Icon mapping remains under `iconRegistry.json` and the shared GIS icon resolver/presentation path.

The top-level runtime barrel exports the supervision package so future platform bootstrap work can migrate feature-by-feature without rewriting existing consumers.
