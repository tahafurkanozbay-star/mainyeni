# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Bu checkpoint öncesindeki tam canonical progress sürümü [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261002_PRE_PR424.md`](./KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261002_PRE_PR424.md) içinde aynı Git blob SHA ile korunur; önceki arşiv zinciri de oradan erişilebilir.

## Deep GIS / current-main projection + spatial authority reconciliation — PR #443 — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; projection, spatial-query, identify fan-out ve proximity authority'lerini current-main lineage üzerinde güvenli sürdürme.
- BRANCH / PR: `agent/gis-spatial-20261002-1007-840e682`; draft/open PR #443 kanonik GIS devam PR'ıdır. #437 current main 3 commit ilerlediğinde diverged olduğu için merge edilmeden superseded kapatıldı.
- CURRENT MAIN / LINEAGE: fresh base/merge-base `840e68256965a51681d4469c7d14c50d8c26469f`; branch ilk product checkpoint'te 2 ahead / 0 behind. Eski branch tree'si taşınmadı; yalnız current main'de bulunmayan doğrulanmış GIS blob'ları seçici reapplike edildi.
- KAPSAM / GATE: ilk fresh-main checkpoint 820 additions / 0 deletions / 5 GIS files. Mandatory >=4,000 additions gate açık; merge yasak ve aynı PR gerçek yüksek öncelikli GIS kapsamıyla büyütülecek.
- GIS MODERNİZASYONU: `ArcGisProjectionWorkLifecyclePolicy` projection queue/running/ready authority'sini deterministic intent scheduling, per-view/global cardinality, point/byte residency, WKID canonicalization, revision watermark, stale/late rejection, TTL/lease ve teardown ile bounded tutar. Spatial query, identify ve proximity policy'leri de current main üzerinde yeniden seçici olarak korunmuştur.
- DATA INTEGRITY / SECURITY: coordinate/Geometry/Graphic/FeatureSet/worker/credential/AbortController payload graph'ları authority state'inde tutulmaz; malformed identifier/WKID/non-finite time ve stale revision fail-closed davranır.
- NETWORK / SERVİSLER / İKON: yeni endpoint, browser transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi; doğrulanmış ArcGIS REST ve shared deterministic icon standardı korunur.
- TEST / CI: superseded #437 exact head `ce1001299d72ba904d340711e360dacc8e658ec5` için Platform Architecture Audit `36972994242` ve Release QA `36972994286` completed+success idi. Fresh #443 head yeni CI üretmelidir; current-head PASS ancak exact-head workflow'ları completed+success olduğunda ilan edilir.
- PERFORMANCE REVIEW: projection/spatial/identify/proximity work authority scalar ve bounded; queue/residency limitleri CPU/memory pressure'ı sınırlar, ağır SDK payload retention ve yeni network/GPU yükü eklenmez.
- MERGE DURUMU: additions gate açık; PR draft/open bırakılır ve merge yapılmaz.
- SONRAKİ GÖREV NOTU: exact-head CI ve fresh-main lineage doğrula; #443 üzerinde edit-validation test+authority, service-adapter integrity ve spatial execution backlog ile >=4,000 meaningful additions'a ilerle.

## Deep Experience / adaptive workspace shell fresh-main checkpoint — PR #439 — 2026-10-02
- TUR / GÖREV: Deep Experience / Whole-Code Modernization; aktif harita sayfasının tamamında strict-TypeScript shell state authority, responsive placement/density, keyboard landmark navigation, bounded session preference ve accessibility davranışlarını current-main lineage üzerinde modernize etme.
- BRANCH / PR: `agent/experience-shell-20261002-0920-5bb6567`; PR #439 kanonik Experience PR'ıdır. Stale/diverged #435 ve #436 superseded olarak kapatıldı ve merge edilmedi.
- CURRENT MAIN / LINEAGE: fresh base/merge-base `5bb65675e3d45a15bbef29a5e4a0091a66b566f0`; product head `67dfb1282f6e5e3178a5fbc6406ff1649f488f02` current main'e göre 1 ahead / 0 behind. Stale #436 commit zinciri taşınmadı; yalnız latest doğrulanmış Experience tree current-main üzerine seçici olarak reapplike edildi.
- KAPSAM / GATE: product head'de 23 Experience dosyası, 4,111 meaningful additions / 2 deletions. Mandatory >=4,000 additions gate gerçek App mount, shell model/runtime/component ve regression kapsamıyla karşılandı.
- EXPERIENCE MODERNİZASYONU: gerçek `App` içine adaptive workspace shell mount edildi; map / üst gezinme / global arama / sidebar / toolbar landmark'ları deterministik hale getirildi; F6 / Shift+F6 editable-safe bounded focus cycle, collision-aware placement, full/compact/status-only density policy ve late-landmark transition davranışı eklendi.
