# Kent Rehberi Whole-Code Modernization Backlog

Status: active Platform/Architecture workstream

## Purpose

This backlog converts repository-wide modernization into independently verifiable migrations. It deliberately avoids broad rewrites: each item must preserve behavior, carry an explicit rollback boundary, and pass the repository's release gates before merge.

## Current baseline

- Runtime baseline is .NET 10 with centrally managed NuGet versions.
- Package versions are centralized in `Directory.Packages.props`; migrations must not reintroduce per-project version drift.
- Platform dependency governance and release evidence are already enforced by CI and must remain release-critical.
- Existing GIS, Admin, QA, Experience, and Security ownership boundaries remain intact.
- WMS/WFS is explicitly out of scope.

## Priority 0 — dependency/runtime compatibility

### P0.1 Elasticsearch client retirement — completed in this PR

The initial inventory found that `NEST` 7.17.5 was a dependency-graph artifact rather than an active Elasticsearch implementation: the central version and Toolbox package reference existed, but repository source contained no `NEST`, `Nest`, `ElasticClient`, or `IElasticClient` call sites. Therefore introducing an Elasticsearch 8 compatibility adapter would have created unused architecture rather than migrated behavior.

Completed evidence:

1. Source inventory found no Elasticsearch transport implementation or query DSL call sites.
2. `Toolbox.csproj` no longer references NEST.
3. `Directory.Packages.props` no longer centrally pins NEST 7.17.5.
4. No server endpoint, index mapping, query behavior, network path, or public contract changed.
5. Exact-head Platform Backend Validation, Platform Architecture Audit, and Release QA all completed successfully after removal.

Decision: keep Elasticsearch absent until a real product requirement and server contract exist. Do not add a replacement client speculatively.

### P0.2 Newtonsoft.Json containment

`Newtonsoft.Json` remains centrally pinned and is directly referenced by Toolbox. Do not mechanically replace it. First classify usages into framework integration, dynamic JSON/JToken behavior, custom converters, and simple DTO serialization.

Acceptance criteria:

1. Prefer `System.Text.Json` for new platform contracts.
2. Migrate simple DTO serialization only when wire output is characterized by tests.
3. Retain Newtonsoft where behavior is materially different until a compatible converter exists.
4. Prevent mixed serializer configuration from silently changing casing, enum, null, date, or reference-loop behavior.
5. Inventory transitive exposure: public Toolbox APIs must not force Newtonsoft types into callers unless behavior genuinely requires them.
6. Characterization tests must lock any observable JSON wire contract before serializer changes.

### P0.3 legacy compatibility package review

Review `System.ServiceModel.*`, LDAP, PDF/OCR, image-processing, UA parsing, RestSharp, and document packages for runtime support and security posture. A package is not removed merely because it is old; replacement requires a proven maintained path and regression coverage.

Inventory rule:

- Distinguish a centrally declared version from a project reference and from a real source call site. These are three different dependency states.
- A central version with no project reference is a cleanup candidate, not evidence that the runtime uses the package.
- A project reference with no source call site requires restore/build validation before removal because analyzers, build targets, generated code, reflection, or transitive behavior may still matter.
- A source call site requires characterization before migration.
- Never introduce a replacement package merely to preserve an unused dependency slot.

## Priority 0 — build and supply-chain guarantees

### P0.4 deterministic dependency policy

- Keep central package management authoritative.
- Reject project-local package versions except documented tooling exceptions.
- Keep NuGet vulnerability auditing release-critical.
- Ensure restore failures cannot be hidden by later successful steps.
- Prefer locked/deterministic inputs where the repository's deployment model supports them.
- Detect stale central package declarations independently from vulnerable package detection; unused dependency metadata is maintenance debt even when it does not enter the resolved graph.

### P0.5 exact-head release evidence

Every merge candidate must prove that evidence belongs to the exact PR head. CI refactors must preserve canonical evidence names consumed by release governance. Splitting a test step for diagnosis is allowed only when the canonical required evidence remains present and all test coverage is retained.

## Priority 1 — backend architecture

### P1.1 API composition boundary

Inventory duplicated service registration, authentication/authorization setup, exception mapping, JSON configuration, OpenAPI configuration, health checks, and middleware ordering across API hosts. Consolidate only behavior that is genuinely common; host-specific policy remains explicit.

### P1.2 cancellation propagation

Audit asynchronous request paths for missing `CancellationToken` propagation from HTTP endpoints through Business/data/external-client calls. Add tokens without changing public semantics, then characterize cancellation and timeout behavior.

### P1.3 outbound HTTP resilience

Inventory direct `HttpClient`, RestSharp, WCF HTTP, and ad-hoc retry usage. Standardize lifetime, timeout, cancellation, bounded retry, and failure classification. Never retry non-idempotent operations without an explicit idempotency contract.

### P1.4 database query discipline

Audit EF Core query paths for synchronous I/O, accidental tracking, unbounded materialization, N+1 access, client-side evaluation assumptions, and missing cancellation. Optimize measured hot paths rather than rewriting repositories wholesale.

## Priority 1 — frontend/runtime architecture

### P1.5 typed source boundaries

Continue replacing untyped runtime configuration and cross-module payloads with narrow validated contracts. Validation must happen at the source boundary; downstream modules consume normalized typed values rather than repeatedly parsing unknown data.

### P1.6 runtime dependency governance

Extend existing health/topology/readiness/failover/SLO/change/deployment/incident/maintenance/evidence machinery only for real operational gaps. New coordinators require bounded state, deterministic clocks in tests, immutable snapshots at public boundaries, and explicit recovery hysteresis where appropriate.

### P1.7 bundle and asset governance

Keep remote assets, duplicate icon authorities, unexpected telemetry destinations, and bundle-budget regressions release-visible. Prefer removal of duplicate runtime dependencies over micro-optimizing application code without measurements.

## Priority 1 — security

### P1.8 authentication and token handling

Characterize issuer, audience, signing-key, lifetime, clock-skew, refresh, and failure behavior before touching identity packages. Avoid permissive fallback behavior. Secrets must remain outside source and logs.

### P1.9 input and file-processing boundaries

PDF, OCR, image, XML, LDAP, and document-processing paths are untrusted-input boundaries. Add explicit size/time/resource limits and malformed-input tests before performance-oriented refactors.

### P1.10 dependency exposure minimization

Do not expose third-party package types in shared application contracts when a small internal abstraction can preserve portability and testability.

## Priority 2 — observability and operability

### P2.1 structured failure taxonomy

Align backend and frontend operational failures around stable categories: configuration, dependency unavailable, timeout, authorization, validation, capacity, degraded dependency, and unknown. Preserve useful causal detail without logging secrets or personal data.

### P2.2 bounded telemetry

Metrics labels and event dimensions must be bounded. Never use raw URLs, exception messages, user input, or identifiers as metric labels. Operational snapshots must have deterministic retention and cardinality limits.

### P2.3 startup/readiness semantics

Readiness must represent whether the process can safely serve its contract, not merely whether it is alive. Required dependencies and optional/degraded dependencies must remain distinguishable.

## Priority 2 — test architecture

### P2.4 characterization before migration

For legacy package/runtime migrations, add characterization tests first. Tests should capture observable behavior, not private implementation shape, so they survive the migration and detect real regressions.

### P2.5 deterministic time and concurrency

Platform state machines must not depend directly on wall-clock timing in unit tests. Inject clocks/schedulers where lifecycle behavior is time-sensitive and cover duplicate, reordered, stale, and concurrent evidence.

### P2.6 failure-path coverage

Every new resilience path needs tests for success, timeout, cancellation, malformed response, transient failure, terminal failure, recovery, and bounded retry where applicable.

## Priority 2 — CI maintainability

### P2.7 workflow ownership

Keep release-critical workflow steps named and discoverable. Shared scripts are preferable when several workflows duplicate nontrivial policy, but moving policy into scripts must not make release evidence opaque.

### P2.8 changed-scope acceleration

Fast changed-scope checks may supplement but never replace whole-repository release validation. Exact-base regression gates remain authoritative for merge decisions.

## Migration protocol for each backlog item

1. Establish current-main SHA and ownership boundaries.
2. Inventory call sites and observable contracts.
3. Classify dependency evidence as central declaration, project reference, source call site, or transitive-only use.
4. Add or confirm characterization tests before changing observable behavior.
5. Implement the smallest coherent migration slice.
6. Run lint/typecheck/build/unit/integration checks appropriate to the slice.
7. Fix failures without weakening gates or assertions.
8. Re-run the failed check and the broader regression suite.
9. Review security, performance, cancellation, resource bounds, and rollback behavior.
10. Rebase/merge current main as required by repository policy.
11. Require exact-head CI success before merge.

## Explicit non-goals

- No WMS/WFS additions.
- No framework rewrite for stylistic consistency.
- No package upgrade without compatibility evidence.
- No weakening of strict TypeScript, release QA, dependency audit, or exact-base regression gates.
- No line-count-driven boilerplate, duplicate tests, generated filler, or dead abstractions.
- No cross-team ownership takeover when a clean Platform boundary can be established instead.

## Next implementation slice

The NEST cleanup is complete and validated. The next code-bearing slice is dependency-exposure inventory, starting with Newtonsoft.Json and then central declarations such as RestSharp/System.ServiceModel. For each candidate, distinguish central metadata from actual project/source usage before deciding whether to remove, contain, or characterize it. In parallel, inspect request-to-data asynchronous paths for missing cancellation propagation because that yields runtime reliability value without requiring a speculative technology migration.
