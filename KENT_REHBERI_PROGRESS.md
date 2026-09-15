# Kent Rehberi — Geliştirme İlerleme Kaydı

## GIS Engine Deep Performance Tur — 2026-09-15
- Branch: `agent/gis-engine-perf-2026-09-15`
- PR: `#5` — `feat(gis): deepen 2d 3d spatial runtime`
- Head: `61f3c37a6d36151ad76853264a525a2d7497a959`
- WMS/WFS eklenmedi.

### Envanter
- Gerçek servis fixture'ı `_docs/configservices.csv`: Ankara planaski `mobilServis/adresSorgu/MapServer/*`, `poiCluster/MapServer/*`, `afetCluster/MapServer/0`; ABB `poi/MapServer/*`, `etkinlik/MapServer/*`, `kultur/MapServer/*`; GeometryServer bulundu.
- Public servis DTO'su gerçek URL yerine şifrelenmiş `Eg` proxy kimliği döndürüyor.
- 2D ana giriş: `MapComponent.js` + ArcGIS `MapView`/`esri-loader`; sorgu: `GisQueryHelper`; proxy/layer creation: `CommonBusiness`; ortak state: `MapManager`.
- `ParklarQueryWindow` gibi akışlarda `map.removeAll()` tespit edildi; operasyonel katmanların kaybına neden olabilecek sonraki entegrasyon konusu.
- Gerçek SceneView/SceneServer entrypoint bulunmadı; sahte 3D endpoint eklenmedi.

### Kod
- `gis-engine/iconRegistry.json`: gerçek mevcut SVG/PNG asset path'lerinden shared registry.
- `iconResolver.js`: case/diacritic/ayraç normalize + fallback telemetry hook.
- `iconPresentation.js`: table/list + 2D marker + 3D billboard/label ortak presentation.
- `queryClient.js`: TTL cache, in-flight dedupe, cancellation, stable query key, 2000 feature/100 field cap, invalidation/stats.
- `Toolbox/GisQueryHelper.js`: legacy response contract korunarak shared runtime'a yönlendirildi.
- `networkPolicy.js`: browser direct remote GIS endpoint guard; same-origin veya server-owned `.gissrv.org`; remote yalnızca explicit allowlist ile.
- `layerFactory.js`: ArcGIS MapServer/FeatureServer/VectorTileServer/ImageServer/SceneServer 2D/3D layer factory + cluster + lifecycle.
- `sceneRuntime.js`: SceneView/picking/camera/selection/bookmark/measurement contract; implicit ArcGIS Online basemap/ground çağrısı yok.
- `viewState.js`: ortak 2D/3D camera/selection/time/basemap + URL state + state bridge.
- `runtimeRegression.test.js`, `iconRegistry.test.js`: regression testleri.
- `GisProxyController.cs`: proxy hedef/method doğrulama, 502 hata modeli, basemap servis resolution bug fix.

### Doğruluk / performans
- ArcGIS `minScale` uzak/zoom-out sınırı; `maxScale` yakın/zoom-in sınırı; geçerli aralıkta `minScale > maxScale`. citeturn966964search0turn966964search2
- Point FeatureLayer cluster optimization eklendi. citeturn966964search1
- Transfer limit'li cevap cache'lenmiyor; `live=true` cache'i bypass ediyor.
- Yeni CDN/remote font/analytics/third-party endpoint yok.

### Test / CI
- Workflow `.github/workflows/webclient-quality.yml`: Node 18 + npm ci + optional lint/typecheck + Jest + production build.
- GitHub Actions run `34955127344` head `61f3c37...` ile tetiklendi; bu kayıt sırasında `queued`, başarı henüz doğrulanmadı.
- Lokal repo checkout üzerinde npm komutları bu connector oturumunda çalıştırılamadı.

### Sonraki iş
1. `MapComponent.js`, LayerList, Identify, Measurement, popup ve merkezi result/table akışlarına shared runtime + icon presentation bağla.
2. `map.removeAll()` kullanan query akışlarını layer registry korunacak şekilde düzelt.
3. Gerçek 3D config yoksa SceneView extension sözleşmesini koru; sahte servis ekleme.
4. CI run sonucunu doğrula; hata varsa düzeltip tekrar çalıştır.
5. PR #5 merge sonrası gerçek merge SHA ve `main` head'i tekrar doğrula.
6. 4000 satır hedefi yalnızca gerçek ihtiyaç oldukça büyütülmeli.
