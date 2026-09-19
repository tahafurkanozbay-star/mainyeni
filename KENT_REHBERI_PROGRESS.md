# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` and prior GIS PR history. This current-main branch record is intentionally compact so concurrent roles do not duplicate a large shared log.

## Deep GIS / Whole-Code Modernization — 2026-09-19 05:13 TRT
- TUR / GÖREV: stale GIS PR #169 içeriğini güncel `main` üzerine güvenli biçimde yeniden kurma; platform #170 değişikliklerini koruma; exact-head CI doğrulamasını yeniden başlatma.
- BASE MAIN: `7364dfcc571d47d191a0b3e224dd9579daae8b24` (`feat(platform): current-main typed guardrails and language ratchet (#170)`).
- BRANCH / PR: `agent/gis-engine-current-main-20260919`, PR #171 `feat(gis): current-main deep GIS runtime modernization`.
- HEAD before this progress commit: `73cccfae0cf3ac415726a531223e3fe603da99af`.
- PR SNAPSHOT: 4,457 additions / 153 deletions / 20 files; mandatory >=4,000 meaningful-additions gate is satisfied. PR remains DRAFT / OPEN / NOT MERGED.
- LIFECYCLE: #169 head `3d04359fc26efb9e01ce7d3dcada8a2087bc7668` was based on pre-#170 main. No new GIS work was stacked onto that stale branch. A new commit/tree was constructed from current main while replacing only `Webclient.app/src/gis-engine`, so merged `Webclient.app/src/platform` guardrails from #170 remain intact.
- GIS KAPSAMI: bounded SceneLayer lifecycle/resource admission; spatial cache/request dedupe and subscriber cancellation; geometry/reference integrity; deterministic spatial extent/index primitives; query governance and canonical query keys; LOD/GPU/CPU/draw-call budgets; terrain streaming pressure controls; focused Vitest regressions.
- NETWORK / SERVİS: no new endpoint, WMS/WFS/WMTS, invented ArcGIS REST service, telemetry transport or remote asset introduced by this recovery.
- İKON STANDARDI: unchanged; existing deterministic shared icon resolver remains authoritative.
- PERFORMANCE / DATA INTEGRITY / SECURITY: bounded CPU/GPU/memory/feature/draw-call allocations, request concurrency, cache cardinality/bytes/TTL, metadata lengths, cancellation and deterministic eviction remain explicit. Current-main platform guardrails are preserved rather than overwritten.
- CI DURUMU: exact-head checks for the new PR have not completed yet; no lint/typecheck/test/build PASS is claimed. Previous #169 failure evidence remains historical only and cannot authorize merge of #171.
- MERGE DURUMU: merge forbidden until #171 exact-head required checks are completed+success, mergeable/conflict-free state is verified, second verification plus performance/data-integrity/security review and final regression are complete.
- SONRAKİ GÖREV: inspect #171 exact-head Webclient Quality / Release QA diagnostics. If the prior `sceneLayerLifecycleRuntime.test.ts` Vitest worker crash or JSX-in-.js dependency scan issue reproduces on current main, fix the real current-head cause on this canonical branch; rerun CI and only squash merge when every gate is green. Do not merge stale #169.

## Deep GIS / CI failure isolation — 2026-09-19 07:15 TRT
- TUR / GÖREV: canonical PR #171 exact-head CI gate revalidation and failure isolation before any code-level corrective change.
- BASE MAIN / LIFECYCLE: current `main` remains `7364dfcc571d47d191a0b3e224dd9579daae8b24`; PR #171 base SHA matches current main, `mergeable=true`, draft/open, so the branch is still canonical and no rebase/recovery branch is required.
- PR SNAPSHOT: head before this progress commit `ecbb3ee739d953a44261f0f80a29be0f8724dce6`; 4,473 additions / 497 deletions / 21 files. The >=4,000 meaningful-additions gate remains satisfied.
- CI DOĞRULAMA: exact-head GitHub Actions attempt 2 completed with Platform Architecture Audit=success, Webclient Quality=failure, Release QA=failure. Webclient Quality passes dependency/lockfile, experience guard, Vite migration, production dependency audit, full lint, strict changed-source lint, full TypeScript diagnostics, strict supervision TS, strict modern GIS TS and exact-base TypeScript regression. The sole failing step is `Full Vitest diagnostic visibility`; downstream exact-base Vitest/native tooling/build/budget steps are skipped, therefore no build PASS is claimed.
- DIAGNOSTIC SINIRI: GitHub jobs API exposes the failing step but the workflow publishes no artifacts for run `35415152267`; connector-readable job metadata does not include stderr. The SceneLayer lifecycle test was re-read and no speculative mutation was made without exact failure evidence. Blindly weakening tests or removing lifecycle assertions would violate regression/data-integrity policy.
- PERFORMANCE / DATA INTEGRITY / SECURITY REVIEW: current GIS delta remains bounded in concurrency, CPU/GPU/feature/draw-call budgets, cache cardinality/TTL, cancellation, deterministic eviction and teardown. No endpoint, WMS/WFS, secret, telemetry or remote dependency was added in this CI-isolation turn; shared deterministic icon resolver remains unchanged.
- MERGE DURUMU: NOT MERGED. Exact-head required CI is red, final Vitest/build regression has not executed, and PR remains draft. Squash merge is forbidden despite additions>=4000 and mergeable=true.
- SONRAKİ GÖREV: obtain actionable Vitest stderr through a connector-readable diagnostic path or a subsequent CI run, isolate the failing test/process condition, make the smallest real fix on PR #171, then run second exact-head verification and final build/performance/data-integrity/security regression before merge.
