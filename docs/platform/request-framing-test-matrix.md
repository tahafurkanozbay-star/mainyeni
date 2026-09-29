# Request framing regression matrix

The Platform security suite covers the following contract categories.

| Boundary | Accepted | Rejected |
| --- | --- | --- |
| Content-Length presence | absent | duplicate field values |
| Content-Length syntax | `0`, positive decimal, Int64 max | blank, negative, explicit plus, comma list, decimal point, alpha, overflow |
| Transfer-Encoding presence | absent | duplicate field values |
| Transfer-Encoding syntax | `chunked`, case variants, outer whitespace | gzip, compress, coding chains, blank |
| Combined framing | none | any Content-Length plus any Transfer-Encoding |
| Evaluation precedence | valid framing before content policy | ambiguity before individual syntax; syntax before media type |

Regression tests are split between a pure policy suite and evaluator integration tests. The pure suite makes parser semantics cheap to exercise. The evaluator suite proves the policy is actually wired into the production decision path and that HTTP status/code behavior remains stable.

Release validation should continue running the complete Platform security test project rather than selecting only these tests. Framing behavior interacts with aggregate header budgets, content-type admission and middleware response behavior, so whole-project execution is the authoritative gate.

A test must not weaken the invariant merely because a particular test server normalizes a malformed header before application code sees it. Pure policy tests exist specifically so edge forms remain covered even when an in-memory host cannot represent every wire-level shape.
