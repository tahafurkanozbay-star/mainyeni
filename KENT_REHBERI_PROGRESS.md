# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Önceki checkpoint/arşiv zinciri repository geçmişinde korunur.

## Deep GIS / projection + spatial + edit + service-request governance — PR #443 checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; projection, spatial-query, identify, proximity, FeatureServer edit admission ve ArcGIS REST request lifecycle authority'lerini current-main lineage üzerinde bounded/deterministic/payload-free sürdürme.
- BRANCH / PR: `agent/gis-spatial-20261002-1007-840e682`; draft/open PR #443 kanonik GIS devam PR'ıdır.
- CURRENT MAIN / LINEAGE: current main/base/merge-base `840e68256965a51681d4469c7d14c50d8c26469f`; service-request product head `cdb2a5cbe12b24f79fe018f5d60d44caaf89e05d` 8 ahead / 0 behind. PR product öncesi mergeable=true idi.
- KAPSAM / GATE: product head ile base...head 1,367 additions / 49 deletions, 10 changed files. Mandatory >=4,000 additions gate açık; merge yasak ve aynı PR gerçek yüksek öncelikli GIS kapsamıyla büyütülecek.
- GIS MODERNİZASYONU: projection/spatial-query/identify/proximity ve edit-validation authority'lerine yeni `ArcGisServiceRequestLifecyclePolicy` eklendi. ArcGIS REST query/identify/legend/metadata work artık deterministic interactive/visible/background scheduling, request-signature dedupe, global/per-service cardinality ve concurrency, response/aggregate-ready byte budgets, service revision watermark, stale/late completion rejection, bounded retry, queue/run/ready lease, touch/consume/cancel/service teardown altında yönetiliyor.
- DATA INTEGRITY / SECURITY: malformed identifier/signature, non-finite timing, oversized estimate/actual response, stale revision ve completion identity mismatch fail-closed. Policy URL/header/body/credential/response JSON/AbortSignal/SDK payload graph tutmuyor; fingerprint signature veya request içeriği sızdırmıyor.
- NETWORK / SERVİSLER / İKON: yeni endpoint, transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi. Authority mevcut doğrulanmış ArcGIS REST adapter çağrılarını koordine etmek üzere transport-agnostic tutuldu; shared deterministic icon resolver korunuyor.
- TEST / CI: önceki exact head `16f239daa035bc8121e119ecce8b6b252c281f23` için Platform Architecture Audit `36982686879` ve Release QA `36982686913` completed+success. Yeni service-request implementation + adversarial regression commitleri ve bu progress commit yeni exact head oluşturduğundan current-head CI yeniden tamamlanmadan PASS ilan edilmez.
- PERFORMANCE REVIEW: request/running/ready cardinality, per-service concurrency ve aggregate response-byte residency explicit bounded; signature dedupe duplicate network work'ü engeller; stale/expired work deterministic temizlenir. Ağ çağrısı veya GPU yükü eklenmez.
- MERGE DURUMU: mandatory >=4,000 base...head additions gate halen açık olduğundan PR draft/open kalır ve merge edilmez. Progress head için CI ve mergeability yeniden doğrulanacaktır.
- SONRAKİ GÖREV NOTU: exact-head CI ve fresh-main lineage/mergeability doğrula; aynı #443 üzerinde layer-load/service-capability/cache invalidation veya spatial execution backlog ile >=4,000 meaningful additions'a ilerle.

## Deep Experience / adaptive workspace shell fresh-main checkpoint — PR #439 — 2026-10-02
- Bu rol dışı paralel ekip checkpoint'i repository geçmişinde korunur; GIS turu bu alanı değiştirmez.
