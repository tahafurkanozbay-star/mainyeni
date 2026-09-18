# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at the parent commit. This branch-scoped record summarizes the active Experience continuation without rewriting other teams' canonical history.

## Deep Experience / Whole-Code Modernization — active PR #110 summary
- BASE / BRANCH: original PR base `172581511c10401d49c3ad4ac98c45f383598df1`; branch `agent/experience-ui-20260917-2222-1725815` remains the canonical Experience continuation but is now stale against current `main` and MUST NOT receive substantive UX code until safely refreshed.
- RETAINED WORK: strict-TypeScript Experience form/status/table/query/pagination/toolbar primitives; responsive/reduced-motion/forced-colors styling; strict-TS `ParklarQueryWindow`; shared `ManagedWindowFocus` lifecycle; strict `ABBQueryWindow.tsx` launcher; Measurement managed-window/accessibility adoption.
- NETWORK / SECURITY / ICON: no WMS/WFS/WMTS UI, endpoint, CDN, analytics, remote font, secret or dependency introduced. Shared deterministic icon authority remains unchanged.

## Deep Experience / Whole-Code Modernization — 2026-09-18 09:25 TRT
- TUR / GÖREV: exact-head CI verification followed by real Measurement managed-window adoption and interaction/accessibility modernization.
- VERIFIED BASELINE: exact head `dd43ceedbe88fb3086e6538971b6292be83f5ada` completed Platform Architecture Audit, Webclient Quality and Release QA successfully. This is the green baseline before the new Measurement slice.
- MEASUREMENT FOCUS LIFECYCLE: `MeasurementWidget` now adopts `createManagedWindowFocusLifecycle()`. On show, focus is scheduled to the first enabled measurement tool; on close, pending focus is cancelled and non-modal focus ownership rules safely restore the opener only when appropriate; unmount disposes retained focus lifecycle state.
- MEASUREMENT ACCESSIBILITY: the managed surface is now a labelled section with description/status association, `aria-busy`, live status messaging, explicit labelled result region, decorative header icon semantics, native pressed-state tool buttons, visible text labels, and horizontal toolbar ArrowLeft/ArrowRight/Home/End keyboard navigation with wrapping.
- RESPONSIVE / VISUAL: legacy float/gray-only CSS was replaced with a two-column grid that collapses to one column on narrow screens, >=44px targets, visible focus, pressed/disabled states, reduced-motion handling and forced-colors support.
- PERFORMANCE / SECURITY: no new network call, dependency, external asset, timer loop, HTML string sink or analytics. Existing measurement controller remains the runtime authority and continues to own ArcGIS widget loading/cleanup.
- CI / BUILD: new commits require fresh exact-head GitHub Actions; do not infer PASS from the green `dd43ceed…` baseline. PR remains draft/open because the mandatory >=4,000 meaningful-additions gate is not met.
- SONRAKİ GÖREV: inspect fresh exact-head CI first. If green, add integration-level Measurement focus/keyboard regression coverage and continue substantive high-traffic query modernization (CityBlockParcel/Numbering/Transit/Vicinity) plus 2B↔3B interaction accessibility on this same PR. Merge only after >=4,000 meaningful additions, completed+success exact-head checks, mergeable=true and final current-main refresh.

## Deep Experience / Whole-Code Modernization — 2026-09-18 10:26 TRT
- TUR / GÖREV: mandatory current-main/PR/CI refresh before further Experience implementation.
- CURRENT MAIN: `main` advanced to `a9fb9ef8015ebd0f9356c3235c3d7c207131bdf3` after other role merges; PR #110 still targets historical base `172581511c10401d49c3ad4ac98c45f383598df1` and head `3255da9a6bdfb8e0bc2cdde161e6a11ab39e8e10` before this progress-only commit.
- DIVERGENCE: GitHub compare reports the Experience branch and current main are diverged; comparing branch -> main yields `ahead_by=6`, `behind_by=40`, merge-base remains `172581511c10401d49c3ad4ac98c45f383598df1`. PR reports `mergeable=false` and remains draft/open.
- GATE DECISION: no substantive UX/UI code was stacked on the stale branch. Repository lifecycle rules require a safe current-main refresh before further implementation; connector capabilities in this run expose branch ref movement but no merge/rebase/cherry-pick operation capable of preserving the existing 1,218-addition Experience history while integrating the 40 main commits. Force-moving the branch to main would discard Experience work and is therefore prohibited.
- CI: branch history contains successful workflow runs, but current stale PR head has no exact-head Actions run returned by the exact SHA query; no PASS/merge-ready inference is made.
- PR SCOPE: PR #110 remains 1,218 additions / 401 deletions / 19 files before this progress-only status commit, below the mandatory >=4,000 meaningful-additions gate; do not merge.
- SECURITY / NETWORK / PERFORMANCE: this turn changes progress documentation only; no runtime, endpoint, dependency, asset, WMS/WFS, analytics, icon resolver or render-path change.
- SONRAKİ GÖREV: first safely refresh the canonical Experience history onto then-current `main` without resetting the PR's meaningful-additions continuity or losing commits; immediately re-check merge-base/behind/mergeable and exact-head CI. Only then resume Measurement integration tests, high-traffic query modernization and 2B↔3B interaction accessibility.