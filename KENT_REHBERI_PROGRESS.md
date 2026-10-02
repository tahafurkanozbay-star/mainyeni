# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Önceki ayrıntılı kayıtlar repository arşiv zincirinde korunur.

## Deep GIS / spatial execution fresh-main reconciliation — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; spatial execution lifecycle authority'yi fresh current-main lineage üzerinde geri kurma ve sonraki renderer/LOD işi için güvenli taban hazırlama.
- BRANCH: `agent/gis-spatial-20261002-1708-1313e37`; fresh base `1313e37003a2148007cafee3ae4d680e8d9f5c25`.
- STALE PR: #443 current main ilerleyince 2 behind/diverged oldu; merge edilmeden superseded kapatıldı. Eski branch tree/history körlemesine taşınmadı.
- REAPPLY: yalnız doğrulanmış `ArcGisSpatialExecutionLifecyclePolicy` ve adversarial test kapsamı seçici olarak fresh main'e reapplike edildi.
- GIS GOVERNANCE: query/identify/buffer/nearest/projection/measurement CPU işleri global/per-view/per-layer cardinality, global/per-view concurrency, deterministic interactive/visible/background scheduling, estimate→actual vertex/byte reconciliation, aggregate ready residency, revision watermark, stale/late completion rejection, TTL, touch/consume/cancel ve teardown ile bounded.
- DATA INTEGRITY / SECURITY: malformed identifier/non-finite input/impossible budget fail-closed; Geometry/Graphic/FeatureSet/worker/credential/AbortController/result payload graph authority state'inde tutulmaz.
- NETWORK / SERVİSLER / İKON: yeni endpoint, browser transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi.
- CI: stale #443 exact head `e52ec966dc992bfeb7df10117b384b4644c5f45f` Platform Architecture Audit `37011854788` ve Release QA `37011854931` completed+success idi. Fresh branch exact-head CI yeni commitlerden sonra ayrıca doğrulanacak.
- MERGE DURUMU: >=4,000 additions gate fresh PR'da henüz sağlanmadı; merge yasak. Aynı fresh branch/PR renderer-state, LOD/scene residency ve doğrulanmış eksik GIS authority ile büyütülecek.
- SONRAKİ GÖREV NOTU: fresh PR aç; exact-head CI doğrula; renderer-state/LOD residency substantive backlog'unu ekle; her head değişiminde current-main lineage ve mergeability kontrolünü yenile.

## Deep Data / Search / Address — usable search experience v9 merge closure — PR #444 — 2026-10-02
- Data/Search v9 current-main üzerine squash merge edildi; canonical ayrıntılar main geçmişinde korunur. GIS çalışması bu merge'i overwrite etmez.
