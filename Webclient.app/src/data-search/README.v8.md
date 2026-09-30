# Data/Search v8 — bounded typo recovery and synonym governance

## Status

This document defines the production contract for the v8 Data/Search recovery layer.

v8 is additive.

It does not replace the canonical normalizer.

It does not replace v6 relevance ranking.

It does not replace v7 intent execution.

It does not add a network transport.

It does not add a geocoding endpoint.

It does not add a second GIS query authority.

It does not add a second icon authority.

Its responsibility is narrow: recover user intent from bounded spelling mistakes and explicitly governed synonyms only when the canonical search path did not already produce enough useful results.

## Why v8 exists

The previous search generations already solve normalization, address semantics, filtering, schema integrity, spatial lookup, relevance ranking, cursors, caching and cancellation.

They intentionally do not guess arbitrary misspellings.

That boundary protects deterministic behavior, but it leaves a real usability gap for inputs such as `hastne`, `beledyie` and similar keyboard/transposition errors.

v8 fills that gap without weakening the existing fail-closed behavior.

The primary query always runs first.

Recovery is a fallback, not a replacement.

A successful primary query is never silently rewritten.

Coordinate and explicit spatial requests are never rewritten.

Blocked v7 requests are never rescued around their safety gate.

Required, excluded, quoted and field-scoped query grammar remains owned by the v6 analyzer.

## Modules

### `fuzzyLexiconRuntimeV8.ts`

This module owns the local fuzzy lexicon.

It reuses canonical `normalizeSearchToken` and `tokenizeSearchText`.

It does not define a competing locale normalizer.

The lexicon stores canonical terms, frequencies, weights and bounded source provenance.

Each term receives boundary-aware trigrams.

Trigram postings are bounded per gram.

Lookup first gathers candidates from shared trigram postings.

Lookup never falls back to scanning every lexicon term.

Candidate count is hard bounded.

Candidates then pass a length-delta gate.

Candidates then pass a gram-similarity gate.

Candidates then pass a bounded Damerau-Levenshtein gate.

The final list is sorted deterministically.

Exact matches receive explicit precedence.

Prefix relationships receive a smaller explicit boost.

Document frequency contributes only a logarithmic score component.

Term weight contributes only a logarithmic score component.

No score component can create an unbounded loop.

No score component triggers I/O.

### `synonymRegistryRuntimeV8.ts`

This module owns explicit synonym groups.

It does not infer synonyms from remote services.

It does not train or persist a user profile.

Groups have stable IDs.

Groups have one canonical phrase.

Groups have bounded aliases.

Groups can be scoped to title, category, type, district, neighborhood, street, address or any.

Alias collisions are observable in the snapshot.

Duplicate group IDs are rejected deterministically by dropping the later group.

Expansion fan-out is bounded.

Expansion token count is bounded.

Expansion is non-recursive.

An expansion never recursively expands another expansion.

This prevents synonym cycles from becoming workload amplification.

The small default civic synonym set is static application metadata.

It contains no endpoint or provider-specific behavior.

Projects can replace or extend it through explicit configuration.

### `queryCorrectionRuntimeV8.ts`

This module owns grammar-safe correction decisions.

It delegates parsing to `analyzeTextQuery` from v6.

It never parses a second query grammar.

Optional terms can be corrected.

Required terms can be corrected while preserving `+`.

Field terms can be corrected while preserving their field name.

Excluded terms are preserved by default.

Excluded correction requires an explicit policy opt-in.

Quoted phrases are preserved rather than rewritten token by token.

Known lexicon terms are preserved.

Unknown terms can receive suggestions without being automatically applied.

Automatic correction requires all configured confidence gates.

The top score must pass the minimum score.

The score margin over the next candidate must pass the minimum margin.

Edit distance must be within the automatic-correction budget.

The total number of applied corrections must remain within the request budget.

Ambiguous choices are reported but not guessed.

The corrected query is reparsed through the canonical v6 analyzer.

The result therefore exposes both original and corrected analyses.

### `searchRecoveryRuntimeV8.ts`

This module composes v8 with `DataSearchExecutionRegistryV7`.

The v7 registry remains the dataset execution authority.

The v7 registry remains the revision-safe result cache authority.

The v7 registry remains the session execution base.

v8 adds one companion fuzzy lexicon per registered dataset revision.

v8 adds one companion correction runtime per registered dataset revision.

Replacing a dataset replaces those companion objects.

LRU dataset eviction removes companion state as well.

The runtime never stores a second normalized record collection.

It derives lexicon terms from the immutable `DatasetSnapshot` already owned by v7.

## Recovery sequence

Every request follows a fixed maximum sequence.

Step 1: execute the original request through v7.

Step 2: if the result count already meets the configured threshold, stop.

Step 3: if the primary request is blocked, stop.

Step 4: if the intent is coordinate-only, stop.

Step 5: if the request contains an explicit spatial center, stop.

Step 6: evaluate correction using the dataset-bound v8 lexicon.

Step 7: if correction is confidently changed and the attempt budget allows it, execute one corrected request.

Step 8: for grammar-safe simple queries only, optionally execute one synonym-expanded variant.

Step 9: select a recovery result only when it produces more results than the primary result.

The runtime never recursively feeds a recovered query back into recovery.

The default maximum total attempt count is three.

The policy cannot configure more than three attempts.

## Fail-closed rules

A blocked v7 result stays blocked.

An invalid explicit center stays blocked.

Coordinate intent is never typo-corrected.

A request with an explicit center is never typo-corrected.

A pre-aborted request throws before recovery work starts.

The same `AbortSignal` is preserved on recovery variants.

Required grammar is never converted to optional grammar.

Excluded grammar is never converted to positive grammar.

Field grammar is never converted to free text.

Quoted phrase grammar is never decomposed by recovery.

Synonym recovery is disabled for grammar-protected queries.

A candidate-budget saturation does not trigger a broad scan.

A low-confidence suggestion is not automatically applied.

An ambiguous suggestion is not automatically applied.

An edit outside the configured distance is not automatically applied.

## Dataset identity

Recovery state is bound to the dataset key.

Recovery state is bound to the dataset revision.

Recovery state is bound to the dataset fingerprint through the underlying v7 registry.

Lexicon snapshots expose their own deterministic fingerprint.

Correction snapshots expose a fingerprint derived from lexicon, synonym policy and counters.

Search recovery diagnostics include the current dataset identity.

A replacement dataset rebuilds the lexicon.

A replacement dataset therefore cannot inherit stale typo candidates from the previous revision.

The v7 registry invalidates stale response cache entries at the same boundary.

## Turkish text behavior

v8 does not introduce locale logic of its own.

Canonical Turkish/accent-aware behavior continues to come from the existing normalizer.

For example, canonical tokenization is expected to align `Çankaya` with `cankaya`.

The fuzzy layer sees only canonical tokens.

Edit distance therefore measures actual spelling differences rather than Unicode presentation differences already handled by normalization.

This keeps locale behavior consistent across v1 through v8.

## Fuzzy candidate generation

Every canonical term is converted to a bounded set of trigrams.

Boundary markers distinguish prefixes and suffixes.

The lookup input is converted with the same function.

Only lexicon ordinals present in matching trigram postings become candidates.

The candidate evidence map is bounded before expensive distance evaluation.

The list is sorted by shared-gram count and stable ordinal.

Only the first configured candidate budget proceeds.

This architecture prevents a typo lookup from becoming an O(all terms) fallback scan.

## Edit distance

v8 uses bounded Damerau-Levenshtein distance.

Adjacent transposition counts as one edit.

Insertion counts as one edit.

Deletion counts as one edit.

Substitution counts as one edit.

The implementation exits when a row minimum exceeds the configured budget.

A length delta above the configured budget exits before matrix work begins.

The public helper returns `maximumDistance + 1` for values outside the accepted budget.

Callers therefore do not need an unbounded exact distance.

## Synonym policy

Synonyms are curated data, not fuzzy guesses.

A synonym group can be bidirectional or canonical-only.

The default is bidirectional.

Each alias can carry an explicit weight.

Each group can carry an explicit weight.

Expansion ordering uses those weights deterministically.

Scope matching occurs before expansion.

An address-only synonym cannot silently rewrite a category query unless configured for that scope.

An `any` group can participate in every scope.

Expansion results are deduplicated by value.

Higher-weight duplicates win.

## Query grammar preservation

The grammar contract remains the v6 contract.

`+term` remains required.

`-term` remains excluded.

`field:term` remains field-scoped.

`"phrase"` remains a phrase.

Correction metadata records the original clause kind and field.

The rebuilt query includes the original grammar marker.

The rebuilt query is analyzed again.

Production tests assert the corrected analysis, not only the output string.

## Recovery selection

Recovery does not select the highest internal correction score.

It selects the search attempt that produces more actual search results.

This protects the system from high-confidence corrections that are lexically plausible but unhelpful for the current dataset.

A corrected attempt that returns no improvement is ignored.

A synonym attempt that returns no improvement is ignored.

The original result remains the fallback authority.

## Caching

v8 does not create a second response cache.

Every attempt runs through `DataSearchExecutionRegistryV7`.

Signal-free successful requests therefore use the existing revision-safe cache.

Requests containing an `AbortSignal` retain the v7 no-cache behavior.

Blocked results retain the v7 no-cache behavior.

Recovery diagnostics record whether each attempt was a cache hit.

## Sessions

`SearchRecoveryRuntimeV8.createSession()` delegates scheduling to the existing `SearchSession`.

Debounce behavior remains centralized.

Superseded requests remain cancellable.

Stale responses remain excluded by the existing session authority.

The session executor calls the same v8 recovery search used by direct requests.

No second timer loop is introduced.

No recurring polling loop is introduced.

## Observability

Snapshots contain counts only.

They contain dataset keys and deterministic fingerprints already used by search governance.

They do not contain bearer tokens.

They do not contain provider credentials.

They do not contain request bodies from external systems.

They do not create analytics or telemetry destinations.

Diagnostics are returned locally to the caller.

## Security

v8 performs no browser `fetch`.

v8 performs no XMLHttpRequest.

v8 performs no WebSocket connection.

v8 adds no endpoint constants.

v8 adds no WMS/WFS/WMTS path.

v8 adds no remote asset.

v8 adds no script injection path.

v8 adds no dynamic evaluation path.

v8 stores no client secret.

v8 stores no access token.

v8 adds no persistent user-profile storage.

## Performance budgets

Lexicon terms are bounded.

Gram postings are bounded.

Fuzzy candidates are bounded.

Suggestions are bounded.

Edit distance is bounded.

Length delta is bounded.

Synonym groups are bounded.

Aliases per group are bounded.

Expansion fan-out is bounded.

Expansion token count is bounded.

Automatic corrections per request are bounded.

Recovery attempts per request are bounded.

Dataset companion count is bounded by the same dataset-capacity policy used by the underlying registry.

Scale tests lock these invariants.

## Data-integrity implications

Fuzzy terms come only from accepted normalized records and explicit synonym configuration.

The fuzzy layer does not mutate the source dataset.

The fuzzy layer does not create synthetic search records.

A correction changes only the request variant.

The resulting hit is still a real record from the current dataset snapshot.

Result provenance therefore remains attached to the canonical normalized record.

## Migration guidance

Existing callers can keep using v7 unchanged.

Callers that want typo recovery instantiate `SearchRecoveryRuntimeV8`.

They register the same immutable `DatasetSnapshot` already supplied to v7-style execution.

They can then call `search()` or `searchResponse()`.

No endpoint changes are required.

No provider changes are required.

No schema migration is required solely for v8.

No GIS migration is required.

No icon migration is required.

## Recommended rollout

Start with recovery diagnostics visible in development tooling.

Keep default confidence thresholds.

Measure whether corrected attempts improve actual result counts.

Curate project-specific synonym groups only for stable domain vocabulary.

Do not lower edit-distance thresholds simply to increase match rate.

Do not turn excluded-term correction on without a product-specific reason.

Do not use synonym groups to encode authorization or visibility rules.

Search authorization remains outside this lexical recovery layer.

## Test strategy

`fuzzyLexiconV8.production.test.ts` covers edit distance, deterministic ranking and budget behavior.

`queryCorrectionV8.production.test.ts` covers grammar preservation, synonym scopes and confidence gates.

`searchRecoveryV8.production.test.ts` covers original-first execution, recovery selection, revision lifecycle and spatial safety.

`searchRecoveryScaleV8.production.test.ts` covers high-cardinality bounds and deterministic scale behavior.

Repository-wide exact-base TypeScript and Vitest remain authoritative before merge.

Release QA remains authoritative for static performance and security regressions.

Production Vite build and bundle budgets remain authoritative for shipping impact.

## Non-goals

v8 is not a spell-check UI.

v8 is not an LLM query rewriter.

v8 is not a remote language service.

v8 is not an address geocoder.

v8 is not a new relevance engine.

v8 is not a federated source runner.

v8 is not an authorization layer.

v8 is not a GIS service transport.

v8 is not an icon registry.

## Invariants summary

Primary search runs before recovery.

Successful primary search wins without rewrite.

Recovery never bypasses a blocked primary result.

Coordinate/spatial intent is protected from lexical rewrite.

Grammar semantics are preserved.

Ambiguous corrections are not auto-applied.

All expensive dimensions are bounded.

No broad lexicon scan exists in the lookup fallback path.

No new external network path exists.

No new persistent user tracking exists.

Dataset revision changes rebuild recovery state.

Existing v6/v7 authorities remain canonical.
