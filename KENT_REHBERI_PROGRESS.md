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
- CI: `Webclient Quality` workflow'u Node 18 ile `npm ci`, `npm run lint --if-present`, `npm run typecheck --if-present`, `npm test -- --watchAll=false --runInBand`, `npm run build` çalıştıracak şekilde eklendi. Mevcut `package.json` doğrudan `lint` veya `typecheck` script'i tanımlamıyor; bu nedenle bu iki aşama `--if-present` ile bilinçli olarak opsiyonel.
- CI durumu: PR #3'ün eski workflow run'ı `34954221529` bu çalışma sırasında tamamlanmamıştı. Yeni r2 branch'ı için PR/CI sonucu bu kayıt güncellenmeden önce henüz yok.
- Build/lint/typecheck: connector üzerinde lokal Node/npm çalıştırma yok; bu nedenle lokal doğrulama yapılamadı.
- Bilinen riskler: `color-mix()` ve `backdrop-filter` gibi modern CSS özellikleri eski tarayıcılarda fallback gerektirebilir; Bootstrap/ArcGIS selector çakışmaları gerçek browser smoke ile kontrol edilmeli. Utility command bridge henüz NavigationBar/LayerList gerçek action handlerlarına doğrudan bağlı değil.
- Merge: PR #3 merge edilmedi; çatışma nedeniyle kapatıldı. r2 için yeni PR açılacak ve güncel main ile mergeability yeniden doğrulanacak.

## Sonraki Ekip Notu
- Utility command bridge'i mevcut `WindowManager`/NavigationBar/LayerList/Legend handlerlarına doğrudan bağla.
- Gerçek JSON icon kaynağını bulup `iconResolver`ı table/list/2D marker/3D renderer ile ortak kullan.
- Browser responsive/görsel regresyon smoke yap; CI test/build sonucunu kayda geçir.
- Tema state'ini NavigationBar ile tek kaynağa indir ve legacy light stylesheet ile çakışmayı kontrol et.

## Kurallar
- Çalışan davranışlar korunur; WMS/WFS eklenmez; gerçek servis ve response şeması incelenmeden endpoint varsayılmaz.
- Browser Network panelinin tamamen gizlenemeyeceği kabul edilir; güvenlik server-side authorization, least privilege ve data minimization ile kurulur.
