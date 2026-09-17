# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at parent commit `002832687974ed3bf759bd5a61c8e4e634ab0596`. This branch-scoped continuation record preserves the canonical parent while recording the active Experience turn.

## Deep Experience / UI Quality — 2026-09-17 15:27 TRT
- TUR / GÖREV: Current-main Experience continuation; strict TypeScript query interaction foundation and managed-window lifecycle.
- BASE MAIN: `002832687974ed3bf759bd5a61c8e4e634ab0596`.
- BRANCH: `agent/experience-ui-20260917-1527-0028326`.
- HEAD before this progress commit: `2a03837e4ae1f386bf946da03c5c798c0e06750e`.
- MERGE DURUMU: NOT MERGED. Mandatory 4,000 meaningful-additions Experience gate is not met; exact-head CI is also required before merge.
- ÖNEMLİ ÖZELLİKLER: recovered only still-missing validated Experience work onto fresh current main; added typed query surface composition, accessible active-filter/search bar, bounded pagination, strict managed lazy-window lifecycle, and a typed lazy query registry with explicit preload/error-cache behavior. Superseded JS managed-window and query-registry implementations are removed on this branch.
- ERİŞİLEBİLİRLİK: query surfaces expose labelled regions and busy state; search controls have explicit labels/clear actions; pagination uses nav/current-page semantics; lazy loading exposes polite status and labelled busy state. Existing shared primitives continue to provide focus-visible, forced-colors and reduced-motion behavior.
- DİL / MODERNİZASYON: React 19 + Vite 8 + strict TypeScript 7 remains the correct current stack; no framework churn. Legacy JS boundaries are migrated incrementally instead of a risky whole-app rewrite.
- NETWORK / SECURITY: no endpoint, WMS/WFS, CDN, analytics, remote font, secret, direct browser fetch or new dependency added. Query registry only changes UI module loading contracts.
- İKON EŞLEŞTİRME: unchanged; deterministic shared icon authority remains canonical.
- TEST / BUILD / CI: no PASS claimed yet. GitHub-native development environment has not executed local Node commands; exact-head GitHub Actions must be inspected after PR creation and real failures fixed on the same canonical PR.
- PERFORMANS: lazy window modules remain code-split; preload promises are deduplicated and failed loads are evicted from cache for retry. No polling/timer introduced.
- KALAN SORUNLAR / SONRAKİ GÖREV: continue this same canonical Experience PR until >=4,000 meaningful additions with real high-priority work: full query-window registry coverage, real query screen adoption, managed-window focus lifecycle, Measurement typed UI integration, 2D↔3D control affordances, responsive/forced-colors/reduced-motion refinements, and interaction/accessibility regression coverage. Refresh main before every new write; if branch becomes behind/diverged, follow lifecycle rules and reapply only missing validated work to a fresh current-main branch. Merge only with additions>=4000, exact-head required checks completed+success, mergeable=true and final UX/release regression review clean.
