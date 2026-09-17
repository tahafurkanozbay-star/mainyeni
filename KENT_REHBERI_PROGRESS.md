# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at the parent commit. This branch-scoped continuation record intentionally summarizes the current Platform turn while preserving the canonical parent history.

## Deep Platform / Architecture — 2026-09-18 02:00 TRT
- TUR / GÖREV: Deep Platform / Whole-Code Modernization continuation; green exact-head verification followed by adaptive runtime pressure/capacity control.
- BASE MAIN: `172581511c10401d49c3ad4ac98c45f383598df1`.
- BRANCH / PR: `agent/platform-adaptive-runtime-20260917-2301-1725815`, PR #112 `feat(platform): rebuild adaptive runtime control plane on current main`.
- PREVIOUS VERIFIED HEAD: `94a7886fb19930d6136a93292c419dbf38ae6884`; Platform Architecture Audit, Webclient Quality and Release QA all completed+success for that exact head. PR was mergeable=true but only 315 additions, so it correctly remained draft/unmerged.
- NEW WORK: added strict-TypeScript `pressureController.ts` and runtime barrel export. The controller combines bounded queue depth, p95 latency, failure rate, frame pacing and existing resource-budget pressure into a normalized score; applies nominal/elevated/high/critical states; uses recovery hysteresis to avoid capacity oscillation; and derives constrained network/CPU/queue/2D/3D/GPU/background budgets from the existing RuntimeBudget contract instead of creating a competing budget model.
- BOUNDS / LIFECYCLE: decision history is capped, recovery requires consecutive low-pressure samples, capacity floors prevent zero-progress starvation, and reset is deterministic. No polling/background timer is introduced; callers explicitly feed observations.
- NETWORK / SECURITY: no endpoint, WMS/WFS/WMTS, CDN, analytics, remote telemetry transport, direct browser data fetch, secret or token was added. Existing same-origin and bounded runtime policies remain authoritative.
- PERFORMANCE: adaptive budgets reduce expensive work admission during sustained queue/latency/failure/frame/resource pressure while preserving nominal capacity under healthy conditions. Hysteresis reduces thrashing during transient recovery.
- MODERNIZATION: retain React 19 + Vite 8 + TypeScript 7 and compose with existing resourceBudget/runtime supervision. Deprecated FontAwesome/esri-loader/crypto-js cleanup remains a staged compatibility backlog rather than a blind package bump.
- MERGE DURUMU: NOT MERGED. The new head requires a fresh exact-head CI cycle and the PR remains far below the mandatory 4,000 meaningful-additions gate.
- SONRAKİ GÖREV: inspect exact-head CI for the pressure controller, fix any real strict-lint/typecheck/Vitest/build/release failure, then add focused pressure-controller regressions and integrate the controller with admission/resource lifecycle without polling. Continue meaningful Platform work on this same canonical PR while current main/merge-base remains exact; if it becomes behind/diverged, follow branch lifecycle rules. Merge only after >=4,000 additions, all exact-head required checks completed+success, mergeable=true, security/performance/regression review and final current-main refresh.
