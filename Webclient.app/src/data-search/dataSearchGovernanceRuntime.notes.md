## Governance invariants

1. Dataset revisions advance only when normalized dataset fingerprints change.
2. Cache keys include dataset revision, dataset fingerprint, request fingerprint and optional result-window fingerprint.
3. Spatial cursors include dataset revision/fingerprint and query fingerprint; stale windows fail closed.
4. Filter indexes never make `contains` or `neq` semantics more restrictive; unsupported operators remain residual work.
5. Category ontology does not own icon URLs, markers or 3D presentation. It provides canonical semantic identity only.
6. Schema strict mode rejects breaking drift, optimistic revision conflicts and configured alias-coverage loss.
7. All mutable runtime collections are bounded and every diagnostic surface is deterministic.
8. No new network endpoint, browser transport, telemetry path, WMS/WFS/WMTS integration or secret-bearing configuration is introduced.
