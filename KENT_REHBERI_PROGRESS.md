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
- Gerçek mimari bulgusu: GIS servis kayıtları backend `GisConfigServiceOperations` üzerinden yönetiliyor; public modelde servis URL'si doğrudan gönderilmiyor, şifrelenmiş `Eg` kimliği dönüyor. Varsayımsal dış servis URL'si eklenmedi.
- Servis yaklaşımı: ArcGIS MapServer, FeatureServer, VectorTileServer, ImageServer, SceneServer ve ArcGIS REST tipleri tanımlandı; WMS/WFS/WMTS/OGC varyantları reddediliyor.
- Network: hard-coded yeni üçüncü taraf endpoint/CDN/analytics eklenmedi; same-origin/proxy guard mevcut.
- 2D: layer lifecycle, visibility, opacity, min/max scale ve serializable layer-tree state eklendi.
- Spatial: ArcGIS `geometryEngine` tabanlı distance, geodesic area, buffer, nearest, proximity, spatial relation, projection ve geometry query yardımcıları ile time extent/time slider ve dedupe primitive'leri eklendi.
- 3D: bu turda renderer/engine göçü yapılmadı; mevcut esri-loader/ArcGIS mimarisine uyumlu extension noktası bırakıldı. 3D SceneView/picking/measurement entegrasyonu sonraki turdur.
- İkon: layer descriptor `iconKey` alanı shared resolver ile uyumlu hale getirildi; gerçek JSON ikon dosyası code-search ile bulunamadığından sahte mapping üretilmedi.
- Değişen kod: PR diff'i GitHub tarafında 73 ekleme / 18 silme olarak raporlandı; bilinçli olarak 4000 satırı yapay boilerplate ile doldurulmadı.
- Test/build: connector çalışma alanında Node/npm runtime olmadığı için lokal `npm test`, lint, typecheck ve build çalıştırılamadı. Bu sonuç doğrulanmamış test olarak kabul edilmemeli.
- Kalan sorunlar: gerçek ikon JSON path'i ve mevcut 3D UI entrypoint'i doğrudan bileşenlere bağlanmalı; gerçek public GIS servis envanteri runtime'da doğrulanmalı; BFF/proxy tam akışı backend tarafında ölçülmeli.
- Sonraki GIS işi: `MapComponent.js` + gerçek LayerList/Identify/Measurement/Query bileşenlerine shared runtime ve resolver entegrasyonu; 2D↔3D state sync, 3D SceneView, picking/measurement ve smoke/regression testleri.

## Kurallar
- Çalışan davranışlar korunur; WMS/WFS eklenmez; gerçek servis ve response şeması incelenmeden endpoint varsayılmaz.
- Browser Network panelinin tamamen gizlenemeyeceği kabul edilir; güvenlik server-side authorization, least privilege ve data minimization ile kurulur.
