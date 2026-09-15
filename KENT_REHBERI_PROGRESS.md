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

## Experience/UI Quality önceki turlar
- PR #4 squash-merge edildi; merge commit `06463c64ea02d6a2d99c3e504f7e66c55fc0e138`.
- PR #6 Deep Experience squash-merge edildi; merge commit `cdde26bc997e7d1b7c28f668412ab3087607d316`.
- Token tabanlı surface/focus, responsive desktop/tablet/mobile, dark/light, reduced-motion, forced-colors, utility rail, command center, loading/error/empty primitives, semantic search/layer interactions ve shared GIS icon presentation oluşturuldu.

## Kent Rehberi Deep Experience / Whole-Code Modernization — 2026-09-15

### TUR / GÖREV / BRANCH / COMMIT / PR / MERGE DURUMU
- TUR: Whole-Code Experience/UI modernization devam turu.
- GÖREV: repository genelinde aktif kullanıcı arayüzü, query-window mimarisi, browser baseline, navigation/sidebar, GIS search/result UX, lazy UI yükleme ve erişilebilirlik standardizasyonu.
- Başlangıç main HEAD: `ec38e15fd7bf346823c52032fd033f3bbb05f1ce` (Platform #10 merge sonrası).
- Branch: `agent/experience-modernization-2026-09-15-r2`.
- Branch head: `211f9acce535b8fca9cdefd26f702c9565faeae5`.
- PR: #8 `feat(ui): modernize browser baseline`.
- PR doğrulaması: base `main`, mergeable=true, branch main'e göre 118 commit ahead / 0 behind.
- CI: `Webclient Quality` run #444 (`34975156131`) completed / success.
- MERGE: PR #8 squash-merge edildi.
- Merge commit: `678267711588d98074510d3d67687ba11a340e0c`.

### ÖNEMLİ ÖZELLİKLER / WHOLE-CODE MODERNIZATION
- PR yalnız browser baseline değişikliği olarak kalmadı; repository'nin aktif Webclient Experience katmanında geniş kontrollü modernizasyon paketi içerdi.
- `Sidebar.js` yüzlerce satırlık monolitik katalog/render yükünden çıkarıldı; `SidebarCatalog.js` ile deklaratif katalog ve `SidebarModern.css` ile ayrı responsive presentation katmanı oluşturuldu.
- Query-window yükleme modeli `QueryWindowRegistry.js` + `LazyManagedWindow.js` ile merkezileştirildi; çok sayıdaki legacy query ekranı ortak managed pattern'e taşındı. Bu, ilk shell render'ında bütün query UI'larının eager yüklenmesi riskini azaltan code-splitting/lazy-loading yönüdür.
- `ExperienceCommandCenter.js` genişletildi; command/navigation yüzeyi gerçek uygulama aksiyonlarına daha yakın ortak yapıya getirildi.
- `MapComponent.js`, `NavigationBar.js` ve shell bileşenlerinde legacy/tekrarlı UI davranışları azaltıldı.
- Fulltext search, genel arama, event, EGO, address/block-parcel gibi yüksek kullanımlı ekranlar modern loading/error/empty/result semantics ve daha tutarlı CSS ile yenilendi.
- Çok sayıdaki hızlı erişim query ekranı tekrar eden yüzlerce satırlık component kopyalarından ortak managed query-window sözleşmesine geçirildi.
- Business query katmanında tekrar eden Promise/query boilerplate'i azaltıldı ve `createFastAccessQueryBusiness.js` ortak factory'si eklendi; UI interaction ile data request davranışı daha bakımı kolay hale geldi.
- Browser baseline modern evergreen/Firefox ESR hedeflerine taşındı; explicit IE9/IE11 bootstrap polyfill entrypoint baskısı kaldırıldı. Kör framework major rewrite yapılmadı; React/CRA borcu kontrollü migration konusu olarak bırakıldı.

### DEĞİŞEN DOSYALAR / YAKLAŞIK SATIR
- PR #8: 160 changed files.
- GitHub PR ölçümü: 10.442 additions / 23.768 deletions; toplam yaklaşık 34.210 satır değişim.
- Değişimin büyük kısmı anlamlı legacy query-window tekrarlarının kaldırılması, ortak runtime/component altyapısına geçiş ve gerçek ekran modernizasyonudur; boilerplate ile satır doldurma yapılmadı.
- Öne çıkan dosyalar: `App.js`, `MapComponent.js`, `NavigationBar.js`, `Sidebar.js`, `SidebarCatalog.js`, `SidebarModern.css`, `ExperienceCommandCenter.js`, `LazyManagedWindow.js/.css`, `QueryWindowRegistry.js`, `CommonBusiness.js`, fulltext/general search ve EGO query ekranları, çok sayıdaki fast-access query window, `package.json`, `webclient-quality.yml`.

### TESTLER / BUILD
- GitHub Actions `Webclient Quality` run #444 başarıyla tamamlandı.
- Workflow branch head `211f9acce535b8fca9cdefd26f702c9565faeae5` üzerinde çalıştı ve PR merge öncesi green doğrulandı.
- Quality workflow lint/typecheck-if-present, test ve production build zincirini repository sözleşmesine göre yürütüyor.
- Connector runtime içinde lokal browser/device görsel testi çalıştırılamadığı için gerçek cihaz visual regression ayrıca yapılmalıdır.

### RESPONSIVE / ACCESSIBILITY
- Sidebar ve query surfaces için modern responsive presentation ayrıştırıldı.
- Semantik search/navigation/query states, keyboard interaction, visible focus, ARIA/state feedback, reduced-motion/forced-colors ve touch-target yaklaşımı önceki Experience sözleşmesiyle korunup genişletildi.
- Tekrarlı legacy query ekranlarının ortak managed shell'e taşınması accessibility davranışının tek noktadan uygulanabilirliğini artırdı.
- Gerçek screen-reader smoke ve browser/device matrisi connector ortamında çalıştırılamadı; sonraki QA turunda zorunlu.

### NETWORK DEĞİŞİKLİKLERİ / ASSET STRATEGY
- WMS/WFS eklenmedi.
- Yeni remote font/CDN/analytics/third-party UI asset bağımlılığı eklenmedi.
- Same-origin/BFF ve Platform hardening yönü korunuyor; browser Network panelinde görünen verinin gizli sayılmadığı güvenlik modeli devam ediyor.
- `styles.css` içinde eski Google Fonts Mukta import'u main'de halen tespit edildi; font-family zincirinde Mukta kullanılmadığından kaldırılması yüksek öncelikli cleanup olarak kaldı. Bu turda green ve büyük PR merge'i sonrasında doğrulamasız ek commit ile merge paketini değiştirmemek tercih edildi.

### GÜVENLİK KONTROLLERİ
- Experience turu secret/token/client-key eklemedi.
- Harici UI endpoint veya analytics eklenmedi.
- Platform #10 sonrasında main'deki same-origin/network hardening ile çakışmamak için PR #8'in base/head durumu merge öncesi yeniden doğrulandı.
- Açık Platform #12/#13, Search #9 ve GIS #5 PR'larının sahip olduğu alanlar merge sonrasında ayrıca ezilmedi.

### İKON EŞLEŞTİRME
- İkinci GIS icon mapping sistemi oluşturulmadı.
- Mevcut `gis-engine/iconRegistry.json` + shared resolver/presentation authority korunuyor.
- Query/list UI modernizasyonu bu merkezi icon sözleşmesini değiştirmedi; 2D/list/3D parity için tek authority ilkesi devam ediyor.

### MODERNİZASYON KARARLARI
- En büyük kazanım, onlarca kopya query componentini ortak managed runtime/component yaklaşımına taşımak oldu; bakım maliyeti ve interaction drift azaltıldı.
- React/CRA major migration bu pakette körlemesine yapılmadı. Mevcut stabil davranış ve CI korunarak browser baseline modernleştirildi; framework/runtime migration ayrı ölçümlü tur olmalı.
- 21st.dev/shadcn yaklaşımından lisanslı kod kopyalamak yerine composable surface, command, lazy registry, focus/touch/responsive gibi desenler mevcut projeye adapte edildi.
- Styling pipeline tamamen Tailwind'e zorla taşınmadı; mevcut CSS ile kontrollü modern component CSS birlikte kullanıldı. Büyük styling migration ancak bundle/build/browser ölçümüyle yapılmalı.

### PERFORMANS ETKİSİ
- Query windows için lazy managed registry, başlangıç render/import baskısını azaltacak mimari sağlar.
- Sidebar monolitinin katalog/presentation ayrımı render ve bakım karmaşıklığını azaltır.
- Tekrarlı query component kodunun büyük ölçüde kaldırılması bundle/source parse yükü ve future regression yüzeyini düşürür.
- Stable/common interaction runtime, duplicated event/state logic maliyetini azaltır.
- Modern browser baseline gereksiz legacy transpilation/polyfill baskısını azaltmaya yöneliktir.

### ÇÖZÜLEN HATALAR
- Çok sayıda query ekranındaki kopya interaction/state kodu ortak sözleşmeye taşındı.
- Shell/sidebar ve command/navigation coupling azaltıldı.
- Legacy browser hedefleri modern CSS/accessibility sözleşmesiyle uyumlu hale getirildi.
- Search/query ekranlarında loading/error/empty/result durumlarının tutarlılığı iyileştirildi.

### KALAN SORUNLAR
- `Webclient.app/src/styles.css` Google Fonts Mukta import'u kaldırılmalı ve browser regression ile doğrulanmalı.
- React 17/CRA-era dependency ve build zinciri kontrollü migration planı gerektiriyor; `npm audit fix --force` gibi kırıcı otomatik upgrade yapılmamalı.
- Gerçek browser responsive visual regression, screen-reader smoke, forced-colors ve reduced-motion device/browser matrisi çalıştırılmalı.
- 2D↔3D kullanıcı entrypoint'i GIS/engine ekibiyle ortak tasarlanmalı; paralel 3D mapping/UI authority üretilmemeli.
- Açık PR #5 GIS, #9 Search, #12/#13 Platform çalışmaları merge sırası ve conflict açısından izlenmeli.

### SONRAKİ GÖREV NOTU
- Önce main ve açık PR'ların CI/merge durumunu yeniden doğrula.
- Google Fonts import'unu kaldır; kullanılan font stack'i local/system fontlarla ölç.
- React/CRA/runtime dependency envanterini çıkar; bundle/build/test ölçümü olmadan major migration yapma.
- SharedGISIcon'u gerçek record result/table/card surfaces'e merkezi resolver üzerinden yay.
- Browser visual regression + keyboard/screen-reader smoke tamamla.
- 2D↔3D control shell'i GIS engine state contract'ına bağla; ikinci state veya icon mapping sistemi oluşturma.

## Kurallar
- Çalışan davranışlar korunur; WMS/WFS eklenmez; gerçek servis ve response şeması incelenmeden endpoint varsayılmaz.
- Browser Network panelinin tamamen gizlenemeyeceği kabul edilir; güvenlik server-side authorization, least privilege ve data minimization ile kurulur.
