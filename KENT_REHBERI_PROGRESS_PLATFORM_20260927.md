# Kent Rehberi — Deep Platform current checkpoint — 2026-09-27

- TUR / GÖREV: Deep Platform / Whole-Code Modernization; dependency containment, TKGM outbound reliability, cancellation and bounded administrative caching.
- BRANCH / PR: `codex/platform-modernization-20260926`, PR #346 (draft/open).
- BASE / MERGE-BASE: current `main` `d8f7adc3a105bc7466f27413262ff6259b25fbb0`; PR reports the same base and remains mergeable.
- LAST FULLY VALIDATED HEAD: `2ea73790443758cc5d4a0926fb45b72406213433`; Platform Backend Validation run 36284243111, Release QA run 36284243142 and Platform Architecture Audit run 36284243194 all completed+success.
- CURRENT PRODUCT HEAD BEFORE CHECKPOINT: `5b5e04f4ab2d826797fa89323179a65d3a52b513`.
- CURRENT SLICE: TKGM district/neighbourhood caches retain the existing 15-minute TTL and 512-entry bound but no longer clear the entire hot set on one overflow admission. Admission first removes expired/future-dated entries, then deterministically evicts the oldest entry with key tie-breaking under concurrent mutation.
- CHARACTERIZATION: `TkgmCacheCapacityTests` covers oldest-only eviction, expiry pruning before capacity pressure, independent neighbourhood capacity and preservation of parcel non-caching behavior.
- PERFORMANCE: overflow changes from O(N) destructive clear plus potential N upstream refetches to deterministic oldest-entry eviction; expiry pruning is bounded by the fixed 512-entry administrative cache capacity.
- SECURITY / NETWORK: no new endpoint, WMS/WFS/WMTS path, browser transport, telemetry, secret, remote asset or retry behavior. Existing TKGM GET endpoint, 10-second transport timeout and request cancellation remain unchanged.
- DATA INTEGRITY: cache admission rejects empty administrative payloads, invalidates future-dated/expired entries and preserves deterministic per-key values. Parcel responses remain deliberately uncached because no authoritative invalidation signal exists.
- MERGE DURUMU: do not merge. The PR remains below the mandatory 4,000 meaningful-additions gate and the new exact head requires fresh CI.
- SONRAKİ GÖREV: first inspect exact-head CI for this capacity slice and fix any build/test failure. Then continue high-impact Platform work on the same canonical PR, prioritizing request-to-data cancellation, outbound resilience and backend composition boundaries without speculative package migration.
- PROGRESS CONSOLIDATION NOTE: canonical `KENT_REHBERI_PROGRESS.md` is read at each turn but the GitHub connector returns its very large shared body truncated. It is not blindly overwritten because doing so would destroy concurrent teams' records. This role-scoped checkpoint preserves the required handoff until a full-content-safe canonical append path is available.
