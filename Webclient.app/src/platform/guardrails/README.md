# Platform guardrails

This package is the bounded, fail-closed boundary for values and work entering shared browser runtime infrastructure. It exists to keep resource policy deterministic and reusable without coupling feature code to individual guardrail implementations.

## Public boundary

Consumers should import from `platform/guardrails` rather than reaching into implementation modules. The barrel intentionally exposes policy constructors, normalized policy types, boundary evaluators, and capacity helpers. Implementation-only helpers remain private so internal algorithms can evolve without spreading dependencies across feature code.

The package does not perform network I/O, create telemetry, discover endpoints, or own GIS transport. It is policy infrastructure only. Network clients remain responsible for same-origin routing, authorization, cancellation, response parsing, and domain-specific validation.

## Profiles

`interactive` is the default for user-driven work. It allows more concurrency while keeping queue, cache, payload, and deadline limits bounded. Use it for commands where latency is visible to the user.

`bulk` is intended for explicitly bounded import/export or batch-style work. It permits larger payloads but reduces concurrency and queue capacity. A bulk profile is not permission to accept an unbounded response; callers must still paginate or stream large domain data.

`background` is intended for low-priority maintenance that can tolerate longer deadlines. Its low concurrency prevents background work from competing aggressively with user-driven activity. It must not be used to create polling loops or hidden telemetry.

Feature code may provide narrower overrides. Overrides are normalized by the profile factory. A feature must not widen limits merely to silence a rejected boundary without first establishing a measured requirement and reviewing memory, CPU, and latency impact.

## Text boundary

Text limits defend shared infrastructure from unexpectedly large or misleading strings. Normalize at trust boundaries before values become cache keys, diagnostics fields, headers, routing fragments, or identifiers.

Control and bidirectional formatting characters require special care because they can alter log readability, source review, or UI interpretation. The default policy rejects control and bidi controls and strips selected invisible formatting. Domain content that legitimately requires such characters should use an explicit narrower adapter rather than weakening the platform default globally.

UTF-8 byte limits are separate from JavaScript code-unit limits. Both matter: code units bound local string processing while encoded bytes approximate transport and persistence pressure.

## URL boundary

URL policy is for deterministic destination validation, not for authorization. A URL that passes syntax and origin rules is not automatically safe to access. Server-side authorization and data minimization remain mandatory.

Callers should prefer same-origin relative paths. Any allowlisted absolute origin must be explicit and reviewed. Do not add wildcard host matching, protocol downgrades, embedded credentials, or ad-hoc string concatenation around the validator.

The URL guardrail does not introduce WMS or WFS support and must not be used to infer GIS service capabilities. Service type and response contracts come from repository configuration and verified service metadata.

## Payload boundary

Payload evaluation walks supported plain data while enforcing depth, object-key, array-item, string, byte, and total-node budgets. It is designed to reject pathological shape growth before downstream state or rendering layers amplify the cost.

A successful payload boundary result means only that the generic resource shape is acceptable. Domain schema validation remains a separate responsibility. Do not treat generic shape acceptance as proof that a business, GIS, search, or configuration payload is semantically valid.

Avoid evaluating the same large object repeatedly in hot render paths. Boundary evaluation belongs at ingress, deserialization, cache admission, or other ownership transitions.

## Work budgets

Work policy bounds concurrent execution, queue depth, per-key pressure, wait time, run time, and completed-history retention. Keys should represent a stable ownership or contention domain rather than arbitrary user text.

A queue rejection is backpressure, not a reason to create a second unbounded queue in feature code. Callers should surface an appropriate error, coalesce duplicate intent, or retry only under a bounded domain-specific policy.

Cancellation is part of lifecycle ownership. When a view, route, request subscriber, or runtime owner is disposed, its pending work should stop or become unobservable. Never rely on component unmount alone while detached asynchronous work retains large values.

## Cache budgets

The bounded cache constrains entry count, aggregate estimated weight, per-entry weight, key length, and TTL. Cache admission should happen only after validation. Keys must be deterministic and must not contain secrets or raw credentials.

TTL is a freshness ceiling, not a correctness guarantee. Domain code still owns invalidation when mutations make cached values stale. Do not increase TTL to mask a slow or unreliable upstream service.

Weight is an estimate used for resource governance. It should be conservative enough to prevent obviously oversized values from accumulating; it is not a replacement for browser heap profiling.

## Deadlines

Deadline policy places lower and upper bounds around operation timeouts and limits tracked operations. Use a deadline where work crosses an asynchronous ownership boundary. Propagate `AbortSignal` whenever the underlying API supports it.

A timeout must terminate or detach the caller-visible operation deterministically. If an external API cannot be physically cancelled, late completion must be treated as stale and prevented from mutating disposed state.

Do not implement retry by multiplying deadline duration indefinitely. Retry belongs in a bounded policy with explicit attempt count, backoff, cancellation, and idempotency assumptions.

## Readiness

Readiness policy should represent whether shared runtime prerequisites are genuinely usable. It must not guess health from elapsed time alone. Keep readiness separate from feature-specific loading UI so platform state remains deterministic and testable.

Hysteresis and bounded observation are preferred when health can flap. A transient observer failure must not replace the underlying business result or crash unrelated runtime work.

## Adoption checklist

Before adopting a guardrail in a feature boundary, identify the owner and disposal point; select the narrowest suitable profile; validate before cache or queue admission; preserve `AbortSignal`; keep domain schema validation separate; avoid secrets in keys or diagnostics; confirm rejection has a bounded user-visible or retry path; and add focused tests for the relevant capacity and lifecycle edge cases.

For performance-sensitive paths, measure before widening a budget. Review queue pressure, retained cache weight, payload shape, and timeout distribution together rather than optimizing one number in isolation.

For security-sensitive paths, remember that these browser-side controls are defense in depth. They do not replace server authorization, least privilege, secure headers, input validation at the server boundary, or secret management.

## Regression expectations

Changes to defaults are platform changes and require focused tests plus exact-head repository CI. A default increase should state the measured need and expected memory/latency effect. A default decrease should demonstrate that existing callers remain within the new limit or have an explicit migration.

The public barrel is intentionally small. New exports should represent stable cross-feature contracts. Feature-specific convenience wrappers belong with the feature unless multiple independent consumers prove the abstraction belongs at platform level.

The package must remain free of direct third-party network calls, timers that outlive ownership, unbounded collections, and hidden global mutable state. Those invariants keep it safe to reuse across Business, GIS, Search, Experience, and future platform surfaces.
