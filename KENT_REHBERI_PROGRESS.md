# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at the parent commit. This branch-scoped continuation record intentionally summarizes the current GIS turn to avoid duplicating a very large shared history while preserving the canonical parent.

## Deep GIS continuation — 2026-09-16 14:14 TRT
- TUR / GÖREV: Deep GIS / Whole-Code Modernization continuation; bounded ArcGIS feature data lifecycle and integrity.
- BASE MAIN: `c89ef2a5ab2fd1d633d10447c5db56f177811bed`.
- BRANCH: `agent/gis-deep-20260916-1414-c89ef2a`.
- PR: #66 `feat(gis): continue bounded ArcGIS data lifecycle modernization`.
- HEAD before this progress commit: `cc845269ef4ecb2928800136474a828a3e007d46`.
- MERGE DURUMU: OPEN / NOT MERGED. Base...head before progress = 146 additions, 0 deletions, 2 files; mandatory 4,000 meaningful-additions gate is not met, so merge is forbidden.
- ÖNEMLİ ÖZELLİKLER: strict TypeScript `arcgisFeatureWindow` primitive; verified transport stays injected; page/feature memory bounds; AbortSignal cancellation; stable identity dedupe preserving numeric id 0; explicit transfer-limit completion/truncation evidence; fail-closed non-progressing pagination detection.
- DEĞİŞEN DOSYALAR: `Webclient.app/src/gis-engine/arcgisFeatureWindow.ts`, `arcgisFeatureWindow.test.ts`, this progress record.
- TESTLER / BUILD / CI: focused Vitest coverage was added for dedupe/id=0, progress failure, budgets, invalid configuration and cancellation. No GitHub Actions workflow run was yet associated with exact head `cc845269...`; therefore no test/lint/typecheck/build PASS is claimed. Exact-head CI remains mandatory before eventual merge.
- NETWORK DEĞİŞİKLİKLERİ: none. No direct fetch, new endpoint, WMS/WFS/WMTS, CDN, analytics or remote asset.
- GÜVENLİK / DATA INTEGRITY: bounded allocation, cancellation, duplicate suppression and pagination progress checks reduce runaway memory/loop and inconsistent feature-window risk; capability/transport facts are not guessed.
- İKON EŞLEŞTİRME: unchanged; `iconRegistry.json` + shared resolver/presentation remains the single authority.
- MODERNİZASYON KARARI: add a small composable strict-TS primitive on the current React 19/Vite 8/TS7 main rather than fork query transport or duplicate existing ArcGIS query executors.
- PERFORMANS ETKİSİ: explicit maxFeatures/maxPages bounds and identity dedupe cap client memory growth and redundant downstream rendering; no new polling/timers.
- ÇÖZÜLEN HATALAR: feature-window consumers now have a reusable fail-closed guard against repeated/non-advancing ArcGIS pages and duplicate stable identities.
- KALAN SORUNLAR / SONRAKİ GÖREV: continue on PR #66 until >=4,000 meaningful additions with high-priority GIS work: capability-aware query/window composition, lifecycle/resource ownership, 2D/3D render-state parity, scene/LOD budgets, spatial utilities and targeted regressions. Refresh current main before adding work; if this branch becomes behind/diverged, follow branch lifecycle rules instead of force-updating. Run exact-head required CI, fix real failures, run second verification, performance/data-integrity/security review and final regression before any merge.

## Deep Experience continuation — 2026-09-16 16:24 TRT
- TUR / GÖREV: Deep Experience / Whole-Code Modernization; responsive and accessible legacy GIS surface modernization.
- BASE MAIN: `3c6eaa8b35eca2da1219ddaab9f90d16a3255a79` (PR #66 GIS squash merge already present).
- BRANCH: `agent/experience-ui-20260916-1624-3c6eaa8`.
- HEAD before this progress commit: `8974cf3c1295352ffab5b218fda77ad0d731e45d`.
- PR / MERGE DURUMU: PR to be opened after this progress commit; NOT MERGED. Mandatory Experience 4,000 meaningful-additions gate is not met, so merge is forbidden.
- ÖNEMLİ ÖZELLİKLER: added an incremental post-legacy experience CSS layer with system-local typography tokens, consistent surface/control/focus tokens, 44px control targets, keyboard-visible focus restoration, query-window responsive bounds, focus-within menu/result behavior, narrow-screen GIS panels, safe-area handling, reduced-motion and forced-colors contracts.
- GERÇEK EKRANLARA UYGULAMA: existing query windows, form buttons/checkboxes/radios, result lists, dropdown/context menus, popups, attachment sliders, overview map, modal and fixed branding surfaces receive the modernization layer without rewriting functional GIS components.
- DEĞİŞEN DOSYALAR: `Webclient.app/src/experience/experience-modernization.css`, `Webclient.app/src/main.tsx`, this progress record.
- TESTLER / BUILD / CI: no PASS is claimed yet. Exact PR-head GitHub Actions / Webclient Quality is authoritative and must complete before eventual merge; visual/interaction regression review remains required.
- NETWORK DEĞİŞİKLİKLERİ: the new modernization layer adds no endpoint, dependency, analytics, CDN, remote asset or font request. Legacy `styles.css` still contains the pre-existing Google Fonts Mukta import; removal remains queued because safe replacement requires a complete-file update rather than a truncated partial overwrite.
- GÜVENLİK / ACCESSIBILITY: no unsafe HTML or client secret added. Keyboard focus is no longer intentionally erased by the legacy `.btn:focus-visible` override after cascade; forced-colors retains boundaries/focus; reduced-motion collapses animation/transition duration; copyable result/popup content restores text selection.
- İKON EŞLEŞTİRME: unchanged; no second resolver or icon mapping path added.
- MODERNİZASYON KARARI: use a deterministic CSS compatibility layer loaded after legacy CSS so high-value screens can modernize incrementally while avoiding a high-risk monolithic legacy stylesheet rewrite. Local/system font stack is preferred for the new layer.
- PERFORMANS ETKİSİ: no JS runtime, polling, timer or asset added; CSS transitions are bounded and disabled under reduced-motion. No new network request is introduced.
- ÇÖZÜLEN HATALAR: legacy Bootstrap focus override no longer removes keyboard focus indication after cascade; hover-only dropdown disclosure gains `:focus-within`; fixed 400px query minimum is bounded on narrow viewports; modal/query/context surfaces gain viewport-safe constraints.
- KALAN SORUNLAR / SONRAKİ GÖREV: continue on the same Experience PR until >=4,000 meaningful additions. Priorities: migrate semantic interactive controls in real React screens, centralize panel/action primitives, remove the legacy remote Mukta import safely, improve table/form error semantics and 2D↔3D control accessibility, add focused regression/quality guards, run exact-head CI, fix failures, perform second visual/interaction review, and only merge when additions/CI/mergeability/risk gates all pass.
