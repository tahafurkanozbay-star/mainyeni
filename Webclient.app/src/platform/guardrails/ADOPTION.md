# Guardrail ownership rule

A feature adopting this package must name the lifecycle owner that releases queued work, deadlines, cache entries, and observers.

Admission order is validation, domain authorization/schema checks, then bounded queue or cache admission. Rejection must remain explicit; callers must not bypass a failed guardrail by creating an unbounded fallback collection.

Budget increases require measured evidence and focused regression coverage. Browser guardrails remain defense in depth and never replace server-side authorization, least privilege, or data minimization.
