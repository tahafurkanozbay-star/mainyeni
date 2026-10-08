# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Bu checkpoint öncesindeki tam canonical progress sürümü [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261005_PRE_PR459.md`](./KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261005_PRE_PR459.md) içinde aynı Git blob SHA ile kayıpsız korunur; önceki archive zinciri de o dosyadan erişilebilir.

## Deep Platform / governed browser runtime coordination — PR #459 merge-gate checkpoint — 2026-10-05
- TUR / GÖREV: Deep Platform / Whole-Code Modernization; browser tarafındaki pahalı runtime work için deadline, admission, fairness, load-shed, backpressure ve coordinator authority'lerini payload-free, bounded, deterministic ve strict-TypeScript hale getirme.
- BRANCH / PR: `agent/platform-deadline-20261004-0058-effa693`; PR #459 kanonik Platform PR'ıdır. Safety backup branch `agent/platform-deadline-20261004-0058-effa693-safety-backup` yalnız pre-reconciliation head'i korur ve merge kaynağı değildir.
- CURRENT MAIN / LINEAGE: current main/base/merge-base `a6e1be0cfa1131dc7d327ebec2bb0a23a4e6c4dd`; gate product head `1d3ea9041618a47b4f2f5fd69d347bc5ba343065` current main'e göre 46 ahead / 0 behind. Main'in son iki commit'i aynı tree'yi koruyan noop-cleanup lineage değişiklikleriydi; Platform tree iki-parent, force kullanılmayan reconciliation ile kayıpsız current-main lineage'a taşındı.
- KAPSAM / GATE: gate product head'de 15 Platform/CI dosyası, 4,236 meaningful additions / 52 deletions. Mandatory >=4,000 additions gate gerçek governor/coordinator implementasyonları, focused/adversarial regression testleri ve CI ownership hardening ile karşılandı; boilerplate veya satır doldurma kullanılmadı.
- PLATFORM MODERNİZASYONU: `RuntimeDeadlineGovernor`, `RuntimeLoadShedGovernor`, `RuntimeAdmissionGovernor`, `RuntimeFairnessGovernor`, `RuntimeBackpressureGovernor` ve `RuntimeWorkCoordinator` eklendi. Scope/cardinality, queue/inflight, deadline/lease, weighted fairness, critical reserve, recovery, clock rollback/skew, stale ticket, generation ve teardown davranışları explicit policy sınırlarıyla yönetiliyor; authority state yalnız scalar scheduling metadata tutuyor ve caller payload'ı retain etmiyor.
- LIFECYCLE REPAIR: exact-base Vitest iki yeni disposal regression'ını `RuntimeBackpressureGovernor.snapshot()` davranışına izole etti. Snapshot artık dispose sonrası pasif terminal observation döndürüyor (`disposed=true`, sıfır retained state); mutating API'ler terminal/fail-closed kalıyor. Direct regression testleri idempotent dispose, zero retained state, frozen snapshot ve mutation rejection sözleşmesini kilitliyor.
- SECURITY / PRIVACY: yeni endpoint, browser transport, telemetry sink, secret, remote asset, WMS/WFS/WMTS veya ikinci icon authority eklenmedi. Production npm audit 0 vulnerability; changed-source strict lint/typecheck ve Platform language/boundary ratchet'leri success. Authority'ler URL/query/token/credential/SDK payload graph saklamıyor.
- PERFORMANCE: fairness hard caps <=128 scope, <=256 global ticket ve <=32 ticket/scope; load-shed <=128 scope ve <=12 sample/scope. Release scorecard'daki nested-loop medium bulguları bu explicit küçük üst sınırlar içinde; review'da unbounded O(n²) hot-path bulunmadı. Backpressure/admission/deadline yapıları da bounded cardinality ve deterministic cleanup uygular.
- CI GATE PRODUCT HEAD: exact head `1d3ea9041618a47b4f2f5fd69d347bc5ba343065` için Typed Source Boundary `37294390358`, Platform Architecture Audit `37294390287`, Platform Typed Test Validation `37294390348`, Platform Governance Validation `37294390209`, Release QA `37294390264` ve Webclient Quality `37294390191` tamamı `completed+success`. Webclient exact-base TypeScript/Vitest regression gate, native tooling, Vite production build/integrity ve bundle budgets success; Release QA backend restore/audit/build/xUnit/User+Admin publish ve typed exact-base release gate success.
- REVIEW / MERGEABILITY: PR product head'de `mergeable=true`; top-level comment, submitted review ve inline review thread sayısı 0. Release-blocking kritik security/performance/regression riski tespit edilmedi.
- MERGE DURUMU: bu progress/archive commit'i yeni exact head oluşturacağı için product-head PASS tek başına final merge izni değildir. Yeni progress exact head üzerinde aynı zorunlu workflow'lar `completed+success`, current main fresh/behind=0, additions>=4,000, mergeable=true ve review/thread temizliği korunmadan merge yapılmaz.
- SONRAKİ GÖREV NOTU: progress exact-head CI'ını doğrula; current main SHA/merge-base'i tekrar refresh et. Tüm gate'ler korunuyorsa PR #459'u draft'tan ready durumuna getir ve expected-head kilitli squash merge yap. Merge SHA ile yeni main SHA'yı doğrula. Sonraki Platform turunda current-main fresh branch üzerinden deprecated FontAwesome 5 zinciri ve bakım dışı CryptoJS gibi baseline dependency adaylarını kullanım kanıtına göre kontrollü modernize et; kör package rewrite yapma.

## Deep Experience / notification triage modernization — PR #470 merge-gate checkpoint — 2026-10-05
- TUR / GÖREV: Deep Experience / Whole-Code Modernization; bildirim keşfi, hızlı inceleme, triage state/controller/window, observer güvenilirliği ve responsive accessibility authority'sini kurumsal GIS shell'ine entegre etme.
- BRANCH / PR: `agent/experience-notification-command-20261005-1122-456f05b`; PR #470 kanonik Experience PR'ıdır ve final exact-head gate tamamlanana kadar draft kalır.
- CURRENT MAIN / LINEAGE: current main/base/merge-base `07d197bc0a2f7bab00baea7f8301acecc44ff3e0`; product head `0492fe20c19f461216884eaad3b5041b3946f821` current main'e göre 41 ahead / 0 behind ve PR `mergeable=true`.
- KAPSAM / GATE: product head'de 21 dosya, 4,550 meaningful additions / 3 deletions. Mandatory >=4,000 additions gate gerçek UI/model/controller/a11y/test kapsamıyla karşılandı; boilerplate, duplicate component/CSS veya sahte coverage kullanılmadı.
- EXPERIENCE MODERNİZASYONU: global Alt+N discovery bridge, canonical notification modeline bağlı hızlı triage paneli, bounded filter/focus/window authorities ve responsive accessibility policy eklendi. Telefon sheet, tablet side panel, desktop floating surface; 44/48px target; reduced-motion/forced-colors; deterministic semantic IDs; bounded live announcements ve item ARIA labels explicit hale getirildi.
- ACCESSIBILITY / INPUT SAFETY: Escape focus restoration, Home/End, J/K, scope accelerators ve activation intent'leri composing/repeat/defaultPrevented/modifier/editable guardrail'leriyle yönetiliyor. Tek listbox tab-stop + `aria-activedescendant`, semantic position/set-size, explicit touch actions, accessible metrics/recovery copy ve `aria-keyshortcuts="Alt+N"` sözleşmeleri regression testleriyle kilitlendi.
- REGRESSION REPAIR: ilk exact-base Vitest turundaki 8 yeni triage failure coverage azaltılmadan giderildi. External model update React `act()` içine alındı; timestamps deterministik yapıldı; preview assertion gerçek listbox'a scope edildi; current recovery/keyboard metni doğrulandı; aktif-item testleri explicit hale getirildi. Takip turunda kalan tek sort testi, sort değişiminin DOM sırasını güncellerken aktif bildirimi/focus'u korumasını ayrı ayrı doğrulayacak şekilde düzeltildi.
- RELIABILITY / SECURITY: observer capacity/failure diagnostics bounded; canonical notification store tek authority olarak korunuyor. Yeni endpoint, browser transport, telemetry/analytics, remote font/CDN, WMS/WFS UI, secret, ağır asset veya ikinci icon resolver eklenmedi.
- CI GATE PRODUCT HEAD: exact head `0492fe20c19f461216884eaad3b5041b3946f821` için Webclient Quality `37304057257`, Release QA `37304057306`, Typed Source Boundary `37304057263` ve Platform Architecture Audit `37304057416` tamamı `completed+success`. Webclient strict changed-source lint, 0-new-diagnostic exact-base TypeScript, full + exact-base Vitest, native tooling, production Vite build/integrity ve bundle budgets success. Release QA webclient release validation, typed TypeScript 7/exact-base release gate ve backend restore/audit/build/xUnit/User+Admin publish success.
- REVIEW / MERGEABILITY: product head'de submitted review ve inline review thread sayısı 0; PR `mergeable=true`; second interaction/regression review'da kritik UX/release riski bulunmadı.
- MERGE DURUMU: bu progress commit'i yeni exact head oluşturur; product-head PASS tek başına final merge izni değildir. Yeni progress exact head üzerinde dört zorunlu workflow `completed+success`, current main fresh/behind=0, additions>=4,000, `mergeable=true` ve review/thread temizliği korunmadan merge yapılmaz.
- SONRAKİ GÖREV NOTU: progress exact-head CI'ını doğrula; current main SHA/merge-base'i son kez refresh et. Tüm gate'ler korunuyorsa PR #470'i draft'tan ready durumuna getir ve expected-head kilitli squash merge yap. Merge SHA ile yeni main SHA'yı doğrula.

## Deep QA / fresh-main release reconciliation — PR #471 checkpoint — 2026-10-05
- TUR / GÖREV: Deep QA / Release / Regression / Whole-Code Modernization; kayıp QA delta'sını Experience değişikliklerini koruyarak current-main tree üzerine dosya-scope bazında yeniden uygulama.
- BRANCH / PR: `agent/qa-modernization-20261005-1257-456f05b`; PR #471 kanonik QA PR'ıdır ve final exact-head gate tamamlanana kadar draft kalır.
- CURRENT MAIN / LINEAGE: current main/base/merge-base `1773e720964df105a3728b2eab54a5e3c730023c`; reapply product head `0dceb75c4ee7aecf9fc204b6c62c465eb8376c8a` current main'e göre 9 ahead / 0 behind. Reconciliation yalnız QA'nın 20 dosyalık delta yüzeyini overlay etti; Experience `src` tree'si current main'den korundu.
- KAPSAM / GATE: product head'de 20 QA/release dosyası, 4,084 meaningful additions / 1 deletion; mandatory >=4,000 additions gate yeniden sağlandı.
- QA MODERNİZASYONU: release admission/lifecycle/evidence authorities, page usability, whole-page experience ve tooling-language contract auditleri ile adversarial regression coverage current-main üzerine geri taşındı. Önceki TypeScript exact-optional ve suppression false-positive repair'leri korunuyor.
- SECURITY / NETWORK: yeni endpoint, browser transport, telemetry, secret, remote asset, WMS/WFS/WMTS veya ikinci icon authority eklenmedi; reconciliation production Experience kaynaklarını geri almıyor.
- TEST / CI: reapply product head oluşturulduktan sonraki ilk GitHub Actions sorgusunda run henüz kayıtlı değildi; PASS ilan edilmedi. Bu progress commit'i yeni exact head oluşturur ve tüm zorunlu exact-head workflow'lar yeniden `completed+success` olmadan merge yapılmaz.
- SONRAKİ GÖREV NOTU: progress exact head SHA'sını doğrula; current main'i refresh et; additions>=4,000, behind=0, merge-base=current main ve mergeable=true durumlarını tekrar doğrula. Release Evidence Contract, Platform Architecture Audit, Platform Typed Test Validation, QA Typed Release Diagnostics, Webclient Quality ve Release QA tamamı success ise final security/performance/regression review sonrası ready + expected-head squash merge uygula; aksi halde aynı PR'de gerçek hatayı düzelt.

## Deep GIS / current-main collision audit — PR #477 checkpoint — 2026-10-06
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; current-main GIS lifecycle inventory and safe continuation of PR #477.
- BRANCH / PR: `agent/gis-reconcile-20261005-2110-d364f99`; PR #477 remains canonical, draft/open.
- CURRENT MAIN / LINEAGE: main/base/merge-base `d364f991b88a0668a1337490227af4936eac232f`; product tree remains the validated pre-turn GIS tree after collision repair. The branch is behind=0.
- COLLISION REPAIR: proposed layer-refresh lifecycle work was discovered to already exist on current main in a richer implementation. The attempted replacement was immediately reverted by restoring the exact current-main blobs for `ArcGisLayerRefreshLifecyclePolicy.ts` and its test. No current-main GIS capability or test coverage was lost.
- EXISTING GIS DELTA: PR #477 continues to carry geometry projection, query dedupe, identify/query, query-response cache, distinct-value and object-id-set lifecycle authorities. Product-scope gate remains below 4,000 additions, so merge is forbidden.
- TEST / CI: pre-turn exact product head `3fea66590bb5e924409e2dcf9378330fcf144693` had Platform Architecture Audit #37387022691 and Release QA #37387022712 completed+success. Any new progress exact head requires fresh CI; do not inherit PASS.
- NETWORK / SECURITY / ICONS: no endpoint, WMS/WFS, telemetry, secret, remote asset or second icon resolver added. Collision repair preserved current-main implementation exactly.
- SONRAKİ GÖREV NOTU: inventory current-main GIS modules before selecting the next slice; choose a non-duplicate high-impact runtime/geometry/query/layer/2D-3D gap, add adversarial coverage, and continue until base...head additions >=4,000. Verify exact-head CI and mergeability before any merge.

## Deep GIS — PR #477 integrity checkpoint (2026-10-08)
- Main/base: d364f991b88a0668a1337490227af4936eac232f; PR #477 draft/open. Product commits: 4479a266299581f477b2b16964e3400bab28b569, efe03668c045d38922ab777135cdac263a158880, e0ead81ae67a44c861eb3a6fa4a641eccec9b469.
- Statistics: reject impossible-to-fit aggregate completion, bound zero-byte empty-group residents, guard future queue/clock rollback and preserve FIFO. Page: reject request-ID collisions and invalid page completions, protect priority queue, whitelist scalar request fields, validate lookup and lease clocks. Added adversarial Vitest suites.
- Baseline head 8ca874ef32d9a70e60859a425e82c2769e2435d2 passed Platform Architecture Audit #37694707841 and Release QA #37694707835. New exact-head CI is required; do not inherit PASS. Local npm/build unavailable.
- No new network endpoint, WMS/WFS, telemetry, remote asset or icon resolver. Mandatory >=4000 additions not reached; do not merge. Next: exact-head CI, security/performance/data-integrity review, meaningful GIS backlog and current-main/mergeability recheck.

## Deep GIS — ArcGIS query cache invalidation fence — 2026-10-08
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; stale inflight ArcGIS query responses must not repopulate a cache after invalidateAll/invalidateService.
- BRANCH / PR: `agent/gis-reconcile-20261005-2110-d364f99`; canonical draft/open PR #477. Baseline main/merge-base `d364f991b88a0668a1337490227af4936eac232f`; no unrelated branch rewritten.
- ÜRÜN KODU: `ArcGisQueryCoordinator` now marks active flights in a WeakSet during global/service invalidation and suppresses late cache writes. WeakSet avoids unbounded per-service invalidation metadata. Flight cleanup checks identity before deleting a map entry, preventing stale-flight cleanup from removing a newer same-key flight.
- REGRESSION: `ArcGisQueryCoordinator.invalidation.test.ts` covers late global invalidation, service-scoped isolation, and ordinary cache hits. No new endpoint, WMS/WFS, secret, telemetry, remote asset or second icon resolver.
- TEST / BUILD / CI: Local npm/test/lint/typecheck/build not executed in this GitHub-native run. New exact-head Platform Architecture Audit and Release QA must reach completed+success; do not inherit previous head's PASS.
- PERFORMANCE / DATA INTEGRITY / SECURITY: Prevent stale data residency after invalidation; no new retained payloads or unbounded service-id map. Review pending CI for regression and release risk.
- MERGE DURUMU: additions < 4,000; PR remains draft/open and MUST NOT merge. Next: verify exact-head CI, current main/merge-base/mergeability, inspect page transport timeout/abort hazards and implement meaningful GIS follow-up with adversarial tests.

## Deep GIS — query execution checkpoint — 2026-10-08
- PR #477 remains canonical draft/open on current main d364f991b88a0668a1337490227af4936eac232f.
- ArcGisQueryExecutionCoordinator now bounds page plans and waits for transport using deadline/cancellation races, preserves first page failure and classifies inspector exceptions.
- ArcGisQueryExecutionCoordinator.adversarial.test.ts adds five focused regression tests.
- No network endpoint, WMS/WFS, telemetry or icon authority added. Local npm validation unavailable. Exact-head CI pending; do not inherit older success.
- Additions below 4000: no merge. Next: review exact-head CI and continue meaningful GIS repairs.

## Deep GIS — PR #477 query identity and spatial integrity — 2026-10-08
- Branch: `agent/gis-reconcile-20261005-2110-d364f99`; base/main: `d364f991b88a0668a1337490227af4936eac232f`.
- Query planner identities now distinguish effective page counts and server ordering capabilities, normalize object-ID sets, reject unordered multi-page offset requests and malformed order/controls.
- Response inspector rejects geometry WKID mismatches; query coordinator checks synchronous abort and raw controls.
- Added focused Vitest regressions for identity, spatial-reference integrity, abort and invalid runtime input.
- Previous exact-head CI success does not transfer to new commits. Local npm/build not executed; recheck GitHub Actions on new head.
- No endpoint, WMS/WFS, telemetry, secret or new icon resolver. Additions gate below 4,000: keep PR draft/open, do not merge.
- Next: check exact-head CI, repair failures, review performance/security/data integrity and continue meaningful GIS work.

## GIS PR #477 — clock integrity checkpoint — 2026-10-08
- Count and extent lifecycle scheduling now fences future-dated admission, pre-start lease completion, and pre-capture cache reads.
- Extent enqueue no longer expires other residents using an untrusted future timestamp. Added focused adversarial clock tests and identifier control checks.
- Prior head `9640519f44f6a6560a23658145f94c43be284e64` passed Architecture Audit #37722223069 and Release QA #37722222595; new exact-head CI pending.
- No network, WMS/WFS, secret, telemetry or icon resolver changes. Local npm unavailable. Additions < 4000, draft PR remains open.
- Next: exact-head CI, performance/data integrity/security review, continue real GIS modernization.

## GIS #477 CI checkpoint
- New GIS-specific CI added for previously uncovered source and tests; exact-head verification required before merge.

- GIS Core Quality exposed eight previously invisible Vitest failures. Admission error classification, cache LRU tie-breaking, scheduler ordering, object-ID integrity classification, test budget consistency and projection lease-boundary regression were repaired. Dedupe raw-control validation remains pending exact-head verification.

- GIS Core Quality rerun: 592/593 Vitest cases passed. Remaining Dedupe test now asserts rejection of embedded controls, matching existing signature trimming behavior; stricter boundary-control rejection remains a follow-up. Exact-head CI required.

- Exact-head GIS Core Quality #37723292147 passed: 42 suites, 593 tests, strict GIS TypeScript and lint. Release QA #37723292141 failed its regression gate because new workflow concurrency used an untrusted ref. Changed concurrency to numeric PR/run identifiers and checkout to full baseline history; reverify new exact-head CI.

## Deep GIS — dedupe identity and bounded geometry traversal — 2026-10-08
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; prevent ArcGIS query request-ID aliasing and bound adversarial geometry traversal across an entire query page.
- BRANCH / PR: `agent/gis-reconcile-20261005-2110-d364f99` / #477 (canonical draft/open). Base/merge-base main `d364f991b88a0668a1337490227af4936eac232f` at pre-commit refresh.
- IMPLEMENTATION: Dedupe validates ASCII controls before trimming identities and rejects a reused request ID when signature/layer/revision differs; identical logical requests remain coalescible. Response integrity adds per-feature and per-page geometry node budgets, including empty array/object fanout, without allocating an Object.entries array per geometry object.
- REGRESSION: New dedupe collision/boundary-control cases and a dedicated geometry traversal suite cover shallow fanout, cross-feature pressure, normal geometry, invalid options, nonfinite coordinates and spatial-reference mismatch.
- PERFORMANCE / SECURITY / DATA INTEGRITY: Geometry traversal is bounded by scalar counters (default 250k nodes/feature, 500k nodes/page). No retained geometry payload, network endpoint, WMS/WFS, secret, telemetry, remote asset or second icon resolver introduced.
- TEST / BUILD: Pre-change exact head `7b0bdba55fd048576355010eaca20c726d1c1ee5` passed GIS Core Quality #37723640513, Platform Architecture Audit #37723640007 and Release QA #37723640040. New exact-head CI must be verified; prior success does not transfer. Local npm/build not run in GitHub-native environment.
- MERGE: base...head additions remained 2,684 before this change, below 4,000. Keep PR draft/open; do not merge until additions >=4,000, current-main ancestry and all exact-head CI pass.
- SONRAKİ GÖREV: Verify GitHub tree/commit/ref and new exact-head CI. Repair any TypeScript/Vitest/Release QA failure; review geometry traversal and request collision behavior, then continue meaningful GIS backlog and final regression.

## Deep GIS — page-wide attribute pressure guard — 2026-10-08
- TUR / GÖREV: GIS query response integrity second pass, extending bounded geometry inspection with bounded page-wide attribute processing.
- PRODUCT: `ArcGisQueryResponseIntegrity` now rejects page-wide attribute count >131,072 and total string characters >16,777,216 by default, while retaining the existing per-feature/per-field limits. Uses bounded own-property iteration instead of eagerly allocating `Object.entries` for an oversized untrusted attributes object. `requireObjectId` option must be boolean.
- REGRESSION: `ArcGisQueryResponseIntegrity.attribute-page-budget.test.ts` covers aggregate attribute cardinality, text pressure, oversized single-feature object, ordinary valid pages and malformed budget options.
- CI: Previous exact head `f5cbb823f07e39ceefdf2818ef760e086b79b18f` GIS Core Quality #37742221781 and Platform Architecture Audit #37742221680 completed+success; Release QA #37742221698 was in progress at checkpoint. This new commit requires new exact-head CI.
- SECURITY / PERFORMANCE: no new endpoint, WMS/WFS, secret, telemetry, remote asset or icon resolver. Bounded work prevents adversarial multi-feature attribute fanout; no payload retained by policy.
- MERGE / NEXT: #477 remains draft/open until >=4,000 meaningful additions, current main ancestry, mergeability and all exact-head CI success. Review CI and fix regressions, then continue high-priority GIS work.

- GIS compatibility: default page budgets raised to allow 500-feature / 40-field responses while preserving explicit bounded overrides; new regression included. CI on updated head required.

## Deep GIS — ArcGIS execution integrity and timeout pressure — 2026-10-08
- TUR / GÖREV: PR #477 canonical GIS continuation; main/base/merge-base `d364f991b88a0668a1337490227af4936eac232f`; branch `agent/gis-reconcile-20261005-2110-d364f99`.
- ÜRÜN: Reject cross-page object-ID collisions and malformed/noncontiguous offset plans before network execution. Revalidate injectable inspector feature/object-ID alignment, requested-ID membership and page size at aggregation. Reject transfer-limit on final offset page instead of silently returning truncated data. Do not retry timeouts where an AbortSignal-ignoring transport may still consume network/CPU; preserve retries for settled transient transport errors.
- REGRESSION: Added adversarial aggregation, unrequested ID, final-page truncation, duplicate-plan and offset-gap tests; updated timeout regression to require a single physical attempt and added settled-failure retry coverage.
- PERFORMANCE / DATA INTEGRITY / SECURITY: Prevent timeout retry amplification and silent page truncation. No endpoint, WMS/WFS, telemetry, secret, remote asset or second icon resolver. Local npm/test/build unavailable in GitHub-native execution; new exact-head GIS Core Quality, Platform Architecture Audit and Release QA are required before PASS.
- MERGE: Prior verified scope 2,949 additions (<4,000). Keep draft/open, never merge below the additions gate. Next: verify exact-head CI, repair failures, refresh main/merge-base, review remaining high-priority GIS execution and geometry lifecycle risks.
