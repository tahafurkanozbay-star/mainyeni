# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at the parent commit. This branch-scoped record summarizes the active Experience continuation without rewriting other teams' canonical history.

## Deep Experience / Whole-Code Modernization — 2026-09-18 00:25 TRT
- TUR / GÖREV: UI/UX + Visual Quality continuation on current main; strict-TypeScript enterprise query/form/table foundation and keyboard interaction guardrails.
- BASE MAIN: `172581511c10401d49c3ad4ac98c45f383598df1`.
- BRANCH / PR: `agent/experience-ui-20260917-2222-1725815`, PR #110 `feat(experience): rebuild typed enterprise UX on current main`.
- VERIFIED START HEAD: `a935f48af31a1d8336f9481826dd844debd27956`; GitHub reported PR mergeable=true, draft/open, 379 additions / 112 deletions / 9 files before this turn. Mandatory 4,000 meaningful-additions gate is not met; DO NOT MERGE.
- CI BASELINE: exact head `a935f48...` completed Platform Architecture Audit, Webclient Quality and Release QA successfully. This turn adds new commits, therefore that green result is only a baseline and no PASS is claimed for the new head until fresh exact-head workflows complete.
- ÖNEMLİ ÖZELLİKLER: retained strict-TS accessible form/status/pagination/table/query primitives; added reusable `ExperienceToolbar` with semantic toolbar role/orientation, first-enabled tab stop, disabled-item skipping, wrapping arrow-key navigation and deterministic Home/End focus movement.
- ACCESSIBILITY / RESPONSIVE: toolbar controls inherit >=44px touch targets and visible focus; horizontal/vertical keyboard models are explicit; forced-colors border treatment and mobile spacing are included. Existing query primitives retain semantic nav/table/search/form structures, `aria-current`, `aria-busy`, live status, keyboard row activation, mobile table reflow and reduced-motion animation suppression.
- TESTLER / BUILD / CI: added focused Testing Library/Vitest coverage for disabled-first tab stop, arrow wrapping, Home/End and vertical orientation. Fresh exact-head CI must validate strict lint, TypeScript, tests and production build; do not infer success from the previous green head.
- NETWORK DEĞİŞİKLİKLERİ: none. No endpoint, WMS/WFS/WMTS, CDN, analytics, remote font, secret or dependency added.
- GÜVENLİK / İKON: no unsafe HTML, direct browser data transport or new icon authority added. Shared deterministic icon resolver remains untouched and authoritative.
- MODERNİZASYON KARARI: continue React 19 + Vite 8 + TypeScript 7 rather than replacing the framework; establish reusable strict-TS interaction primitives and adopt them screen-by-screen instead of risky whole-app rewrite.
- PERFORMANS ETKİSİ: toolbar uses local DOM focus traversal only on keyboard interaction; no polling, timers, remote work or unbounded collection is introduced. Pagination remains bounded and table/query primitives remain transport-free.
- ÇÖZÜLEN HATALAR: shared toolbars no longer need ad-hoc tab order/arrow-key implementations; disabled-first toolbars receive a valid keyboard entry point and focus navigation wraps predictably.
- KALAN SORUNLAR / SONRAKİ GÖREV: inspect fresh exact-head CI and fix any real lint/typecheck/test/build regression first. If main remains exactly `1725815...`, continue this same canonical PR with real query-window adoption, managed-window focus lifecycle, Measurement and 2B↔3B interaction polish, dialog/disclosure regressions and broader responsive/forced-colors review until >=4,000 meaningful additions. If main advances or branch diverges, follow lifecycle rules and do not stack new work on stale history.
