# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Önceki checkpoint/arşiv zinciri repository geçmişinde korunur.

## Deep GIS / projection + spatial + edit + service + capability + layer-load + cache governance — PR #443 checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; projection, spatial-query, identify, proximity, FeatureServer edit admission, ArcGIS REST request lifecycle, layer capability metadata, layer load ve cache residency/invalidation authority'lerini current-main lineage üzerinde bounded/deterministic/payload-free sürdürme.
- BRANCH / PR: `agent/gis-spatial-20261002-1007-840e682`; draft/open PR #443 kanonik GIS devam PR'ıdır.
- CURRENT MAIN / LINEAGE: current main/base/merge-base `840e68256965a51681d4469c7d14c50d8c26469f`; cache product head `a312669707433c03c167dad1a94cb900e5e7e1a4` 17 ahead / 0 behind; merge-base exact current main.
- KAPSAM / GATE: product head ile base...head 2,368 additions / 49 deletions, 16 changed files. Mandatory >=4,000 additions gate açık; merge yasak ve aynı PR gerçek yüksek öncelikli GIS kapsamıyla büyütülecek.
- GIS MODERNİZASYONU: mevcut projection/spatial-query/identify/proximity/edit-validation/service-request/capability/layer-load authority'lerine `ArcGisCacheResidencyPolicy` eklendi. ArcGIS REST-derived cache ownership global/per-service/loading/resident cardinality, estimate→actual byte reconciliation, aggregate resident bytes, monotonic layer revision watermark, stale/expired completion rejection, TTL/touch/consume/invalidate, layer/service teardown ve deterministic pressure eviction uygular.
- CACHE / INVALIDATION: revision advance eski layer cache authority'sini deterministik düşürür. Pressure eviction background→visible→interactive önceliği, sonra expiry/sequence/key tie-break'i ile payload-free metadata üzerinde çalışır; response JSON/FeatureSet/Graphic/credential/URL/request body/AbortController policy state'inde tutulmaz.
- DATA INTEGRITY / SECURITY: malformed identity, stale/backwards revision, oversized estimate/actual response, expired completion, duplicate authority ve aggregate residency overflow fail-closed. Payload storage ve gerçek network cancellation caller-owned kalır.
- NETWORK / SERVİSLER / İKON: yeni endpoint, transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi. Mevcut doğrulanmış ArcGIS REST ve shared deterministic icon resolver korunuyor.
- TEST / CI: önceki exact head `9d533369f83fd4bf4e61e6ced739437a6fcba85f` için Platform Architecture Audit `36999674038` ve Release QA `36999674085` completed+success. Cache authority için adversarial Vitest; admission/completion byte budgets, cardinality, revision invalidation, stale/expired work, touch/consume, teardown, deterministic eviction/fingerprint, malformed input, impossible budgets ve disposal davranışlarını kapsar. Bu progress commit yeni exact head oluşturduğu için current-head PASS yalnız yeni workflow'lar completed+success olduktan sonra ilan edilir.
- PERFORMANCE REVIEW: loading/resident ownership ve aggregate bytes explicit bounded; stale/expired work deterministic temizlenir; pressure eviction O(n log n) fakat maxEntries ile hard-bounded. Payload retention, yeni network veya GPU işi eklenmez.
- MERGE DURUMU: mandatory >=4,000 base...head additions gate halen açık olduğundan PR draft/open kalır ve merge edilmez. Progress exact-head CI ve mergeability yeniden doğrulanacaktır.
- SONRAKİ GÖREV NOTU: exact-head CI doğrula; aynı #443 üzerinde spatial-execution/renderer-state/LOD residency backlog ile >=4,000 meaningful additions'a ilerle. Her head değişiminde current-main lineage, mergeability ve exact-head checks yeniden doğrulanmalı.

## Deep Experience / adaptive workspace shell fresh-main checkpoint — PR #439 — 2026-10-02
- Bu rol dışı paralel ekip checkpoint'i repository geçmişinde korunur; GIS turu bu alanı değiştirmez.
