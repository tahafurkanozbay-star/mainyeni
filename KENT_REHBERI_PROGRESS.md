# Kent Rehberi — Geliştirme İlerleme Kaydı

## Başlangıç Durumu
- Ortak agent kuralları repository'ye eklendi.
- Ana kural dosyası: `KENT_REHBERI_AGENT_RULES.md`
- Görev sırası: Architecture / Platform → UI/UX → 2D/3D GIS + Spatial Engine → GIS Data/Services → Search/Address → Performance → Security → Accessibility/Responsive → Testing/Observability → Final QA/Release

## Platform / GIS geçmişi
- Platform Tur 2: local `.env` ignore, `.env.example`, same-origin API yaklaşımı, client-key/debug/source-map risklerinin azaltılması.
- GIS Engine Tur 2-3: `serviceRegistry.js`, `iconResolver.js`, `serviceCatalog.js`, `layerRuntime.js`, `spatialEngine.js`; backend-owned service configuration; ArcGIS REST/MapServer/FeatureServer/VectorTile/Image/Scene destekleri; WMS/WFS/WMTS/OGC varyantları reddediliyor.
- PR #2 merge commit: `1140467cfe88e73f5fdae1fd112f1862949d0d12`.
- Sonraki GIS çalışmasında `iconRegistry.json`, `iconPresentation.js`, `sceneRuntime.js`, shared 2D/3D view-state ve icon registry testleri main üzerinde ilerledi.

## Experience/UI Quality önceki tur
- PR #4 squash-merge edildi.
- Merge commit: `06463c64ea02d6a2d99c3e504f7e66c55fc0e138`.
- İlk Experience turu token tabanlı surface/focus, responsive desktop/tablet/mobile, dark/light, reduced-motion, forced-colors, utility rail, command center ve loading/error/empty primitives oluşturdu.
- WMS/WFS eklenmedi; yeni remote UI font/CDN/analytics/asset çağrısı eklenmedi.

## Deep Experience/UI Quality Tur — 2026-09-15
- Amaç: mevcut Kent Rehberi'ni ekran ve bileşen düzeyinde derin UX/UI kalite denetiminden geçirip enterprise GIS seviyesinde tutarlı, hızlı, erişilebilir ve yüksek veri yoğunluğuna uygun bir deneyim oluşturmak.
- Başlangıç main HEAD: `71d8d54f9bae4e8ce8ee740aabee56cf5d6f203f`.
- Çalışma branch: `agent/experience-ui-deep-2026-09-15`.
- PR #6 gerçek olarak merge edilebilir durumda doğrulandı ve squash-merge edildi.
- Merge commit: `cdde26bc997e7d1b7c28f668412ab3087607d316`.

### İncelenen yüzeyler
- `App.js` global shell ve config loading
- `NavigationBar.js/.css` header, global search, command shortcut
- Sidebar / query-window shell
- `ToolbarWidget.css` map tool chrome
- `LayerListWidget.js/.css` layer tree, visibility, opacity, legend
- `GenelAramaQeryWindow.js` search results
- shared loading/error/empty primitives
- ArcGIS popup surface CSS
- Experience utility rail + keyboard help + command center
- responsive/mobile/tablet/desktop CSS ve touch targets
- shared GIS icon resolver/presentation
- 3D `sceneRuntime.js` ve mevcut 3D entrypoint durumu

### Design-system çıkarımı
- Spacing: 4px tabanlı `4/8/12/16/20/24/32` ritmi.
- Kontroller: desktop yaklaşık 40px; touch target en az 44px.
- Radius: control 8px, card 12px, panel 14-16px, dialog 16-18px, pill 999px.
- Typography: page title 20-28px, section 15px, body/control 12-13px, meta 10-11px.
- Surface modeli: background → surface → secondary/tertiary surface; ince border + düşük elevation; modal/drawer en güçlü elevation.
- Focus: yalnız renge bağlı olmayan görünür focus ring.
- Motion: ölçülü background/border/transform/opacity; reduced-motion altında animasyonlar kapatılıyor.
- Responsive: 1100 / 900 / 780 / 680 / 520 / 420px kademeleriyle grid, toolbar, panel, drawer ve command palette davranışı.
- Tema: ExperienceThemeProvider + `data-experience-theme`; NavigationBar eski dinamik light stylesheet üretmiyor.

### Yüksek öncelikli UX düzeltmeleri
- Header search state string/object karmaşası kaldırıldı; semantik `form role=search`, Enter submit ve Escape davranışı eklendi.
- Utility rail gerçek LayerList lifecycle'ına bağlandı; `layers` ve `legend` komutları gerçek `activeTab` ile işliyor.
- Layer tree görünürlük kontrolleri semantic button + `aria-pressed` oldu; stable keys kullanılıyor.
- Layer opacity slider erişilebilir etiketlerle 0-100 aralığında çalışıyor.
- Search results artık loading / success / empty / error+retry durumlarını açık biçimde gösteriyor.
- ArcGIS popup ve query-window yüzeyleri ortak enterprise tokenlarına getirildi.
- Shared loading katmanı GIF yerine CSS spinner kullanıyor; `role=status`, `aria-busy` vb. semantics eklendi.
- Global focus, touch target, forced-colors ve reduced-motion sözleşmesi legacy kontrolleri kapsayacak biçimde güçlendirildi.

### İkon mimarisi
- Gerçek `Webclient.app/src/gis-engine/iconRegistry.json` bulundu ve `iconPresentation.js` zinciri doğrulandı.
- UI tarafında ikinci GIS icon mapping authority oluşturulmadı.
- `SharedGISIcon.js`, `createListIconModel()` üzerinden ortak JSON resolver'ı kullanıyor.
- Layer group/layer ve dinamik layer yüzeyleri aynı resolver ile icon gösteriyor.
- Unknown/broken icon için registry default + yerel `pictureMarker.png` fallback kullanılıyor.
- Aynı resolver zinciri 2D picture-marker ve 3D graphic model sözleşmesiyle paylaşılabiliyor.

### 3D
- `sceneRuntime.js` mevcut: SceneView oluşturma, lazy module cache, ground, picking, camera/selection sync, bookmark ve measurement contract içeriyor.
- Kullanıcıya dönük 3D shell entrypoint'i mevcut UI içinde net olmadığı için bu UI turu yeni bir paralel 3D ekran icat etmedi; tasarım sistemi 2D/3D parity için ortak sözleşme sağlıyor.

### Network / performance
- Bu deep tur yeni remote font, CDN, analytics veya üçüncü taraf UI asset çağrısı eklemedi.
- Generic UI iconları inline SVG; GIS record iconları mevcut local JSON registry + local asset path üzerinden çözülüyor.
- Loading asset bağımlılığı CSS spinner'a taşındı.
- Search/layer/command surfaces'te gereksiz perpetual JS animation eklenmedi; DOM reconciliation için stable keys kullanıldı.
- Browser Network panelinden veri tamamen gizlenemeyeceği varsayımı korunuyor; privacy garantisi verilmedi.
- Legacy `styles.css` içinde `https://fonts.googleapis.com/css?family=Mukta` import'u halen mevcut; izole CSS cleanup sonraki iştir.

### Accessibility / responsive
- semantic header/aside/nav/form/section/dialog/button
- icon controls için accessible name
- `aria-pressed`, `aria-busy`, `role=status`, `role=alert`
- focus-visible / visible keyboard focus
- reduced-motion
- forced-colors
- 44px touch targets
- command palette keyboard navigation + active descendant
- Escape close behavior
- form/search error and retry feedback
- Desktop map-primary, tablet compact panels, mobile bottom-sheet/drawer uyarlamaları için CSS/interaction sözleşmesi
- Gerçek browser/device visual regression ve tam screen-reader smoke bu connector çalışma alanında yürütülemedi.

### Test / build
- `ExperienceUXLayer.test.js` ve `experience-quality.test.js` branch'e eklendi/güncellendi.
- `.github/workflows/webclient-quality.yml`: Node 18 + `npm ci` + `npm run lint --if-present` + `npm run typecheck --if-present` + `npm test -- --watchAll=false --runInBand` + `npm run build`.
- Lokal Node/npm bu connector ortamında mevcut değildi; lokal test/build/lint/typecheck çalıştırılamadı.
- CI workflow'u gerçek runner doğrulaması için mevcut; PR merge öncesi burada sonuç okunamadı.

### Değişiklik hacmi
- Deep Experience PR #6: 19 dosya, 895 ekleme, 1.178 silme.
- Yaklaşık 2.073 satır net anlamlı değişiklik; 4.000 satır yapay boilerplate ile zorlanmadı.

### Kalan riskler
- Legacy Google Fonts import'u kaldırılmalı; browser regression sonrası.
- `color-mix()` / `backdrop-filter` eski tarayıcı fallback'leri browser testinde doğrulanmalı.
- Full application screen-reader pass ve gerçek responsive visual regression henüz bu runtime'da yapılamadı.
- `SharedGISIcon` sonuç/table/card surfaces'e gerçek record shape erişimi olan componentlerde daha da yayılabilir.
- Açık PR #7 Platform/Architecture hardening turudur; bu Experience turunda değiştirilmemiştir.

## Son Tur Durumu
- main HEAD: `cdde26bc997e7d1b7c28f668412ab3087607d316`.
- PR #6: kapalı ve gerçekten merged.
- Açık PR #7: `feat(platform): deep security, network and runtime hardening`; merge durumu bu Experience turunda değiştirilmedi.
- WMS/WFS eklenmedi; remote font/CDN/analytics/third-party UI asset eklenmedi.

## Sonraki ekip notu
- Legacy Google Fonts import'unu browser doğrulamasıyla kaldır.
- Command center'ı mevcut `WindowManager` tool actions ile genişlet.
- `SharedGISIcon` gerçek sonuç/table/card surfaces'e yay.
- 3D shell entrypoint ve 2D↔3D geçişini GIS/engine ekibiyle ortak ele al.
- Browser visual regression + screen-reader smoke tamamla.

## Kurallar
- Çalışan davranışlar korunur; WMS/WFS eklenmez; gerçek servis ve response şeması incelenmeden endpoint varsayılmaz.
- Browser Network panelinin tamamen gizlenemeyeceği kabul edilir; güvenlik server-side authorization, least privilege ve data minimization ile kurulur.
