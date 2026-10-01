# Data/Search v8 — Bounded Typo Resilience and Safe Query Recovery

v8 extends the strict-TypeScript Data/Search boundary with bounded typo tolerance and safe query recovery. It is deliberately additive: existing normalization, v6 query parsing/relevance, v7 unified execution, address semantics, spatial execution, filtering, dataset revision identity, cache lifecycle and session cancellation remain authoritative.

## Problem closed by v8

The merged v1–v7 stack is intentionally strict and deterministic. That protects data integrity, but a user typo such as `hastene` or a transposition such as `pakri` can produce no useful local result even when the intended term exists in the already-loaded dataset.

A naive fuzzy-search implementation would be unsafe for this project because it can:

- scan an unbounded dictionary on every keystroke;
- silently reinterpret field-qualified or exclusion syntax;
- corrupt exact address/postal/numeric intent;
- replace a correct canonical result with a weaker fuzzy match;
- introduce a second relevance scorer that disagrees with v6;
- retain raw query telemetry or create a network spell-check dependency;
- bypass dataset revision identity and return stale suggestions.

v8 closes the typo-recovery gap without doing any of those things.

## Canonical-first invariant

`QueryResilienceRuntimeV8` always executes the original request through the existing v7 execution authority first.

The default fallback policy is deliberately conservative:

1. run the canonical v7 request unchanged;
2. build a rewrite plan from the local corpus lexicon;
3. only when the original request is not blocked and returns zero results, allow one fallback attempt;
4. execute the rewritten query through the same v7 authority;
5. accept the fallback only when it strictly improves the result;
6. otherwise return the original result unchanged.

There is never a recursive correction loop. The hard maximum fallback-attempt budget is one.

## Bounded edit distance

`BoundedEditDistanceRuntimeV8` implements thresholded Damerau-style edit distance for normalized search tokens.

The implementation is bounded by:

- maximum canonical token length;
- maximum edit-distance threshold;
- one dynamic-programming row per input character;
- early length-delta rejection;
- early row-minimum rejection;
- optional adjacent-transposition support.

Rejected terms report a bounded `threshold + 1` sentinel rather than spending work calculating an irrelevant full distance.

The runtime exposes only structural diagnostics and counters. It does not retain a history of raw user query strings.

## Corpus-derived lexicon

`TermLexiconRuntimeV8` builds its vocabulary only from existing normalized local `NormalizedRecord` data.

Indexed semantic fields are:

- title;
- category;
- type;
- district;
- neighborhood;
- street;
- address;
- postal code;
- canonical search text.

The lexicon tracks bounded structural evidence:

- document frequency;
- total frequency;
- first source record index;
- fields in which a term appeared.

It does not retain provider response objects, credentials, external endpoint facts or a second copy of complete raw records.

## Lexicon budgets

The lexicon is constrained by explicit policy budgets for:

- maximum records;
- maximum distinct terms;
- maximum term length;
- maximum terms admitted per record;
- maximum suggestions;
- maximum candidate comparisons per suggestion request;
- minimum document frequency;
- minimum suggestion length;
- maximum edit distance.

Candidate generation uses bounded prefix and token-length buckets. A suggestion request does not scan the whole vocabulary.

## Deterministic suggestions

Suggestion ranking combines:

- normalized edit similarity;
- corpus document frequency;
- a small prefix-relation bonus.

Ties are resolved by:

1. score descending;
2. edit distance ascending;
3. document frequency descending;
4. total frequency descending;
5. first source index ascending;
6. Turkish-aware lexical order.

Near-equivalent candidates at the same edit distance are marked ambiguous. Ambiguous candidates are never automatically rewritten by the default planner.

## Syntax-safe rewrite planning

`QueryRewriteRuntimeV8` reuses the v6 `analyzeTextQuery` parser. It does not invent a second query language.

Automatic rewrite is blocked for syntax-sensitive queries containing any of:

- field-qualified clauses such as `title:hastene`;
- required terms such as `+hastene`;
- excluded terms such as `-hastene`;
- quoted phrases;
- malformed quotes;
- analyzer-truncated input.

This rule is intentional. Preserving explicit user syntax is more important than fuzzy recall.

## Rewrite admission

A simple token can be replaced only when all configured evidence gates pass:

- token length meets the minimum;
- source term is not already exact in the corpus lexicon;
- edit distance is inside the hard threshold;
- candidate document frequency meets the floor;
- candidate confidence meets the minimum;
- the best candidate is not ambiguous;
- its score gap over the next alternative meets policy;
- total corrections remain within the per-query budget;
- total analyzed terms remain within the query-term budget.

A plan that does not satisfy these facts fails closed and preserves the canonical query.

## Modes

v8 supports three explicit modes:

### disabled

No rewrite is produced. The canonical v7 behavior is used unchanged.

### suggest

The planner can produce a safe proposed rewrite, but `QueryResilienceRuntimeV8` does not execute it automatically. This mode is suitable for presentation surfaces that want to render a “did you mean” choice without changing search behavior.

### fallback

A high-confidence rewrite can be executed once after the canonical path meets the fallback threshold. Default threshold is zero canonical results.

## Existing relevance remains authoritative

v8 does not add a fuzzy relevance scorer.

When a fallback is attempted, the rewritten query is sent through `DataSearchExecutionRuntimeV7`, which continues to compose:

- v6 deterministic text relevance;
- v4 address semantics;
- existing candidate planning;
- existing spatial indexes;
- existing filter semantics;
- existing facet and result-window behavior.

Therefore ranking after typo recovery remains the same ranking implementation used for an equivalent correctly typed query.

## Filters, address and spatial intent

A rewrite changes only the textual `query` value. All other `SearchRequest` facts are preserved:

- filters;
- facets;
- sort;
- minimum score;
- page offset/limit;
- explicit center and radius;
- level;
- district;
- neighborhood;
- street;
- cancellation signal.

A typo fallback cannot remove a filter or broaden a spatial/address policy boundary.

## No hidden geocoding side effect

v8 does not call forward or reverse geocoding providers.

Geocoding remains owned by the existing injected `GeocodingRuntime` and v4 consensus/resolution boundaries. Query correction is local corpus computation only.

A misspelled address-like query cannot trigger a new network request merely because v8 recognizes a local correction candidate.

## Revision-safe lifecycle

`QueryResilienceRegistryV8` registers existing `DatasetSnapshot` objects. It does not normalize or admit raw datasets itself.

For a dataset identity, it binds the resilience runtime to:

- normalized dataset key;
- dataset revision;
- dataset fingerprint.

Re-registering the same identity reuses the current runtime. Replacing a revision/fingerprint rebuilds the v8 lexicon/runtime and invalidates stale revision-bound cache entries.

This prevents typo suggestions learned from an old dataset from silently surviving into a new revision.

## Cache reuse

The registry reuses the existing v5 `RevisionedSearchCache` authority rather than creating a new cache implementation.

Cache identity includes:

- dataset key;
- dataset revision;
- dataset fingerprint;
- normalized request structure;
- dedicated v8 namespace.

Requests carrying an `AbortSignal` are not cached. Results whose selected v7 execution is fail-closed are not cached. Oversized values remain subject to the existing cache byte budgets.

## Session reuse

Interactive search continues to use the existing `SearchSession` authority.

`QueryResilienceRegistryV8.createSession()` delegates to that runtime, preserving:

- bounded debounce;
- superseded-request cancellation;
- caller abort propagation;
- stale response rejection;
- bounded session history;
- disposal semantics.

No second debounce/cancellation state machine is introduced.

## Network and security boundary

v8 introduces no:

- endpoint;
- `fetch` transport;
- axios transport;
- XMLHttpRequest;
- WebSocket;
- WMS/WFS/WMTS integration;
- remote spell-check service;
- analytics destination;
- telemetry upload;
- remote font/CDN asset;
- token, key, password or client secret;
- unsafe HTML/eval/dynamic-code path.

All typo resilience is performed locally over already-admitted normalized data.

## Privacy

Runtime snapshots expose bounded counts, corpus fingerprints and policy facts. They do not retain or publish raw user-query histories.

`QueryRewritePlanV8` naturally contains the current caller-provided query because it is the synchronous return value needed by the caller. The registry does not persist those plans as history or send them anywhere.

## Performance invariants

The implementation explicitly avoids full-corpus or full-vocabulary work on every rewrite request:

- lexicon construction happens when the dataset runtime is created;
- candidate suggestions use prefix/length buckets;
- candidate comparisons have a hard cap;
- edit distance has token-length and distance caps;
- fallback execution happens at most once;
- correct canonical queries do not perform fallback execution;
- syntax-sensitive queries fail closed before suggestion work;
- registry dataset count is bounded;
- cache entries/bytes/TTL remain bounded by the existing cache runtime;
- sessions and their histories remain bounded by the existing session runtime.

## Data integrity boundary

v8 accepts `DatasetSnapshot`, not raw external payloads.

Normalization, schema admission, duplicate handling, coordinate validation, quarantine/release decisions and dataset revision creation remain owned by earlier Data/Search layers. v8 must never become a bypass around those controls.

## Icon and presentation boundary

v8 returns ordinary canonical search records/results. It does not resolve or store icon assets.

The repository's shared deterministic icon resolver remains the single authority for 2D, 3D and table/list presentation.

## Language modernization decision

The active Data/Search production boundary is already strict TypeScript and the repository has previously completed the JavaScript-to-TypeScript cutover for this domain.

v8 therefore uses strict TypeScript exclusively. Introducing a new language or framework for typo handling would increase build complexity, duplicate contracts and weaken the existing typed CI boundary without a measurable runtime or security advantage.

The modern approach here is not a novelty rewrite; it is stronger typed contracts, bounded algorithms, explicit policy, deterministic evidence and exact-head regression validation.

## Adoption

A single dataset can use v8 directly:

```ts
const resilient = createQueryResilienceRuntimeV8(dataset, {
  rewrite: { mode: 'fallback' },
});
const result = resilient.search({ query: 'hastene' });
```

Applications managing several dataset revisions should use the registry:

```ts
const registry = createQueryResilienceRegistryV8();
registry.register(dataset);
const result = registry.search(dataset.key, { query: 'hastene' });
```

Interactive consumers should continue through the canonical session lifecycle:

```ts
const session = registry.createSession({ debounceMs: 180 });
const envelope = await session.schedule(dataset.key, { query: 'hastene' });
```

## Release invariants

A v8 change is not considered production-ready until the exact PR head passes the repository's required Webclient Quality, Release QA, Platform Architecture Audit and Typed Source Boundary workflows, including exact-base TypeScript and Vitest regression checks, production Vite build, bundle integrity and build budgets.

Release gates must not be weakened to admit typo-resilience code.
