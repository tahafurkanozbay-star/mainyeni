# Request framing threat model

HTTP request smuggling and desynchronization defects frequently begin where two hops disagree about request boundaries. The platform therefore treats body-framing metadata as a trust boundary rather than ordinary application input.

The accepted surface is deliberately small: no framing header for bodyless requests, one canonical decimal `Content-Length`, or one `chunked` transfer coding. Combining length and transfer coding is invalid. Multiple field values are invalid even when textually identical because accepting duplicates delegates normalization semantics to infrastructure outside the application's control.

The policy is intentionally independent from endpoint model binding. A request can be rejected before MVC or minimal-API binding allocates body models. This reduces both ambiguity and unnecessary work for malformed requests.

The policy also does not infer safety from a particular reverse proxy. Deployment topology can change, and local development may bypass the production proxy entirely. Keeping the invariant in application governance provides defense in depth and a stable test target.

Diagnostics use stable machine-readable codes: `ambiguous-body-framing`, `multiple-content-length`, `invalid-content-length`, `multiple-transfer-encoding`, and `unsupported-transfer-encoding`. Raw values are never included in rejection details.

Future changes should preserve precedence: combined framing first, individual framing validity second, aggregate header budgets third, and body content-type policy afterward. This ordering makes security failures deterministic and prevents a malformed framing request from being misreported as an ordinary media-type error.
