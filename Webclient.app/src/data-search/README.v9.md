# Data/Search v9 — usable search experience model

## Status

v9 is an additive, transport-free presentation and interaction layer over the already merged Data/Search authorities.

It does not replace the canonical normalizer, v6 relevance engine, v7 intent execution registry, or v8 recovery runtime.

It does not own React rendering, GIS navigation, network transport, geocoding provider configuration, analytics, or icons.

Its purpose is to make the search page predictable and usable by giving the UI one bounded typed model for query feedback, deterministic result explanations, safe text highlighting ranges, grouping, blocked/empty recovery guidance, keyboard-friendly selection state, recent-query memory and immutable page snapshots.

## Invariants

- Product search truth remains owned by v8/v7/v6.
- Presentation never changes ranking, filters, address hierarchy, spatial admission or dataset membership.
- Presentation never fabricates a result record.
- A blocked search stays blocked.
- Empty-state suggestions are explicit next actions, never automatic network calls.
- Selection is revision-bound so stale selections cannot silently target a replacement dataset.
- Highlight ranges are local, immutable and hard bounded.
- History is memory-only and contains sanitized query metadata rather than record payloads.
- Every collection exposed to a UI is bounded.
- No recurring timer or polling loop exists.

## Modules

### `searchResultPresentationRuntimeV9.ts`
Creates deterministic result cards, snippets, badges, match explanations and highlight ranges from canonical v8/v7 search results.

### `searchGroupingRuntimeV9.ts`
Groups result cards into bounded category, type, district or distance sections without changing order inside a section.

### `searchGuidanceRuntimeV9.ts`
Builds success, partial, empty and blocked guidance plus explicit request patches such as clearing filters, removing spatial constraints or using the corrected query.

### `searchSelectionRuntimeV9.ts`
Owns active and selected result identity, bounded keyboard movement and stale revision rejection without importing a UI framework.

### `searchHistoryRuntimeV9.ts`
Maintains bounded in-memory recent-query history and repeat-search suggestions. It stores no coordinates, credentials, record payloads, browser storage or telemetry.

### `searchExperienceRuntimeV9.ts`
Composes v8 execution with the presentation, grouping, guidance, selection and history authorities and exposes one immutable page model suitable for React or another UI layer.

## Safety

v9 performs no fetch/XMLHttpRequest/WebSocket/EventSource. It adds no endpoint constant, WMS/WFS/WMTS path, remote asset, storage API, analytics sink, unsafe HTML, dynamic code, credential handling or alternate icon authority.

## Performance

Every policy has hard maximums. Result cards, snippets, highlights, groups, guidance actions, selection keys and history records are bounded. Presentation work runs only over the result window already returned by the canonical search runtime.

## Accessibility handoff

v9 does not render DOM. It exposes stable result IDs, active position, set size, result count text, status severity and guidance/action labels so the UI can implement listbox/option, status/alert, keyboard navigation and live-region behavior without recomputing search semantics.

## Integration

Existing callers can keep using v8 directly. A page that wants the v9 model constructs `SearchExperienceRuntimeV9` with an existing `SearchRecoveryRuntimeV8`. The runtime returns a page model; the UI remains responsible for DOM, map focus, navigation and actual accessibility markup.
