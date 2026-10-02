# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Önceki checkpoint/arşiv zinciri repository geçmişinde korunur.

## Deep GIS / projection + spatial + edit + service + capability + layer-load governance — PR #443 checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; projection, spatial-query, identify, proximity, FeatureServer edit admission, ArcGIS REST request lifecycle, layer capability metadata ve layer load/residency authority'lerini current-main lineage üzerinde bounded/deterministic/payload-free sürdürme.
- BRANCH / PR: `agent/gis-spatial-20261002-1007-840e682`; draft/open PR #443 kanonik GIS devam PR'ıdır.
- CURRENT MAIN / LINEAGE: current main/base/merge-base `840e68256965a51681d4469c7d14c50d8c26469f`; layer-load product head `528d3f9b4d3175fba93e1c7c2fe2335f1ccaa7b1` 14 ahead / 0 behind. PR product öncesi mergeable=true.
- KAPSAM / GATE: product head ile base...head 2,172 additions / 49 deletions, 14 changed files. Mandatory >=4,000 additions gate açık; merge yasak ve aynı PR gerçek yüksek öncelikli GIS kapsamıyla büyütülecek.
- GIS MODERNİZASYONU: mevcut projection/spatial-query/identify/proximity/edit-validation/service-request/capability authority'lerine `ArcGisLayerLoadLifecyclePolicy` eklendi. Layer hydration artık interactive/visible/background deterministic scheduling, global/per-view/loading/ready cardinality, estimated→actual byte reconciliation, aggregate ready residency, service+layer revision watermark, stale/late completion rejection, queue/load/ready leases, touch/consume/cancel ve view/layer/service teardown uygular.
- DATA INTEGRITY / SECURITY: malformed identity, stale revision, oversized estimate/actual response, expired completion ve aggregate residency overflow fail-closed. Authority Layer/LayerView, renderer/popup JSON, feature payload, credential, response body veya AbortController tutmuyor.
- NETWORK / SERVİSLER / İKON: yeni endpoint, transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi. Mevcut doğrulanmış ArcGIS REST ve shared deterministic icon resolver korunuyor.
- TEST / CI: önceki exact head `fb25043b679dff0b62bce3096f634af454ccee88` için Platform Architecture Audit `36994744496` ve Release QA `36994744494` completed+success. Yeni layer-load authority için 159 satır adversarial Vitest kapsamı eklendi; progress commit yeni exact head üreteceği için current-head PASS yalnız yeni workflow'lar completed+success olduktan sonra ilan edilir.
- PERFORMANCE REVIEW: load/loading/ready ownership bounded; per-layer ve aggregate ready bytes explicit; stale/expired work deterministic temizlenir. O(n) scans maxLoads ile bounded, payload retention/network/GPU işi eklenmez.
- MERGE DURUMU: mandatory >=4,000 base...head additions gate halen açık olduğundan PR draft/open kalır ve merge edilmez. Progress exact-head CI ve mergeability yeniden doğrulanacaktır.
- SONRAKİ GÖREV NOTU: exact-head CI doğrula; aynı #443 üzerinde cache invalidation/spatial execution/renderer-state service-capability integration backlog ile >=4,000 meaningful additions'a ilerle. Her head değişiminde current-main lineage, mergeability ve exact-head checks yeniden doğrulanmalı.

## Deep Experience / adaptive workspace shell fresh-main checkpoint — PR #439 — 2026-10-02
- Bu rol dışı paralel ekip checkpoint'i repository geçmişinde korunur; GIS turu bu alanı değiştirmez.
