# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Bu checkpoint öncesindeki tam canonical progress sürümü [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261002_PRE_PR424.md`](./KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261002_PRE_PR424.md) içinde aynı Git blob SHA ile korunur; önceki arşiv zinciri de oradan erişilebilir.

## Deep GIS / PR #429 fresh-main reconciliation checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; spatial-query, identify, proximity ve FeatureServer edit-validation authority.
- BRANCH / PR: `agent/gis-spatial-20261002-0508-f6451b4`; draft/open PR #429 kanonik GIS devam PR'ıdır.
- CURRENT MAIN / LINEAGE: current main/merge-base `64a120515c05e7c9c041e79fff45c907bb9758f8`; branch reconciliation sonrası behind=0. Main'in Measurement ve Data/Search değişiklikleri korunmuştur.
- KAPSAM / GATE: reconciliation öncesi product scope 2,019 additions / 13 deletions / 9 changed files. Mandatory >=4,000 additions gate açık; merge yasak.
- GIS MODERNİZASYONU: `ArcGisSpatialQueryLifecyclePolicy`, `ArcGisIdentifyBatchLifecyclePolicy`, `ArcGisProximityAnalysisLifecyclePolicy` ve `ArcGisEditValidationPolicy` bounded deterministic payload-free authority sağlar. Edit validation OBJECTID/GlobalID identity, monotonic schema revision, editable/nullability/default/type/string-length, Web Mercator alias/WKID, geometry type ve feature/attribute/byte/vertex bütçelerini fail-closed uygular.
- DATA INTEGRITY / SECURITY: stale revision, duplicate identity, undeclared/non-editable mutation, malformed GUID/object id, type mismatch, NaN/Infinity, oversized values/vertices ve SR mismatch reddedilir. Graphic/Geometry/FeatureSet/credential/request body/AbortController tutulmaz.
- NETWORK / SERVİSLER / İKON: yeni endpoint, browser transport, WMS/WFS/WMTS, telemetry, remote asset, secret veya ikinci icon resolver yok; mevcut ArcGIS REST ve shared deterministic icon authority korunur.
- TEST / CI: reconciliation öncesi exact head `5b93425f7ffec28c6b5a8d4d8d57f37936e094e5` için Platform Architecture Audit `36966449624` ve Release QA `36966449631` completed+success. Reconciliation/progress yeni exact head ürettiği için CI yeniden doğrulanacaktır.
- PERFORMANCE REVIEW: yeni authority state cardinality/byte/vertex/lease sınırlarıyla bounded; ağır SDK/payload graph retention yok.
- MERGE DURUMU: additions gate açık; PR draft/open kalır.
- SONRAKİ GÖREV NOTU: exact-head CI doğrula; aynı PR üzerinde projection/service-adapter integrity backlog ile >=4,000 meaningful additions'a ilerle.

## Deep GIS / governed scene residency and visibility transitions — PR #424 gate checkpoint — 2026-10-02
- TUR / GÖREV: Deep GIS / Whole-Code Modernization; ArcGIS runtime lifecycle, scene prefetch, labeling ve layer visibility transition authority'lerini bounded/deterministic/payload-free hale getirme.
- BRANCH / PR: `agent/gis-spatial-20261001-1915-83d845f`; PR #424 kanonik GIS PR'ıdır. Gate product head `8faa9360d1e4195e220ff259ead88fb0a3f41303`.
- KAPSAM / GATE: 4,118 additions / 41 deletions; mandatory gate karşılandı ve squash merge SHA `f6451b40586e35ceba167ee3ef162173f132edc1`.

## Deep Experience / governed measurement fresh-main reconciliation — PR #430 gate checkpoint — 2026-10-02
- TUR / GÖREV: Deep Experience / Whole-Code Modernization; Measurement UI, state/controller, runtime resilience, responsive ve accessibility davranışlarını current-main lineage üzerinde reconcile etme.
- BRANCH / PR: `agent/experience-measurement-20261002-0525-f6451b4`; PR #430 kanonik Experience PR'ıdır.
- KAPSAM / GATE: product head'de 12 Measurement files, 4,110 meaningful additions / 169 deletions. Mandatory >=4,000 additions gate gerçek UI/controller/model/runtime ve adversarial regression kapsamıyla karşılandı.
- EXPERIENCE MODERNİZASYONU: semantic status/guidance/recovery UI, keyboard/pointer modality, bounded activity history, retry policy, responsive/coarse-pointer ergonomics, focus-visible, reduced-motion ve forced-colors davranışları fresh main'e seçici blob transplant ile taşındı.
- NETWORK / SERVİSLER / İKON: yeni endpoint, WMS/WFS UI, analytics/telemetry, remote font/CDN, ağır asset veya ikinci icon resolver eklenmedi.
- ACCESSIBILITY / RESPONSIVE: semantic headings/status/alert/group, screen-reader labels, keyboard operability, logical focus, coarse-pointer touch targets, reduced-motion ve forced-colors guardrail'leri kapsamda.
- MERGE DURUMU: additions gate karşılandı; exact-head CI tamamlanmadan merge yok.

## Deep Data / Search / Address — typo-tolerant recovery v8 merge closure — PR #404 — 2026-10-02
- TUR / GÖREV: Deep Data / Search / Address / Whole-Code Modernization; bounded fuzzy lexicon, scoped synonym governance, grammar-safe query correction ve original-first recovery orchestration.
- KANONİK #59 DOĞRULAMASI: PR #59 `closed+merged`; final head `fa959fe46b86abc9c215165d15c443fafe430c58`, 5,290 additions / 9 deletions, squash merge SHA `906b9bd3e9eb19318ef34f7a10b22a8c077cfb13`.
- BRANCH / PR: `agent/data-search-v8-20260930-1314-ace96e5`; PR #404 final exact head `19693a73d1fb4827a2a71bdb7c45a54955e3b24e`.
- KAPSAM / GATE: final PR 10 Data/Search dosyası, 4,357 meaningful additions / 0 deletions; mandatory >=4,000 additions gate sağlandı.
- DATA / SEARCH DÜZELTMELERİ: fuzzy source provenance ayraçları korundu; synonym group ID'leri kanonik ayraçlı biçimde tutuldu; correction kapalıyken typo'nun synonym fallback'e kaçması engellendi; correction sonrası synonym chaining default-off/explicit opt-in yapıldı; recovery attempt budget explicit `maxAttempts` kontratına taşındı.
- BÜTÜNLÜK / GÜVENLİK: mevcut v6 grammar/relevance, v7 registry/cache/session ve immutable DatasetSnapshot authority'leri korunur. Yeni endpoint, browser transport, WMS/WFS/WMTS, telemetry/analytics, remote asset, secret veya ikinci icon authority eklenmedi.
- FINAL CI: exact head `19693a73d1fb4827a2a71bdb7c45a54955e3b24e` için Webclient Quality `36967324105`, Release QA `36967324101`, Platform Architecture Audit `36967324100` ve Typed Source Boundary `36967324107` tamamı `completed+success`.
- MERGE: expected head kilidiyle squash merge edildi; merge SHA `324ba32d077700e74681b547c0e18687033b86d8` ve current main ancestry'sinde korunuyor.
