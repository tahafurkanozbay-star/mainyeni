# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main`. This branch-scoped continuation record preserves the current Experience handoff without copying unrelated historical entries.

## Deep Experience / UI Quality — 2026-09-17 13:27 TRT
- TUR / GÖREV: current-main Experience continuation; command/navigation interaction shell strict-TypeScript modernization.
- BASE MAIN: `4b5a39106b22ab889547509e80075f722325a3f1` (GIS PR #90 merged immediately before this turn).
- BRANCH: `agent/experience-ui-20260917-1327-4b5a391`.
- HEAD before progress commit: `096628fd4a06ec0cf6a6ec0b9fcca1150a226377`.
- PR / MERGE DURUMU: OPEN / NOT MERGED. Mandatory Experience >=4,000 meaningful-additions gate is not met by this first slice; merge is forbidden regardless of CI.
- DİL / MİMARİ: legacy `ExperienceCommandCenter.js` implementation is replaced behind its compatibility import by strict `ExperienceCommandCenter.tsx`; React 19 + Vite 8 + TypeScript 7 remain the stable project stack rather than introducing a gratuitous framework rewrite.
- COMMAND CONTRACT: command discovery consumes canonical `EXPERIENCE_COMMANDS` and `searchExperienceCommands`; dispatch uses `createExperienceBus()` and typed `ExperienceCommandName` instead of a divergent UI registry.
- ERİŞİLEBİLİRLİK: instance-safe IDs, modal semantics, Escape, arrow navigation, Enter execution, bounded Tab focus trap, invoking-element focus restoration, active-descendant/listbox state and live result count.
- GERÇEK EKRAN: existing import path remains compatible. Window-backed search/basemap/identify/measurement/draw/bookmark commands retain current WindowManager targets while canonical command events remain available to map/runtime bridges.
- TEST / BUILD / CI: no PASS claimed yet. Exact-head GitHub Actions is mandatory; repository Webclient Quality is the authoritative verification source.
- NETWORK / GÜVENLİK: no endpoint, WMS/WFS, analytics, remote font/CDN, secret, token or unsafe HTML added. Window targets are static allowlisted mappings.
- İKON: GIS feature icon authority unchanged; command shell uses local deterministic SVG glyphs and adds no competing feature icon resolver.
- PERFORMANS: duplicate command registry/search path removed; no polling/timer/background work added.
- ÇÖZÜLEN HATALAR: static dialog ID collision risk; missing focus restoration; legacy `sketch` vs canonical `draw` command drift; duplicated command metadata drift.
- SONRAKİ: same canonical PR while current-base valid: managed-window lifecycle boundaries, query form/table surfaces, shared accessible form/table/toolbar/status primitives, Measurement integration, responsive/forced-colors/reduced-motion CSS and focused Vitest interaction regressions. Continue to >=4,000 meaningful additions; then exact-head completed+success CI, mergeable=true, second interaction review and final main refresh before squash merge.
