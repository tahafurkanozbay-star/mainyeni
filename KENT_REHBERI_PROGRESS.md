# Kent Rehberi — Geliştirme İlerleme Kaydı

## Başlangıç Durumu
- Ortak agent kuralları repository'ye eklendi.
- Ana kural dosyası: `KENT_REHBERI_AGENT_RULES.md`
- Görev sırası: Architecture / Platform → UI/UX → 2D/3D GIS + Spatial Engine → GIS Data/Services → Search/Address → Performance → Security → Accessibility/Responsive → Testing/Observability → Final QA/Release

## Platform / GIS geçmişi
- Platform Tur 2: local `.env` ignore, `.env.example`, same-origin API yaklaşımı, client-key/debug/source-map risklerinin azaltılması.
- GIS Engine Tur 2-3: `serviceRegistry.js`, `iconResolver.js`, `serviceCatalog.js`, `layerRuntime.js`, `spatialEngine.js`; backend-owned service configuration; ArcGIS REST/MapServer/FeatureServer/VectorTile/Image/Scene destekleri; WMS/WFS/WMTS/OGC varyantları reddediliyor.
- PR #2 merge commit: `1140467cfe88e73f5fdae1fd112f1862949d0d12`.
- Experience PR #6 squash-merge commit: `cdde26bc997e7d1b7c28f668412ab3087607d316`.

## Deep Data / Search / Address Tur — 2026-09-15
- Çalışma branch: `agent/data-search-20260915`.
- Repository root, `Webclient.app/src` ağacı, search business katmanı ve GIS query helper incelendi.
- `FastAccessQueryBusiness.js` içindeki doğrudan string birleştirmeli `ObjectId` ve `adi LIKE` filtreleri normalize edildi. Numeric ObjectId yalnız finite number ise sorguya ekleniyor; text literal içindeki tek tırnaklar ArcGIS SQL literal kurallarına göre iki tırnakla escape ediliyor.
- `FulltextSearchQueryBusiness.js` içindeki `searchText`, `districtId`, `nbhoodId` ve numeric `Id` filtreleri merkezi builder'lara taşındı. Boş/whitespace aramalar gereksiz LIKE üretmiyor; ilçe/mahalle değerleri escape ediliyor; numeric ID doğrulanıyor.
- Promise-constructor anti-pattern kaldırıldı. Business katmanı artık doğrudan async/await ile `GisQueryHelper` sonucunu döndürüyor; servis bulunamadığında erken reject ediyor.
- Nearby query davranışı korundu; negatif/NaN buffer mesafesi normalize edilerek sıfır altına düşmesi engellendi. Mevcut `bufferDistance * 100` sözleşmesi davranış uyumluluğu için değiştirilmedi; birim semantiği sonraki turda gerçek caller/config verisiyle doğrulanmalı.
- `GisQueryHelper.js` içindeki kullanılmayan React/Component ve DebugHelper importları kaldırıldı. Query yürütme tek async helper'da toplandı; `loadModules` veya `queryTask.execute` rejection artık servis-result error yapısına dönüyor. Feature/fields null durumları güvenli varsayılanlarla normalize ediliyor.
- WMS/WFS veya varsayımsal endpoint eklenmedi. Mevcut ArcGIS QueryTask sözleşmesi korundu.

### Veri bütünlüğü / güvenlik
- Search text ve string ID alanlarında quote kırılması / sorgu ifadesi bozulması riski azaltıldı.
- Numeric identifier alanları finite-number doğrulamasına alındı.
- Null/undefined/empty search değerleri deterministic ele alınıyor.
- Search sonuç şekli `{type,data,fields}` korunuyor; Fulltext `QueryService` için mevcut `{Title,Data}` adapter sözleşmesi korunuyor.

### Test / build / doğrulama
- Connector runtime doğrudan Node/npm shell çalıştırmadığı için lokal `npm test`, lint, typecheck ve build çalıştırılamadı.
- Değişiklikler import/syntax ve caller sözleşmeleri açısından kaynak seviyesinde ikinci kez kontrol edildi.
- CI sonucu PR açıldıktan sonra GitHub Actions üzerinden izlenmeli.
- Bu tur 4.000 satır yapay boilerplate ile zorlanmadı: yüksek etkili search hardening dar ve kontrollü tutuldu. Sonraki turda adres/geocoding caller'ları, JSON icon record mapping ve pagination/cancellation/cache yüzeyleri genişletilmeli.

### Sonraki Data/Search başlangıcı
- `FulltextSearchQueryBusiness`, `FastAccessQueryBusiness` caller componentlerini ve gerçek query object shape'lerini çıkar.
- `bufferDistance * 100` dönüşümünün UI/config birimini doğrula; gerekiyorsa tek shared distance normalizer oluştur.
- Adres/coordinate/geocoding business dosyalarını ve backend endpointlerini envanterle; gerçek endpoint dışında servis ekleme.
- Search request cancellation/debounce/deduplication için UI → business → GIS helper zincirini incele.
- Result table/list/card record shape'lerini `gis-engine/iconRegistry.json` shared resolver ile bağla; ikinci mapping authority üretme.
- Büyük sonuç setlerinde pagination/resultRecordCount ve mümkünse server-side limit sözleşmesini gerçek servis capability verisiyle doğrula.

## Kurallar
- Çalışan davranışlar korunur; WMS/WFS eklenmez; gerçek servis ve response şeması incelenmeden endpoint varsayılmaz.
- Browser Network panelinin tamamen gizlenemeyeceği kabul edilir; güvenlik server-side authorization, least privilege ve data minimization ile kurulur.
