# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at the parent commit. This branch-scoped continuation record summarizes the active GIS package while preserving prior history through Git.

## Deep GIS continuation — 2026-09-16 16:12 TRT
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; capability-aware bounded ArcGIS query/window composition.
- BASE MAIN: `3c6eaa8b35eca2da1219ddaab9f90d16a3255a79` (squash merge of prior GIS PR #66).
- BRANCH: `agent/gis-deep-20260916-1612-3c6eaa8`.
- PR: #70 `feat(gis): compose verified bounded ArcGIS feature windows`.
- HEAD before this progress commit: `c92ae0980838366be50e8ab0cab80b6cf7255e6d`.
- MERGE DURUMU: OPEN / NOT MERGED. Base...head before progress = 200 additions, 0 deletions, 2 files; mandatory 4,000 meaningful-addition gate is not met, so merge is forbidden.
- ÖNEMLİ ÖZELLİKLER: new strict TypeScript `arcgisFeatureWindowExecutor` composes existing verified metadata/query execution with bounded feature-window lifecycle; pagination must be explicitly advertised; stable object/global identity is mandatory; injected transport remains authoritative; page/feature budgets and AbortSignal cancellation are preserved; next offset advances by raw server feature count so client dedupe cannot stall pagination.
- DEĞİŞEN DOSYALAR: `Webclient.app/src/gis-engine/arcgisFeatureWindowExecutor.ts`, `arcgisFeatureWindowExecutor.test.ts`, this progress record.
- TESTLER / BUILD / CI: focused Vitest coverage added for multi-page execution including OBJECTID=0, unsupported-pagination and missing-stable-identity fail-closed behavior, maxFeatures truncation and pre-transport cancellation. Exact-head GitHub Actions must be inspected after this progress commit; no PASS is claimed yet.
- NETWORK DEĞİŞİKLİKLERİ: none. No direct fetch, new endpoint, WMS/WFS/WMTS, CDN, analytics or remote asset. Existing ArcGIS transport remains dependency-injected.
- GÜVENLİK / DATA INTEGRITY: capability and identity prerequisites fail closed; bounded page/feature counts prevent unbounded allocation; cancellation is propagated; stable identity is required on every returned feature; no secret/token handling added.
- İKON EŞLEŞTİRME: unchanged; existing shared `iconRegistry.json` resolver/presentation remains the sole authority.
- MODERNİZASYON KARARI: compose existing strict-TS metadata/query/window primitives instead of adding another transport or pagination stack.
- PERFORMANS ETKİSİ: bounded page size, page count and feature count cap memory/request growth; scheduler/cache/dedupe behavior of the existing query executor remains reusable; no polling/timer introduced.
- ÇÖZÜLEN HATALAR: closes the integration gap between verified ArcGIS query metadata and the bounded feature-window primitive; prevents accidental window execution on services without verified pagination/stable identity.
- KALAN SORUNLAR / SONRAKİ GÖREV: continue PR #70 on this branch while it remains based on current main. Add real high-priority GIS work toward >=4,000 meaningful additions: lifecycle/resource ownership, 2D/3D render-state parity, scene/LOD budgets, spatial utilities and regressions. Check exact-head CI, fix code-caused failures, run second verification plus performance/data-integrity/security review and final regression. Refresh main before eventual merge; never merge below 4,000 additions or with failing/pending CI.
