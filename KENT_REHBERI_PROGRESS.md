# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Önceki checkpoint/arşiv zinciri repository geçmişinde korunur.

## Deep GIS / projection + spatial + edit admission — PR #443 checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; projection, spatial-query, identify, proximity ve FeatureServer edit admission authority'lerini current-main lineage üzerinde bounded/deterministic/payload-free sürdürme.
- BRANCH / PR: `agent/gis-spatial-20261002-1007-840e682`; draft/open PR #443 kanonik GIS devam PR'ıdır.
- CURRENT MAIN / LINEAGE: base/merge-base `840e68256965a51681d4469c7d14c50d8c26469f`; edit-validation öncesi exact head `fc0c04f1fb07feb9f8c74aa25401856c17d3dadf` 3 ahead / 0 behind ve mergeable=true idi.
- GIS MODERNİZASYONU: projection/spatial-query/identify/proximity work authority'lerine ek olarak `ArcGisEditValidationPolicy` yeniden current-main tabanına seçici uygulandı. Edit admission; monotonic schema revision, advertised operation, OBJECTID/GlobalID identity, editable/nullability/default/type/string-length, geometry type, Web Mercator alias/WKID ve feature/attribute/byte/vertex bütçelerini fail-closed doğrular.
- DATA INTEGRITY / SECURITY: stale schema, duplicate client/field, unknown/non-editable field, malformed identity, non-finite scalar, geometry/SR mismatch ve oversized mutation reddedilir. Plan yalnız bounded scalar metadata taşır; Graphic/Geometry/FeatureSet/credentials/request body/AbortController tutulmaz.
- NETWORK / SERVİSLER / İKON: yeni endpoint, WMS/WFS/WMTS, browser transport, telemetry/analytics, remote asset, secret veya ikinci icon resolver eklenmedi; mevcut doğrulanmış ArcGIS REST ve shared deterministic icon authority korunur.
- TEST / CI: önceki exact head `fc0c04f1...` için Platform Architecture Audit `36977083397` ve Release QA `36977083364` completed+success. Edit-validation implementation+regression commitleri yeni exact head oluşturduğu için current-head CI yeniden tamamlanmadan PASS ilan edilmez.
- PERFORMANCE REVIEW: tüm yeni authority state bounded scalar metadata; schema/cardinality, feature/attribute/vertex/byte limitleri memory/CPU büyümesini sınırlar; ağır SDK payload retention veya yeni GPU/network yükü yoktur.
- MERGE DURUMU: mandatory >=4,000 base...head additions gate halen açık olduğundan PR draft/open kalır ve merge edilmez.
- SONRAKİ GÖREV NOTU: exact-head CI ve fresh-main lineage/mergeability doğrula; aynı #443 üzerinde service-adapter integrity ve spatial execution lifecycle backlog ile >=4,000 meaningful additions'a ilerle.

## Deep Experience / adaptive workspace shell fresh-main checkpoint — PR #439 — 2026-10-02
- Bu rol dışı paralel ekip checkpoint'i repository geçmişinde korunur; GIS turu bu alanı değiştirmez.
