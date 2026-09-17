# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at the parent commit. This branch-scoped continuation record preserves the active role checkpoints needed for safe continuation.

## Deep GIS continuation — 2026-09-16 14:14 TRT
- TUR / GÖREV: Deep GIS / Whole-Code Modernization continuation; bounded ArcGIS feature data lifecycle and integrity.
- BASE MAIN: `c89ef2a5ab2fd1d633d10447c5db56f177811bed`.
- BRANCH: `agent/gis-deep-20260916-1414-c89ef2a`; PR #66.
- MERGE DURUMU: historical open checkpoint; do not reuse without refreshing current main and PR state.
- ÖNEMLİ ÖZELLİKLER: strict TypeScript ArcGIS feature-window primitive, bounded pagination, cancellation, stable identity dedupe, transfer-limit evidence and non-progress detection.

## Deep Platform / Architecture — 2026-09-16 17:00 TRT
- TUR / GÖREV: Deep Platform / Whole-Code Modernization; runtime supervision, bounded work coordination, toolchain and CI quality contracts.
- BASE MAIN: `3c6eaa8b35eca2da1219ddaab9f90d16a3255a79`.
- PR #72: 4,944 additions / 50 deletions / 30 files; squash merged as `3660cc87bc51a09d94297d7d752dc4bc2bbaa1fe`.
- ÖNEMLİ ÖZELLİKLER: dependency DAG/lifecycle coordination, bounded health/readiness, request coordination, runtime supervisor, deadline enforcement, observer isolation, bounded diagnostics; Node 24/npm 11 and strict release/toolchain gates.

## Deep QA / Release — 2026-09-17 07:48 TRT
- TUR / GÖREV: Deep QA / Release / Regression / Whole-Code Modernization; exact CI diagnosis and dependency-free performance regression recovery.
- BASE MAIN: `2dd3ce93a4581959ce37bdca7ecc9c9920b8b9c0`; PR #75 remains canonical/open and was mergeable=true before this increment.
- BRANCH: `agent/deep-qa-release-20260916-1747-2dd3ce9`; PR #75.
- COMMIT / PR / MERGE DURUMU: exact head `d2bb737cde1a6ef17e3d96d3f23bd48e86cb787c` produced Release QA run `35179719343` completed+failure. Job logs prove the remaining failure was not the fixture extension expression: strict TypeScript failed with TS2307 because `performance-audit.test.mts` imported `vitest` while the typed QA job intentionally has no repository dependency install. Backend and webclient validation jobs were completed+success. Replaced the Vitest-only performance test harness with Node 24 built-in `node:test` + `node:assert/strict`, preserving substantive performance regression coverage without adding a package/runtime dependency. Current code head before this progress commit: `c90cc176b09892218bb089b732063be6386de85f`.
- ÖNEMLİ ÖZELLİKLER / ÇÖZÜLEN HATA: removed the hidden external test-runner dependency from typed release QA; retained byte/line budgets, JSON asset classification, lazy-load evidence, eager query/window threshold, nested-loop severity, iteration telemetry, memoization/virtualization evidence, QA self-exclusion, bounded largest-file diagnostics, deterministic ordering, custom budget metadata and repository-relative location regressions.
- DEĞİŞEN DOSYALAR: `quality/release/performance-audit.test.mts`, this progress record. A temporary compatibility shim was created during diagnosis and removed before the checkpoint; it is not part of the final tree.
- TESTLER / BUILD / CI: run `35179719343` proves backend restore/audit/build/xUnit/publish and webclient dependency/lockfile audit, lint, exact-base TypeScript/Vitest gates, native tooling, production build/integrity and budgets are green on the previous exact head. Typed QA failed only at TS2307 before tests. Fresh exact-head Release QA is mandatory; no PASS is claimed yet.
- NETWORK / GÜVENLİK / İKON: no runtime/network/icon behavior changed; no endpoint, secret, remote asset, analytics, WMS/WFS, dependency or privilege surface added.
- PERFORMANS ETKİSİ: application runtime unchanged; release tests now execute using Node's built-in runner and avoid an undeclared package dependency.
- KALAN SORUNLAR / SONRAKİ GÖREV: verify fresh exact-head Release QA. Fix any real strict-type/test/scorecard regression on this same PR. Once green, continue substantive QA/release modernization toward >=4,000 meaningful additions, prioritizing build-artifact integrity, security-header/response contracts, dependency/license risk, GIS 2D/3D release contracts and performance-budget depth. Before merge require exact-head completed+success CI, second verification, security/performance/regression review, current-main refresh, conflict-free mergeable=true and >=4,000 meaningful additions; otherwise keep PR open.
