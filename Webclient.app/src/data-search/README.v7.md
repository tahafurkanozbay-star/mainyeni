# Data/Search v7 — Unified Intent and Local Execution

v7 is a compatibility and execution layer over the existing Data/Search authorities. It does not replace normalization, address semantics, dataset candidate/spatial indexes, filter planning, relevance scoring, revision-safe caching, cancellation/debounce, geocoding providers or GIS presentation/icon resolution.

## Problem closed by v7

Before v7, the repository had strong but partially separate production authorities:

- v1 `DataSearchRuntime` exposed the long-lived `SearchRequest` / `SearchResponse` contract and owned local candidate/spatial execution;
- v4 owned address hierarchy, semantic evidence, confidence, provider consensus and race-safe resolution;
- v5 owned schema/filter/cache/result-window governance;
- v6 owned deterministic Turkish-aware text parsing, relevance, facets/suggestions, relevance cursors and atomic corpus revision handling.

The missing production boundary was a bounded way to route one local request through the correct combination of those authorities without reintroducing the old heuristic text scorer or creating a second session/cache/network stack.

v7 supplies that boundary.

## Coordinate query intent

`coordinateQueryRuntimeV7.ts` recognizes coordinate literals only when they have enough structural evidence to be safe:

- labeled latitude/longitude forms, including `lat`, `latitude`, `lon`, `lng`, `longitude`, `enlem` and `boylam`;
- WKT `POINT(lon lat)`;
- cardinal-direction pairs such as `39.92N 32.85E`;
- decimal pairs with comma/semicolon, or two decimal values separated by whitespace.

Unlabeled integer pairs are rejected by default so an address such as `No 12 34` cannot silently become a map coordinate. Ambiguous decimal pairs have an explicit `lat-lon`, `lon-lat` or `reject` policy. Latitude and longitude ranges are checked before a coordinate becomes usable.

When a coordinate is embedded inside a text query, the matched coordinate fragment is removed and the remaining text becomes the residual query. This permits hybrid requests such as `39.92, 32.85 hastane` without forcing the relevance engine to score the numeric coordinate literal as ordinary text.

## Search intent

`searchIntentRuntimeV7.ts` composes three existing semantic views:

- v6 text query analysis;
- v4 address query analysis;
- v7 coordinate-literal analysis.

It classifies a request as `empty`, `text`, `address`, `coordinate` or `hybrid`. An explicit `SearchRequest.center` always wins over a coordinate parsed from the text. Invalid explicitly supplied coordinates are a fail-closed diagnostic instead of being silently ignored.

Address classification uses existing address evidence rather than string-shape guesses. District/neighborhood/street/level hints, postal or numeric evidence, structural road/locality tokens and inferred address level contribute to a bounded intent score.

## Unified execution

`DataSearchExecutionRuntimeV7` is created for one existing `DatasetSnapshot`. It deliberately reuses that snapshot's already-built candidate and spatial indexes.

Execution paths are:

- **text** — v6 `DataSearchQueryEngineV6` is authoritative for Turkish query semantics and relevance;
- **address** — existing candidate planning narrows the corpus, existing v4 `scoreAddressRecord` supplies address evidence, and existing hierarchy/filter semantics remain authoritative;
- **coordinate** — the existing spatial index narrows records and haversine distance supplies deterministic ordering/evidence;
- **hybrid** — spatial/address candidate admission is combined with v6 text evidence without inventing another tokenizer or scorer;
- **empty** — bounded local enumeration only; it fails closed when the configured candidate budget would be exceeded.

The outward result remains the canonical `SearchResponse`, so current consumers and the existing `SearchSession` can adopt v7 incrementally. v7 also returns richer immutable execution diagnostics and evidence for typed callers.

## Score compatibility

v6 BM25-style relevance scores, v4 address scores and physical distance have unrelated numeric ranges. v7 therefore never adds their raw numbers together.

Each signal is converted to a bounded 0..1 strength and combined with intent-specific weights. The public v7 `SearchHit.score` is normalized to the range 0..1000. `minScore` on the v7 execution path therefore applies to that normalized scale.

Raw evidence remains available in `DataSearchExecutionHitV7.evidence`:

- `textScore` is the underlying v6 relevance score;
- `addressScore` is the v4 semantic address score;
- `distanceMeters` is the physical distance;
- normalized text/address/distance signals are reported independently.

## Determinism

Default relevance ordering is:

1. combined v7 score descending;
2. original `sourceIndex` ascending;
3. Turkish title order;
4. record fingerprint.

Distance, title and source-order modes keep their own primary key and then use deterministic fallbacks. This preserves stable pagination and prevents a locale sort from changing otherwise equal source-order evidence.

## Bounded execution

Policies cap:

- candidate records;
- result-window size;
- page size;
- facet fields and buckets;
- spatial radius;
- spatial index candidate count;
- v6 text result window.

A candidate overflow or invalid execution state produces a typed fail-closed result rather than broad-scanning beyond policy. A request offset beyond the configured result window is also blocked rather than pretending the full corpus was materialized.

## Registry and cache lifecycle

`DataSearchExecutionRegistryV7` owns only the lifecycle glue required to use v7 across datasets. It does not own data normalization or dataset construction.

Callers register an existing `DatasetSnapshot`. The registry creates one v7 execution runtime for that exact dataset revision/fingerprint. Re-registering the same identity reuses the runtime. Replacing the dataset rebuilds the runtime and invalidates stale cache entries.

The registry reuses v5 `RevisionedSearchCache`; cache keys include:

- dataset key;
- dataset revision;
- dataset fingerprint;
- v7 request fingerprint;
- the dedicated `data-search-v7` namespace.

Requests carrying an `AbortSignal` are not cached. Fail-closed results are not cached. Oversized cache entries are rejected by the existing byte budget instead of bypassing it.

## Session lifecycle

The registry's `createSession()` delegates to the existing `SearchSession`. Therefore v7 does **not** introduce another debounce/cancellation authority.

Existing behavior remains canonical:

- bounded debounce;
- superseded-request cancellation;
- external `AbortSignal` propagation;
- stale-response detection;
- bounded session history;
- disposal.

## Network and geocoding boundary

v7 contains no `fetch`, axios, XMLHttpRequest, WebSocket, endpoint catalog, WMS/WFS/WMTS path, remote asset, credential, analytics or telemetry destination.

Forward/reverse provider calls remain owned by `GeocodingRuntime` and the v4 consensus/resolution layers. v7 only interprets caller-provided local query text and already-normalized dataset records.

A coordinate typed by the user is treated as a local spatial intent. It does not trigger a remote reverse-geocoding request by itself.

## Data integrity and schema boundary

v7 does not admit raw provider payloads. Dataset normalization, schema admission, integrity/quarantine decisions and revision changes must happen in the existing v1/v2/v5 authorities before a `DatasetSnapshot` reaches v7.

This keeps v7 execution immutable with respect to source data and means replacing a dataset is an explicit registry lifecycle event rather than hidden mutation during a query.

## Presentation and icon boundary

v7 returns normalized records and search evidence only. It does not choose map symbols or presentation assets. The existing shared deterministic GIS icon resolver remains the single icon/presentation authority.

## Migration guidance

A staged adoption can use:

```ts
const registry = createDataSearchExecutionRegistryV7();
registry.register(existingDatasetSnapshot);
const result = registry.search(existingDatasetSnapshot.key, request);
```

Consumers that only need the historical shape can use:

```ts
const response = registry.searchResponse(datasetKey, request);
```

Interactive consumers should use the existing session authority:

```ts
const session = registry.createSession({ debounceMs: 180 });
const envelope = await session.schedule(datasetKey, request);
```

The legacy `DataSearchRuntime` remains available while call sites migrate. v7 is intentionally additive and typed; it does not require a whole-application flag day.

## Security and performance invariants

- no new external endpoint or network carrier;
- no credential or provider payload retention;
- no alternate GIS icon authority;
- no recurring polling loop;
- no unbounded query, candidate, result, facet, cache or session history;
- no broad spatial fallback after a spatial candidate budget is exhausted;
- no cache reuse across dataset revision/fingerprint changes;
- no remote request triggered solely by coordinate-literal detection;
- all request/intent/cache fingerprints are derived from bounded normalized structural facts.
