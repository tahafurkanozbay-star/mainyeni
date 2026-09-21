# Kent Rehberi — Geliştirme İlerleme Kaydı

> Historical progress is preserved on `main`. This branch-scoped checkpoint records the current Platform continuation without claiming merge readiness.

## Deep Platform / Dependency resilience continuation — 2026-09-21 11:00 TRT
- TUR / GÖREV: Deep Platform / Whole-Code Modernization; bounded server-side dependency resilience primitive and focused regression coverage.
- BASE MAIN: `218cc4c8009fe0f1e4de9d41e5c1610e2c207b73` (verified current main at turn start).
- BRANCH: `agent/platform-whole-code-20260921-1100-218cc4c`.
- COMMIT / PR / MERGE DURUMU: implementation commits `134cdca71520dd8098383002041e3486cd2f0242` and `19bfe2063187d5989d53fcbb587711fe8ef06a24`; PR not opened yet; NOT MERGED. Mandatory >=4,000 meaningful-additions gate is not met, so merge is forbidden.
- ÖNEMLİ ÖZELLİKLER: reusable in-process `DependencyCircuitBreaker`; closed/open/half-open state machine; single half-open probe; configurable failure threshold/open interval; normalized dependency partitions; bounded dependency cardinality with overflow partition; opportunistic idle cleanup; aggregate snapshot counters; no timers or autonomous background work.
- DEĞİŞEN DOSYALAR: `Api.Core/Platform/Resilience/DependencyCircuitBreaker.cs`, `tests/Platform.Security.Tests/DependencyCircuitBreakerTests.cs`, this progress checkpoint.
- TESTLER / BUILD / CI: focused xUnit v3 regression coverage was added for success, threshold opening, rejection, half-open recovery/reopen, probe exclusivity, idempotent completion, unknown/normalized keys and cardinality bounds. Exact-head GitHub Actions has not been triggered because no PR exists yet; therefore no test/build PASS is claimed.
- NETWORK DEĞİŞİKLİKLERİ: none. The primitive performs no network I/O and adds no endpoint, WMS/WFS, telemetry, remote asset, browser transport or polling.
- GÜVENLİK KONTROLLERİ: dependency identifiers are normalized and length-bounded; snapshots expose aggregate operational facts only; state cardinality and cleanup are bounded; rejected work does not execute dependency calls.
- MODERNİZASYON KARARI: preserve current .NET 10 / C# 14 platform and add a composable resilience primitive rather than introduce a second HTTP stack or external resilience package without a measured need.
- PERFORMANS ETKİSİ: O(1) normal acquire/complete path with lock scope isolated per dependency; no timer allocation; bounded dictionary cardinality and opportunistic cleanup prevent unbounded state growth.
- İKON EŞLEŞTİRME: unchanged; shared GIS icon authority remains canonical.
- ÇÖZÜLEN HATALAR: platform now has a fail-fast dependency circuit state primitive that can prevent repeated calls into a known-failing server-side dependency while permitting a bounded recovery probe.
- KALAN SORUNLAR / SONRAKİ GÖREV: continue this same branch with real high-priority Platform/Architecture work until >=4,000 meaningful additions. Integrate resilience only at verified dependency boundaries, add configuration/validation/metrics as appropriate, preserve concurrent Experience/GIS ownership, then open the canonical PR and use exact-head Platform Backend Validation / Release QA plus required checks. Run first verification, fix real failures, second verification, security/performance/regression review and final main refresh before any merge.
