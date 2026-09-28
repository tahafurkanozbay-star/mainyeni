# Data/Search v5 governance architecture

This package extends the existing strict-TypeScript Data/Search authority without replacing the validated v1-v4 runtime layers.

## Scope

- canonical category ontology for deterministic category/type normalization;
- bounded filter indexing and candidate planning for equality, prefix, existence and numeric range predicates;
- versioned schema admission with optimistic revision checks, alias-coverage requirements and bounded history;
- revision/fingerprint-bound TTL/LRU/byte-budgeted search result caching;
- deterministic spatial keyset cursors bound to dataset revision/fingerprint and query identity;
- composed `DataSearchGovernanceRuntime` that coordinates normalization, schema admission, category coverage, filter planning, cache invalidation and spatial pagination.

## Compatibility

The package is additive. Existing search, address, geocoding, cursor and federated runtime APIs remain intact. No existing endpoint, protocol or icon authority is replaced. The existing GIS icon presentation registry remains the only icon resolver; category ontology `iconHint` values are metadata hints only.

## Security and network

The v5 modules are transport-neutral. They introduce no `fetch`, axios, XMLHttpRequest, WebSocket, WMS, WFS or WMTS integration, and define no external endpoint. Dataset identity, cursor identity and cache identity are fail-closed against stale revision/fingerprint mismatches.

## Performance

All new mutable structures are explicitly bounded by entry, distinct-value, posting, candidate, dataset, byte, TTL, history or page limits. Filter planning narrows candidate sets before residual evaluation. Spatial cursor windows use deterministic keyset ordering instead of deep offsets.

## Data integrity

Schema profiles are evaluated before governed dataset replacement. Strict mode rejects breaking drift, optimistic revision conflicts and required alias coverage loss. Category collisions and hierarchy defects remain visible in bounded diagnostics rather than silently overwriting canonical identity.
