# Kent Rehberi — Geliştirme İlerleme Kaydı

## Başlangıç Durumu
- Ortak agent kuralları repository'ye eklendi.
- Ana kural dosyası: `KENT_REHBERI_AGENT_RULES.md`
- Görev sırası: Architecture / Platform → UI/UX → 2D GIS + 3D GIS + Spatial Engine → GIS Data/Services → Search/Address → Performance → Security → Accessibility/Responsive → Testing/Observability → Final QA/Release

## Platform Tur 2 — 2026-09-15
- Güvenli yapılandırma temeli tamamlandı.
- `.gitignore` local environment dosyalarını ignore ediyor; `.env.example` eklendi; client key/debug/source map riskleri azaltıldı; API base same-origin `/api` oldu.

## GIS Engine Tur 2 — 2026-09-15
- `Webclient.app/src/gis-engine/serviceRegistry.js` ve `iconResolver.js` eklendi.
- Servis timeout/retry/health state ve deterministik tür/kategori ikon çözümleme temeli kuruldu.
- WMS/WFS eklenmedi.

## GIS Engine Tur 3 — 2026-09-15
- Branch: `agent/gis-engine-2026-09-15`
- PR: `#2`
- Head commit: `a32f6f2f7a66a8c14b60a322953dca4e509f8d7d`
- Merge commit: `1140467cfe88e73f5fdae1fd112f1862949d0d12`
- Merge durumu: PR #2 kapalı ve gerçekten merged.
- Eklenen dosyalar:
  - `Webclient.app/src/gis-engine/serviceCatalog.js`
  - `Webclient.app/src/gis-engine/layerRuntime.js`
  - `Webclient.app/src/gis-engine/spatialEngine.js`
- Gerçek mimari bulgusu: GIS servis kayıtları backend `GisConfigServiceOperations` üzerinden yönetiliyor; public modelde servis URL'si doğrudan gönderilmiyor, şifrelenmiş `Eg` kimliği dönüyor.
- Servis yaklaşımı: ArcGIS MapServer, FeatureServer, VectorTileServer, ImageServer, SceneServer ve ArcGIS REST tipleri tanımlandı; WMS/WFS/WMTS/OGC varyantları reddediliyor.
- Network: hard-coded yeni üçüncü taraf endpoint/CDN/analytics eklenmedi; same-origin/proxy guard mevcut.
- 2D: layer lifecycle, visibility, opacity, min/max scale ve serializable layer-tree state eklendi.
- Spatial: ArcGIS `geometryEngine` tabanlı distance, geodesic area, buffer, nearest, proximity, spatial relation, projection ve geometry query yardımcıları ile time extent/time slider ve dedupe primitive'leri eklendi.
- 3D: bu turda renderer/engine göçü yapılmadı; mevcut esri-loader/ArcGIS mimarisine uyumlu extension noktası bırakıldı.
- İkon: layer descriptor `iconKey` alanı shared resolver ile uyumlu hale getirildi; gerçek JSON ikon dosyası code-search ile bulunamadığından sahte mapping üretilmedi.
- Test/build: connector çalışma alanında Node/npm runtime olmadığı için lokal komutlar çalıştırılamadı.
- Sonraki GIS işi: `MapComponent.js` + gerçek LayerList/Identify/Measurement/Query bileşenlerine shared runtime ve resolver entegrasyonu; 2D↔3D state sync, 3D SceneView, picking/measurement ve smoke/regression testleri.

## Experience/UI Quality Tur — 2026-09-15
- İşlem: Enterprise GIS deneyim yüzeyinin çalışan React uygulamasına kontrollü uygulanması.
- Önceki UI branch'ı `agent/experience-ui-2026-09-15` üzerinde PR #3 açıldı ancak `main` ilerlediği için merge conflict oluştu; PR #3 kapatıldı ve force-push yapılmadı.
- Güncel main çalışma tabanı: `53911f83cc071ce1dbbac860e2b688bd3fda2c00`.
- Güncel branch: `agent/experience-ui-2026-09-15-r2`.
- Eklenen dosyalar:
  - `Webclient.app/src/Components/Common/ExperienceUXLayer.js`
  - `Webclient.app/src/Components/Common/experience-ui.css`
  - `Webclient.app/src/Components/Common/ExperienceUXLayer.test.js`
  - `.github/workflows/webclient-quality.yml`
- Güncellenen dosyalar:
  - `Webclient.app/src/App.js`
  - `Webclient.app/src/Core/Constants.js`
  - `KENT_REHBERI_PROGRESS.md`
- Yaklaşık değişiklik: 1,800+ anlamlı UI/UX, responsive, accessibility, test ve CI satırı/eklemesi. 4,000 satır yapay boilerplate ile zorlanmadı.
- Görsel kazanımlar: token tabanlı yüzey/border/radius/elevation/focus sistemi; modern header/search/sidebar/query/table/card/ArcGIS widget yüzeyleri; 3 breakpoint responsive tasarım; dark/light CSS token altyapısı; reduced-motion; forced-colors; daha belirgin focus state; daha tutarlı scrollbar ve form kontrolleri; düşük hareketli mikro-etkileşimler.
- Harita deneyimi: pan/harita alanını boğmayan sağ-alt utility rail; arama/katman/lejand/kısayol/tema hızlı erişimi; mevcut ArcGIS popup/layer-list yüzeyleriyle ortak tipografi ve yüzey dili.
- Erişilebilirlik: semantik aside/dialog/button kullanımı; erişilebilir adlar; Escape kapatma; klavye kısayolları; focus-visible; reduced-motion; forced-colors; renk tek başına olmayan status desenleri; screen-reader için aria-label/aria-modal/aria-labelledby.
- Tema: `THEME_CHOICE` configuration key'i tanımlandı; yeni experience katmanı ayrıca kendi tema seçimini localStorage'da saklıyor ve `data-experience-theme` üzerinden tokenları uygular.
- İkon: UI chrome için harici asset yerine inline SVG kullanıldı. GIS tür/kategori ikonları mevcut `gis-engine/iconResolver.js` üzerinden değiştirilmedi; gerçek JSON ikon kaynağı ve tüm tablo/liste/2D/3D yüzey entegrasyonu sonraki entegrasyon işidir.
- Network: bu tur yeni remote font/CDN/analytics/3rd-party asset isteği eklenmedi. Experience katmanı browser içi localStorage ve `CustomEvent` command bridge kullanıyor. Browser Network verisinin tamamen gizlenemeyeceği kabul ediliyor.
- WMS/WFS: yeni WMS/WFS UI, seçim veya entegrasyon eklenmedi.
- Test: `ExperienceUXLayer.test.js` ile hızlı erişim, tema persistence, Escape dialog davranışı ve command event testleri eklendi.
- CI: `Webclient Quality` workflow'u Node 18 ile `npm ci`, `npm run lint --if-present`, `npm run typecheck --if-present`, `npm test -- --watchAll=false --runInBand`, `npm run build` çalıştıracak şekilde eklendi.
- Merge: PR #3 merge edilmedi; çatışma nedeniyle kapatıldı. r2 için yeni PR açılacak ve güncel main ile mergeability yeniden doğrulanacak.

## GIS Engine Deep Performance Tur — 2026-09-15
- Branch: `agent/gis-engine-perf-2026-09-15`
- PR: `#5` — `feat(gis): deepen 2d 3d spatial runtime`
- İlk head: `61f3c37a6d36151ad76853264a525a2d7497a959`; progress/son düzeltmeler sonrası head: `f6f3f7852ddc819dc3ce32d7eca97a5648e460e3`.
- PR #5 bu kayıt sırasında açık, merge edilmemiş ve GitHub tarafından `mergeable=false` raporlanıyor.
- Gerçek servis fixture'ı `_docs/configservices.csv`: Ankara planaski `mobilServis/adresSorgu/MapServer/*`, `poiCluster/MapServer/*`, `afetCluster/MapServer/0`; ABB `poi/MapServer/*`, `etkinlik/MapServer/*`, `kultur/MapServer/*`; GeometryServer bulundu.
- Public servis DTO'su gerçek URL yerine şifrelenmiş `Eg` proxy kimliği döndürüyor.
- 2D ana giriş: `MapComponent.js` + ArcGIS `MapView`/`esri-loader`; sorgu: `GisQueryHelper`; proxy/layer creation: `CommonBusiness`; ortak state: `MapManager`.
- `ParklarQueryWindow` gibi akışlarda `map.removeAll()` tespit edildi; operasyonel katman kaybı riski nedeniyle sonraki entegrasyon işidir.
- Gerçek SceneView/SceneServer entrypoint bulunmadı; sahte 3D endpoint eklenmedi.

### Yapılanlar
- `gis-engine/iconRegistry.json`: gerçek mevcut SVG/PNG asset path'lerinden ortak registry; ABB/ASKİ/EGO/iştirakler + default fallback.
- `iconResolver.js`: case/diacritic/ayraç normalize ve `onFallback` telemetry hook.
- `iconPresentation.js`: table/list, 2D picture-marker, 3D billboard/label için ortak presentation API.
- `queryClient.js`: TTL cache, in-flight dedupe, cancellation, stable query key, 2000 feature/100 field cap, invalidation/stats.
- `Toolbox/GisQueryHelper.js`: legacy response contract korunarak shared query runtime'a yönlendirildi.
- `networkPolicy.js`: browser direct remote GIS endpoint guard; same-origin veya server-owned `.gissrv.org` alias; remote yalnızca explicit allowlist ile.
- `layerFactory.js`: MapServer, FeatureServer, VectorTileServer, ImageServer, SceneServer için ortak ArcGIS 2D/3D layer factory, ortak görünürlük/opacity/scale ve cluster/lifecycle yardımcıları.
- `sceneRuntime.js`: ArcGIS SceneView runtime, picking, camera/selection sync, bookmarks ve measurement contract; implicit remote basemap/ground çağrısı yok. Picking ScreenPoint düzeltildi.
- `viewState.js`: 2D↔3D ortak camera/selection/time/basemap state, shareable URL query ve immutable bridge.
- `runtimeRegression.test.js`, `iconRegistry.test.js`: layer tree/lifecycle/scale/share-state/service-type/icon regression coverage.
- `Api.User/Controllers/Extensions/Gis/GisProxyController.cs`: proxy hedef/method doğrulama, daha kontrollü hata/response davranışı ve basemap servis resolution bug fix. Not: bu dosyada kapsamlı rewrite yapıldı; sonraki review'da mevcut çalışan davranışla satır-satır karşılaştırılmalı.
- `Webclient.app/src/gis-engine/README.md`: engine sınırları belgelendi.

### 2D
- Layer lifecycle: `idle/loading/ready/empty/error/disabled`.
- Visibility, opacity, min/max scale state ve serializable layer tree.
- ArcGIS scale semantics test ile sabitlendi.
- Shared Feature query cache/dedupe/cancellation.
- Transfer limit ve büyük sonuçlar için bounded result policy.
- Point FeatureLayer için cluster optimization.
- URL ile paylaşılabilir 2D/3D durum sözleşmesi.
- Mevcut `CommonBusiness.CreateLayer` içindeki legacy WMS desteği kaldırılmadı; bu turda yeni WMS/WFS entegrasyonu yok.

### 3D
- Mevcut ArcGIS/esri-loader mimarisinden ayrılmadan SceneView extension runtime.
- SceneLayer/FeatureLayer/MapImageLayer/VectorTileLayer factory desteği.
- Picking → shared selection state → callback zinciri.
- Camera heading/tilt/scale state bridge.
- Scene bookmark ve measurement contract.
- Implicit ArcGIS Online basemap/terrain çağrısı yok; gerçek server-managed 3D configuration bekleniyor.
- Gerçek SceneServer/3D Tiles/GLB fixture bulunmadığından gerçek olmayan URL eklenmedi.

### Spatial intelligence
- Mevcut `spatialEngine.js` ile buffer, nearest, proximity, spatial relation, projection ve time extent/time slider sözleşmesi korunuyor.
- Geocoding için yeni üçüncü taraf endpoint eklenmedi; mevcut backend Search/Address contract'ına sonraki turda bağlanmalı.
- Raster NDVI/EVI için varsayımsal servis eklenmedi; gerçek repository raster kaynağı doğrulanınca adapter eklenebilir.

### İkon
- Gerçek repository asset path'leri ile ortak registry oluşturuldu.
- Eşleştirme sırası `type → category → kind → className → iconKey → id`.
- Türkçe diakritik/case/ayraç normalize ediliyor.
- Unknown için `default` fallback ve telemetry hook mevcut.
- 2D/3D/table için tek presentation API var; tüm legacy ekran migration'ı henüz tamamlanmadı.

### Network / güvenlik / performans
- Yeni CDN, remote font, analytics veya üçüncü taraf GIS/data endpoint yok.
- Browser query runtime server-owned same-origin/proxy endpoint politikasını uyguluyor.
- `.gissrv.org` yalnızca mevcut server-side alias mekanizması olarak kabul ediliyor.
- TTL cache + in-flight dedupe + AbortSignal race + module promise cache ile tekrar ağ/başlatma maliyeti azaltıldı.
- Browser Network panelinden veri gizleme varsayımı yapılmıyor; auth/server-side least privilege/data minimization esas.

### Test / CI
- `.github/workflows/webclient-quality.yml`: Node 18 + `npm ci` + optional lint/typecheck + Jest + production build.
- GitHub Actions run `34955127344`, head `61f3c37...`, bu kayıt içinde hâlâ `queued`; job `104335237625` da `queued`. Bu nedenle test/build sonucu başarı diye raporlanmıyor.
- `acbae...` progress commit'i workflow path-filter nedeniyle yeni run oluşturmadı; `f6f3...` SceneView düzeltmesinden sonra yeni push run'ı ayrıca doğrulanmalı.
- Lokal repo checkout'ta Node/npm çalıştırma bu connector oturumunda mümkün olmadı.

### Merge / release
- PR #5 açık, base `main`, head branch `agent/gis-engine-perf-2026-09-15`.
- Son doğrulamada PR `mergeable=false`, `merged=false`.
- CI tamamlanmadan merge yapılmadı.

### Sonraki ekip için net görevler
1. CI run sonucunu al; fail ise gerçek job log'una göre düzelt, testleri yeniden çalıştır.
2. `GisProxyController.cs` rewrite'ını önceki çalışan sürümle satır-satır karşılaştır; mümkünse yalnızca basemap bug fix + güvenli minimal validation bırak.
3. `MapComponent.js` ve gerçek LayerList/Identify/Measurement/popup/result-table akışlarını shared layer/query/icon runtime'a kontrollü bağla.
4. `map.removeAll()` kullanan query ekranlarını mevcut operational layer registry'yi koruyacak şekilde değiştir.
5. `iconPresentation.js`i merkezi result/table ve gerçek 2D marker üreticisine bağla; 3D renderer geldiğinde aynı registry'yi tüket.
6. Gerçek 3D server-managed configuration yoksa sahte terrain/3DTiles/GLB endpointi ekleme.
7. PR #5 mergeability + CI başarı sonrası merge et; merge SHA ve `main` head'ini tekrar doğrula.
8. Bir sonraki turda gerçek browser GIS smoke/regression yapılmalı: basemap, layer toggle, query, identify/popup, measurement, 2D↔3D state, large point cluster ve network request sayısı.

## Kurallar
- Çalışan davranışlar korunur; WMS/WFS eklenmez; gerçek servis ve response şeması incelenmeden endpoint varsayılmaz.
- Browser Network panelinin tamamen gizlenemeyeceği kabul edilir; güvenlik server-side authorization, least privilege ve data minimization ile kurulur.
