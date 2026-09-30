# Data/Search v6 — Query Relevance and Corpus Governance

This layer extends the existing strict-TypeScript Data/Search authority without replacing the v1-v5 contracts. It does not create a second normalization, schema, filter, GIS icon, geocoding or network authority.

## Purpose

v6 closes the local text-search execution gaps that remained after v5 data governance:

- bounded Turkish-aware query parsing;
- deterministic field-weighted relevance indexing and ranking;
- filter-first query execution over the existing v5 filter planner;
- bounded facet aggregation and autocomplete suggestions;
- revision/query/filter-bound relevance keyset cursors;
- optimistic, atomic corpus revision changes with fail-closed engine rebuilds.

## Existing authorities remain canonical

- `normalization.ts` owns canonical text/record normalization.
- `filterIndexRuntime.ts` owns indexed filter candidate planning.
- `schemaRegistryRuntime.ts` owns schema admission and drift governance.
- `revisionedSearchCache.ts` owns revision-safe cached search artifacts.
- `spatialCursorRuntime.ts` owns spatial-result cursors.
- the shared GIS icon resolver remains the only icon/presentation authority.

v6 composes those boundaries; it does not fork them.

## Query analysis

`TextQueryAnalysisRuntime` supports optional terms, `+required`, `-excluded`, quoted phrases and bounded field clauses. Turkish dotted/dotless-I and accent normalization delegates to the existing normalizer.

Supported field aliases include title/name, category/kategori, type/tur/tip, district/ilce, neighborhood/mahalle, street/cadde/sokak/yol, address/adres and postal-code aliases.

Every accepted query has hard limits for input length, term count, phrase count, phrase length and field clauses. Malformed quotes are diagnostic facts rather than parser crashes.

## Relevance index

`RelevanceIndexRuntime` builds a bounded immutable inverted index with field-weighted frequencies. Scoring uses an IDF + term-frequency saturation model with document-length normalization, phrase boosts and exact-title boosts.

The index is bounded by record count, distinct-term count, postings per term, candidate count, prefix expansion count and returned results. Deterministic ties use Turkish title order, source index and record fingerprint.

Required, excluded, field and phrase evidence is enforced before a candidate becomes a hit. Prefix matching is bounded and is never used for undersized prefixes.

## Filter-first execution

`DataSearchQueryEngineV6` asks the existing `FilterIndexRuntime` for candidate positions before relevance reranking. Residual filter operators are then evaluated using the existing `matchesFilter` semantics.

A filtered query is not allowed to silently broad-scan when the filter plan or rerank corpus exceeds policy. It returns a fail-closed blocked diagnostic instead.

Unfiltered queries reuse the prebuilt global relevance index. Filtered queries build a bounded subset index only after candidate narrowing.

## Facets and suggestions

`FacetAggregationRuntime` bounds input documents, indexed fields, distinct values and returned buckets. Missing values are counted explicitly and can be exposed as a dedicated bucket. Selected buckets are marked without changing canonical source data.

`SearchSuggestionRuntime` builds a bounded local dictionary over titles, categories, types, districts, neighborhoods, streets and normalized terms. Suggestions are deterministic and never require a remote autocomplete endpoint.

## Relevance keyset cursors

`RelevanceCursorRuntime` encodes the last ranked hit together with dataset revision, query signature and filter fingerprint. The cursor has a checksum and hard size/page/scan budgets.

A cursor from another dataset revision, query or filter set fails closed as stale. A malformed or tampered cursor fails closed as invalid. Cursor order follows the same score/title/sourceIndex/fingerprint tie-break contract as relevance ranking.

## Atomic corpus revisions

`SearchCorpusRuntimeV6` owns an immutable active corpus snapshot and its query engine. Mutations can upsert and remove records in one optimistic revision.

Before commit it verifies expected revision, next revision, mutation budget, duplicate upsert identities, requested removals and final corpus capacity. The replacement query engine is fully built before the active state is swapped; build failure leaves the previous corpus active.

Mutation decisions are retained only in a bounded history and do not retain arbitrary provider/network payloads.

## Security and network boundary

v6 adds no endpoint and no browser `fetch`, axios, XMLHttpRequest, WebSocket, telemetry, analytics, remote asset, credential, WMS, WFS or WMTS path. It operates only on caller-supplied normalized records.

No secret, token or provider credential is introduced. Search diagnostics contain bounded structural facts and stable fingerprints rather than raw remote response bodies.

## Performance invariants

- no unbounded dictionary, posting, candidate, facet, suggestion, history, cursor or result collection;
- no recurring timer/polling loop;
- prefix expansion uses a sorted dictionary and lower-bound lookup;
- filtered reranking is limited by an explicit corpus budget;
- corpus changes rebuild off to the side and swap atomically;
- deterministic ordering prevents page jitter from unstable sort ties.

## Integration guidance

Construct v6 from already-normalized records. Use `DataSearchQueryEngineV6` for a fixed dataset or `SearchCorpusRuntimeV6` when the dataset revision changes during the session.

Keep geocoding adapters, federated source transports, spatial selection and presentation/icon resolution outside this text-search authority. Those concerns already have canonical typed boundaries in earlier Data/Search/GIS layers.
