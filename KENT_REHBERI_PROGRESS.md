# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Önceki checkpoint/arşiv zinciri repository geçmişinde korunur.

## Deep GIS / projection + spatial + edit + service-request + capability governance — PR #443 checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; projection, spatial-query, identify, proximity, FeatureServer edit admission, ArcGIS REST request lifecycle ve layer capability metadata authority'lerini current-main lineage üzerinde bounded/deterministic/payload-free sürdürme.
- BRANCH / PR: `agent/gis-spatial-20261002-1007-840e682`; draft/open PR #443 kanonik GIS devam PR'ıdır.
- CURRENT MAIN / LINEAGE: current main/base/merge-base `840e68256965a51681d4469c7d14c50d8c26469f`; capability product head `c8a0fa0a26516ee2bcf17ddc39fc3c8955158b39` 11 ahead / 0 behind. PR current-main lineage temiz ve product öncesi mergeable=true.
- KAPSAM / GATE: product head ile base...head 1,792 additions / 49 deletions, 12 changed files. Mandatory >=4,000 additions gate açık; merge yasak ve aynı PR gerçek yüksek öncelikli GIS kapsamıyla büyütülecek.
- GIS MODERNİZASYONU: projection/spatial-query/identify/proximity/edit-validation/service-request authority'lerine yeni `ArcGisLayerCapabilityRegistry` eklendi. ArcGIS REST layer metadata artık bounded schema/cardinality/byte residency, monotonic revision, Web Mercator WKID canonicalization, operation dependency, identity-field ve field-type bütünlüğü ile yönetiliyor.
- DATA INTEGRITY / SECURITY: duplicate fields/operations, stale revisions, invalid OBJECTID/GlobalID references, impossible scene edit, pagination/statistics without query, malformed identifiers, oversized metadata/record limits ve invalid spatial metadata fail-closed. Registry URL/token/renderer/popup/feature payload/SDK Layer graph tutmuyor.
- NETWORK / SERVİSLER / İKON: yeni endpoint, transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi. Capability authority yalnız mevcut doğrulanmış ArcGIS REST metadata'sını normalize etmek üzere transport-agnostic tutuldu; shared deterministic icon resolver korunuyor.
- TEST / CI: önceki exact head `49a3fc170d306a051b7d2cc898fb6bc130202c9c` için Platform Architecture Audit `36988125324` ve Release QA `36988125385` completed+success. Capability registry için 181 satır adversarial Vitest kapsamı eklendi; yeni product/progress head exact-head CI yeniden tamamlanmadan PASS ilan edilmez.
- PERFORMANCE REVIEW: registry global layer, per-layer field/operation, per-layer ve aggregate metadata-byte limitleriyle bounded; payload retention ve network/GPU işi eklenmez. Snapshot/fingerprint yalnız bounded scalar metadata üzerinde deterministic çalışır.
- MERGE DURUMU: mandatory >=4,000 base...head additions gate halen açık olduğundan PR draft/open kalır ve merge edilmez. Progress head için CI ve mergeability yeniden doğrulanacaktır.
- SONRAKİ GÖREV NOTU: exact-head CI doğrula; aynı #443 üzerinde layer-load/cache invalidation/spatial execution ve service capability integration backlog ile >=4,000 meaningful additions'a ilerle. Her head değişiminde current-main lineage, mergeability ve exact-head checks yeniden doğrulanmalı.

## Deep Experience / adaptive workspace shell fresh-main checkpoint — PR #439 — 2026-10-02
- Bu rol dışı paralel ekip checkpoint'i repository geçmişinde korunur; GIS turu bu alanı değiştirmez.
