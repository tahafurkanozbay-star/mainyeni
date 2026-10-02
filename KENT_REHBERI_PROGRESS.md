# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Bu checkpoint öncesindeki tam canonical progress sürümü [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261002_PRE_PR424.md`](./KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261002_PRE_PR424.md) içinde korunur; önceki arşiv zinciri de oradan erişilebilir.

## Deep GIS / spatial-query lifecycle governance — PR #429 checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; ArcGIS spatial query ownership, scheduling, result residency ve stale-work lifecycle sınırlarını bounded/deterministic/payload-free hale getirme.
- BRANCH / PR: `agent/gis-spatial-20261002-0508-f6451b4`; draft/open PR #429 kanonik GIS devam PR'ıdır.
- CURRENT MAIN / LINEAGE: tur başlangıcı current main/base `f6451b40586e35ceba167ee3ef162173f132edc1`; branch fresh main'den oluşturuldu. Paralel Platform PR #428 global blokaj sayılmadı.
- KAPSAM / GATE: product head `52310701d58563656472115d0eb7414635f9d2cd` öncesinde 2 GIS dosyası ve 346 meaningful additions / 0 deletions. Mandatory >=4,000 additions gate henüz açık; merge yasak ve aynı PR sonraki turda büyütülecek.
- GIS MODERNİZASYONU: `ArcGisSpatialQueryLifecyclePolicy` global/per-view/running/ready cardinality, per-query + aggregate feature/byte residency budgets, deterministic interactive→visible→background scheduling, layer revision watermark, stale/late completion rejection, queue/run/ready leases, consume/cancel/touch ve view/layer teardown uygular.
- DATA INTEGRITY / SECURITY: identifier/numeric admission fail-closed; actual result sizes estimated budgets ile reconcile edilir. Geometry/Graphic/FeatureSet/attributes/credential/AbortController veya transport payload graph authority state'inde tutulmaz.
- NETWORK / SERVİSLER / İKON: yeni endpoint, browser transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi; mevcut doğrulanmış ArcGIS REST ve shared deterministic icon authority korunur.
- TEST / REGRESSION: yeni Vitest paketi scheduling, concurrency, dedupe, cardinality, aggregate residency, revision invalidation, late completion, expiry, touch/consume, teardown, malformed input, impossible budget, detached snapshot, fingerprint ve disposal davranışlarını kilitler. Local shell kullanılmadı; exact-head GitHub Actions sonucu beklenir.
- MERGE DURUMU: additions gate karşılanmadığı için PR draft/open bırakılır; merge yapılmaz.
- SONRAKİ GÖREV NOTU: exact-head CI durumunu doğrula; aynı PR üzerinde yüksek etkili GIS backlog ile >=4,000 meaningful additions'a ilerle. Her head değişiminde CI ve fresh-main lineage/mergeability kontrolünü yenile.
