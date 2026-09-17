# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at the parent commit. This branch-scoped continuation record preserves the current Experience handoff without claiming unverified CI results.

## Deep Experience / UI Quality — 2026-09-17 21:26 TRT
- TUR / GÖREV: Current-main Deep Experience continuation; exact-base Vitest regression repair and managed-window accessibility lifecycle modernization.
- BASE MAIN: `8c6d672797b096c9b4ff821c8f45dda63c468a82`; refreshed and unchanged at turn start.
- BRANCH / PR: `agent/experience-ui-20260917-1627-8c6d672`, PR #107 `feat(experience): continue typed enterprise GIS UX modernization`.
- MERGE DURUMU: OPEN DRAFT / NOT MERGED. Pre-turn PR snapshot = 695 additions / 256 deletions / 13 files, mergeable=true. Mandatory >=4,000 meaningful additions gate remains unmet.
- CI / HATA DÜZELTME: exact head `6e68fb26612feaf7544550f46172a28134fabbdf` passed Platform Architecture Audit, strict changed-source lint, exact-base TypeScript regression, supervision TS and modern GIS TS. Webclient Quality/Release QA failed at exact-base Vitest regression only. Logs proved two branch-new failures, both in `ExperienceStatus.test.tsx`: native `<progress>` elements were queried by accessible name even though the visible label lives outside the element. Tests now assert native progress value/max semantics and separately verify the visible label; runtime component behavior was not weakened.
- MANAGED WINDOW UX: added strict TypeScript `LazyManagedWindow.tsx` while retaining a tiny JS compatibility re-export. The shared lazy-window boundary now captures the opener, focuses the first meaningful control when a window becomes visible, restores focus only to a still-connected opener on close, cancels stale animation-frame work, and applies id/ref/windowManager after caller props so consumers cannot escape lifecycle ownership.
- ACCESSIBILITY / RESPONSIVE: managed windows gain deterministic keyboard entry/return; reduced-motion loading fallback no longer spins continuously; forced-colors removes decorative shadow and preserves system colors. Existing status/form/table/toolbar/Measurement semantics remain intact.
- TEST / BUILD: fresh exact-head Actions is required after the Vitest and managed-window commits. No new-head build/Vitest PASS is claimed yet.
- NETWORK DEĞİŞİKLİKLERİ: none. No endpoint, WMS/WFS UI, remote font/CDN, analytics, telemetry or browser fetch added.
- GÜVENLİK KONTROLLERİ: no secret/token/unsafe HTML; managed component lifecycle invariants cannot be overridden through componentProps; focus restoration checks DOM connectivity before acting.
- İKON EŞLEŞTİRME: unchanged; shared deterministic GIS resolver remains authoritative.
- MODERNİZASYON KARARI: continue React 19 + Vite 8 + TypeScript 7 incrementally; migrate shared execution boundaries to TS behind compatibility re-exports instead of broad risky rewrites.
- PERFORMANS ETKİSİ: no polling/network/dependency additions; focus work is bounded to visibility transitions and one animation frame.
- ÇÖZÜLEN HATALAR: removed two branch-introduced exact-base Vitest failures caused by incorrect native progress assertions; managed-window opener/focus lifecycle is no longer implicit.
- KALAN SORUNLAR / SONRAKİ GÖREV: verify fresh exact-head Webclient Quality / Release QA / Architecture Audit and repair any real compiler/test/build regression. Continue the same PR while current with main with typed real query-window adoption, 2B↔3B interaction polish, dialog/window regression tests and further high-impact Experience work. Do not merge before >=4,000 meaningful additions, completed+success exact-head checks, mergeable=true and final responsive/accessibility/release review.
