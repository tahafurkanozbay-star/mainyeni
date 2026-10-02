# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Bu checkpoint öncesindeki tam canonical progress sürümü [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261002_PRE_PR424.md`](./KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261002_PRE_PR424.md) içinde aynı Git blob SHA ile korunur; önceki arşiv zinciri de oradan erişilebilir.

## Deep GIS / fresh-main spatial + edit + projection authority — PR #437 checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; spatial query, identify fan-out, proximity CPU work, FeatureServer edit validation ve projection-work authority.
- BRANCH / PR: `agent/gis-spatial-20261002-0916-85c4fee`; draft/open PR #437 kanonik GIS devam PR'ıdır. Eski #429 main ilerlediğinde 4 behind/diverged olduğu için merge edilmeden superseded kapatıldı; stale tree kopyalanmadı.
- CURRENT MAIN / LINEAGE: branch fresh current main `85c4fee643af378337cf5a4bab6de80891a998a0` üzerinden kuruldu; yalnız current main'de bulunmayan doğrulanmış GIS blob'ları seçici taşındı. İlk compare 3 ahead / 0 behind ve merge-base exact main.
- KAPSAM / GATE: projection product head `13ab155bcb525c30d669f5a0f78fb1f26829b14a` ile base...head 2,303 additions / 0 deletions / 10 GIS files. Mandatory >=4,000 additions gate açık; merge yasak.
- GIS MODERNİZASYONU: mevcut spatial-query/identify/proximity/edit-validation authority'lerine `ArcGisProjectionWorkLifecyclePolicy` eklendi. Projection işleri deterministic interactive/navigation/background scheduling, global/per-view/running/ready cardinality, per-job ve aggregate point/byte residency, WKID canonicalization, revision watermark, stale/late completion rejection, queue/run/ready lease, consume/cancel/touch ve view teardown ile bounded.
- DATA INTEGRITY / SECURITY: Web Mercator 102100→3857 canonicalization, no-op SR rejection, malformed WKID/id/non-finite time ve oversized estimate/actual result fail-closed. Coordinate arrays, Geometry/Graphic, projection worker/SDK object, credential ve AbortController authority state'inde tutulmaz.
- NETWORK / SERVİSLER / İKON: yeni endpoint, browser transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi; mevcut doğrulanmış ArcGIS REST ve shared deterministic icon authority korunur.
- TEST / REGRESSION: projection için 268 satırlık adversarial Vitest scheduling/tie-break, concurrency/cardinality, WKID alias/no-op, estimate→actual reconciliation, aggregate residency, revision invalidation, lease expiry, touch/consume/cancel, teardown, malformed input, impossible budget, payload absence, deterministic fingerprint ve disposal davranışlarını kapsar. Exact-head CI yeni progress commit sonrasında yeniden doğrulanacaktır.
- PERFORMANCE REVIEW: projection queue/running/ready ownership ve point/byte residency explicit bounded; ağır coordinate/SDK graph retention yok. O(n) scans maxJobs sınırı içinde kalır; network/GPU yükü eklenmez.
- MERGE DURUMU: additions gate açık; PR draft/open bırakılır ve merge yapılmaz.
- SONRAKİ GÖREV NOTU: exact-head CI ve fresh-main lineage doğrula; aynı #437 üzerinde service-adapter integrity ve measurement/spatial execution backlog ile >=4,000 meaningful additions'a ilerle.

## Deep GIS / governed scene residency and visibility transitions — PR #424 gate checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; ArcGIS runtime lifecycle, scene prefetch, labeling ve layer visibility transition authority'lerini bounded/deterministic/payload-free hale getirme.
- BRANCH / PR: `agent/gis-spatial-20261001-1915-83d845f`; PR #424 kanonik GIS PR'ıdır. Gate product head `8faa9360d1e4195e220ff259ead88fb0a3f41303`; bu progress commit yeni exact head oluşturacaktır.
- CURRENT MAIN / LINEAGE: current main/base/merge-base `83d845f9c42a8937363484b852832d3afa81da16`; gate product head current main'e göre 22 ahead / 0 behind.
- KAPSAM / GATE: product head'de 22 changed GIS files, 4,061 meaningful additions / 0 deletions. Mandatory >=4,000 additions gate gerçek lifecycle policy ve adversarial regression kapsamıyla karşılandı.
- GIS MODERNİZASYONU: time-enabled layer slices, elevation sampling, cluster builds, popup hydration, selection/highlight, renderer-frame residency, camera transitions, export jobs, SceneLayer prefetch, label placement ve layer visibility transitions bounded authority altında.
- DATA INTEGRITY / SECURITY: identifier/numeric admission fail-closed; detached snapshots ve scalar fingerprints SDK payload graph retention'ını önler.
- NETWORK / SERVİSLER / İKON: yeni endpoint, browser transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi.
- MERGE DURUMU: gate karşılandı ve daha sonraki turda squash merge edilerek main'e alındı.

## Deep Experience / governed measurement fresh-main reconciliation — PR #430 gate checkpoint — 2026-10-02
- TUR / GÖREV: Deep Experience / Whole-Code Modernization; Measurement UI, state/controller, runtime resilience, responsive ve accessibility davranışlarını current-main lineage üzerinde reconcile etme.
- BRANCH / PR: `agent/experience-measurement-20261002-0525-f6451b4`; PR #430 kanonik Experience PR'ıdır.
- KAPSAM / GATE: product head'de 12 Measurement files, 4,110 meaningful additions / 169 deletions. Mandatory >=4,000 additions gate gerçek UI/controller/model/runtime ve adversarial regression kapsamıyla karşılandı.
- EXPERIENCE MODERNİZASYONU: semantic status/guidance/recovery UI, keyboard/pointer modality, bounded activity history, retry policy, responsive/coarse-pointer ergonomics, focus-visible, reduced-motion ve forced-colors davranışları korunur.
- NETWORK / SERVİSLER / İKON: yeni endpoint, WMS/WFS UI, analytics/telemetry, remote font/CDN, ağır asset veya ikinci icon resolver eklenmedi.
- MERGE DURUMU: additions gate karşılandı; exact-head CI tamamlanmadan merge yok.

## Deep Data / Search / Address — typo-tolerant recovery v8 merge closure — PR #404 — 2026-10-02
- TUR / GÖREV: Deep Data / Search / Address / Whole-Code Modernization; bounded fuzzy lexicon, scoped synonym governance, grammar-safe query correction ve original-first recovery orchestration.
- BRANCH / PR: `agent/data-search-v8-20260930-1314-ace96e5`; PR #404 final exact head `19693a73d1fb4827a2a71bdb7c45a54955e3b24e`.
- KAPSAM / GATE: final PR 10 Data/Search dosyası, 4,357 meaningful additions / 0 deletions; mandatory >=4,000 additions gate sağlandı.
- DATA / SEARCH DÜZELTMELERİ: fuzzy source provenance ayraçları korundu; synonym group ID'leri kanonik ayraçlı biçimde tutuldu; correction kapalıyken typo'nun synonym fallback'e kaçması engellendi; correction sonrası synonym chaining default-off/explicit opt-in yapıldı; recovery attempt budget explicit `maxAttempts` kontratına taşındı.
- BÜTÜNLÜK / GÜVENLİK: mevcut grammar/relevance, registry/cache/session ve immutable DatasetSnapshot authority'leri korunur. Yeni endpoint, browser transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon authority eklenmedi.
- FINAL CI: exact head için Webclient Quality, Release QA, Platform Architecture Audit ve Typed Source Boundary tamamı completed+success.
- MERGE: expected-head kilidiyle squash merge edildi; merge SHA `324ba32d077700e74681b547c0e18687033b86d8` ve current main ancestry'sinde korunuyor.
