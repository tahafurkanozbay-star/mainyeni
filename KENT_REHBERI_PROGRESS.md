# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at the parent commit. This branch-scoped continuation record intentionally summarizes the current GIS turn to avoid duplicating a very large shared history while preserving the canonical parent.

## Deep GIS continuation — 2026-09-16 14:14 TRT
- TUR / GÖREV: Deep GIS / Whole-Code Modernization continuation; bounded ArcGIS feature data lifecycle and integrity.
- BASE MAIN: `c89ef2a5ab2fd1d633d10447c5db56f177811bed`.
- BRANCH: `agent/gis-deep-20260916-1414-c89ef2a`.
- PR: #66 `feat(gis): continue bounded ArcGIS data lifecycle modernization`.
- MERGE DURUMU: merged previously; historical entry retained.

## Deep Platform / Architecture — 2026-09-16 17:00 TRT
- TUR / GÖREV: Deep Platform / Whole-Code Modernization; current-main runtime supervision, bounded work coordination, toolchain and CI quality contracts.
- BASE MAIN: `3c6eaa8b35eca2da1219ddaab9f90d16a3255a79`.
- BRANCH: `agent/platform-runtime-supervision-20260916-1626-3c6eaa8-r2`.
- COMMIT / PR / MERGE DURUMU: PR #72 head `1e0b41d194cd9bea601b6123d60de4a764623aef`; 4,944 additions / 50 deletions / 30 files; squash merged successfully as `3660cc87bc51a09d94297d7d752dc4bc2bbaa1fe`.
- ÖNEMLİ ÖZELLİKLER: deterministic dependency DAG/lifecycle coordination; bounded health/readiness registry; global/per-lane request coordination; runtime supervisor composition; hard deadline enforcement; observer isolation; bounded diagnostics/event history.
- TESTLER / BUILD / CI: exact PR head GitHub Actions completed successfully for Platform Architecture Audit, Platform Backend Validation, Webclient Quality and Release QA.
- KALAN SORUNLAR / SONRAKİ GÖREV: preserve concurrent GIS/Data/Experience ownership and refresh main before each role continuation.

## Deep GIS continuation — 2026-09-16 17:10 TRT
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; verified ArcGIS feature-window composition plus bounded 2D/3D scene resource ownership.
- BASE MAIN: `2dd3ce93a4581959ce37bdca7ecc9c9920b8b9c0` (post-Platform progress main).
- BRANCH: `agent/gis-deep-20260916-1710-2dd3ce9`.
- COMMIT / PR / MERGE DURUMU: current branch commits through `2902206e959d5bf33ff5d089cbf6828a90f495e9`; previous GIS PR #70 is stale/non-mergeable after main advanced and must be superseded. New canonical PR is to be opened from this current-main branch. Mandatory 4,000 meaningful-additions gate is not yet met; merge forbidden.
- ÖNEMLİ ÖZELLİKLER: reapplied only the still-unmerged verified `arcgisFeatureWindowExecutor` onto current main; added strict TypeScript `sceneResourceBudget` for deterministic CPU/GPU/draw-call/feature/resource accounting across 2D/3D, per-layer bounds, duplicate ownership prevention, priority-aware admission, lower-priority eviction, device-budget shrink handling and deterministic release/clear lifecycle.
- DEĞİŞEN DOSYALAR: `arcgisFeatureWindowExecutor.ts`, `arcgisFeatureWindowExecutor.test.ts`, `sceneResourceBudget.ts`, `sceneResourceBudget.test.ts`, this progress record.
- TESTLER / BUILD / CI: focused Vitest regressions cover multi-page ArcGIS identity including OBJECTID=0, capability/stable-id fail-closed behavior, feature truncation and cancellation; scene tests cover CPU/GPU accounting, invalid estimates, duplicates, per-layer caps, priority eviction, equal/higher-priority preservation, layer release, budget shrink, critical-resource preservation and clear. Exact-head GitHub Actions must be checked after PR creation; no PASS is claimed before completed+success runs.
- NETWORK DEĞİŞİKLİKLERİ: none. No new endpoint, direct fetch, WMS/WFS/WMTS, CDN, analytics, telemetry, remote asset or dependency.
- GÜVENLİK KONTROLLERİ / DATA INTEGRITY: ArcGIS execution still requires verified query readiness, pagination capability and stable identity; injected transport ownership remains unchanged. Scene estimates fail closed; all budgets are bounded; duplicate IDs cannot double-count resource ownership; no secret/token introduced.
- İKON EŞLEŞTİRME: unchanged; existing `iconRegistry.json` and shared resolver/presentation remain the sole deterministic authority.
- MODERNİZASYON KARARLARI: compose existing strict ArcGIS executor/window primitives rather than duplicate transport; introduce renderer-agnostic scene admission accounting before binding budgets to concrete 2D/3D SDK adapters, keeping current technology stack intact.
- PERFORMANS ETKİSİ: explicit CPU/GPU/draw-call/feature/resource caps bound scene pressure; lower-priority prefetch can yield to interactive work; per-layer caps prevent one layer monopolizing memory; no polling/timers.
- ÇÖZÜLEN HATALAR: stale GIS branch is no longer used for new work; feature-window pagination advances by raw server count despite dedupe; scene ownership cannot be double-counted and can be released by layer.
- KALAN SORUNLAR / SONRAKİ GÖREV: continue same canonical current-main PR while it remains current: integrate scene budget with layer lifecycle/render-state policy, add LOD/frustum decision primitives, 2D/3D state parity and spatial utilities. Grow only with real GIS work to >=4,000 additions. Require exact-head lint/typecheck/test/build completed+success, second verification, performance/data-integrity/security review, final regression, fresh main/mergeability check before squash merge.
