# Kent Rehberi — Geliştirme İlerleme Kaydı

## Başlangıç Durumu
- Ortak agent kuralları repository'ye eklendi.
- Ana kural dosyası: `KENT_REHBERI_AGENT_RULES.md`
- Görev sırası: Architecture / Platform → UI/UX → 2D GIS + 3D GIS + Spatial Engine → GIS Data/Services → Search/Address → Performance → Security → Accessibility/Responsive → Testing/Observability → Final QA/Release

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
- Branch son reconcile sonrası `main`den geride değil (`behind_by=0`); paralel GIS çalışmalarını force-push ile ezmeden ikinci parent merge commit ile korundu.

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
- Legacy `styles.css` içinde `https://fonts.googleapis.com/css?family=Mukta` import'u halen mevcut. Kaldırılması bir sonraki izole CSS cleanup işi; mevcut legacy ekranları körlemesine rewrite etmeden önce browser regression gerekir.

### Accessibility
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

### Responsive smoke yaklaşımı
- Desktop: map-primary layout; query windows viewport-safe.
- Tablet: panels narrow, toolbar compact, layer rows remain touch-safe.
- Mobile: header simplifies, query/drawer surfaces become bottom-sheet style; command center bottom aligned; layer opacity control hides while visibility remains accessible.
- Gerçek browser/device visual regression connector ortamında çalıştırılamadı; CSS/DOM smoke sözleşmesi ve interaction tests eklendi.

### Test / build
- `ExperienceUXLayer.test.js` ve `experience-quality.test.js` branch'e eklendi/güncellendi.
- `.github/workflows/webclient-quality.yml`: Node 18 + `npm ci` + `npm run lint --if-present` + `npm run typecheck --if-present` + `npm test -- --watchAll=false --runInBand` + `npm run build`.
- Lokal Node/npm bu connector ortamında mevcut değildi; dolayısıyla lokal test/build/lint/typecheck çalıştırılamadı.
- GitHub Actions ile doğrulama başlatıldı; CI sonucu bu kayıt oluşturulurken tamamlanmış kabul edilmedi.

### Değişiklik hacmi
- `compare_commits` deep branch → main sonucu 17 önemli UI/audit dosyasında değişiklik.
- Toplam yaklaşık 752 ekleme + 1.229 silme = 1.981 anlamlı satır değişimi.
- 4.000 satır yapay boilerplate ile zorlanmadı; hedef kalite ve mevcut GIS davranışını koruma lehine bilinçli olarak daha düşük tutuldu.

### Audit dokümanı
- `docs/experience-ui-deep-audit-2026-09-15.md` ayrıntılı tasarım sistemi, yüksek öncelikli sorunlar, icon architecture, network/performance, accessibility, 2D/3D durumu ve sonraki geçişleri kaydediyor.

### Kalan riskler
- Legacy Google Fonts import'u kaldırılmalı; ancak browser regression sonrası.
- `color-mix()` / `backdrop-filter` eski tarayıcı fallback'leri browser testinde doğrulanmalı.
- Full application screen-reader pass ve gerçek responsive visual regression henüz bu runtime'da yapılamadı.
- Command center daha fazla mevcut WindowManager aracıyla genişletilebilir.
- `SharedGISIcon` sonuç/table/card yüzeylerinde gerçek record shape erişimi olan componentlere yayılmalı.

## Tur Sonu / PR
- Deep branch HEAD: `9b9c390b2c083020f6adbd782a77c0b7dc0af566` (progress kaydından önceki not). Sonraki branch commitleri UI/icon/audit reconciliation için devam etti; PR head oluşturulmadan önce branch yeniden doğrulanmalıdır.
- `main` HEAD: `71d8d54f9bae4e8ce8ee740aabee56cf5d6f203f`.
- Önceki PR #4 merged; deep tur için yeni PR oluşturulacak.

## Sonraki ekip notu
- Legacy Google Fonts import'unu browser doğrulamasıyla kaldır.
- Command center'ı mevcut `WindowManager` tool actions ile genişlet.
- `SharedGISIcon` gerçek sonuç/table/card surfaces'e yay.
- 3D shell entrypoint ve 2D↔3D geçişini GIS/engine ekibiyle ortak ele al.
- Browser visual regression + screen-reader smoke tamamla.

## Kurallar
- Çalışan davranışlar korunur; WMS/WFS eklenmez; gerçek servis ve response şeması incelenmeden endpoint varsayılmaz.
- Browser Network panelinin tamamen gizlenemeyeceği kabul edilir; güvenlik server-side authorization, least privilege ve data minimization ile kurulur.
