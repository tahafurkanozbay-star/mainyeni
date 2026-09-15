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
- GÖREV: repository genelinde aktif kullanıcı arayüzü, query-window mimarisi, browser baseline, navigation/sidebar, GIS search/result UX, lazy UI yükleme, GIS resource lifecycle ve erişilebilirlik standardizasyonu.
- Başlangıç main HEAD: `ec38e15fd7bf346823c52032fd033f3bbb05f1ce` (Platform #10 merge sonrası).
- Branch: `agent/experience-modernization-2026-09-15-r2`.
- Doğrulanan son kod head: `211f9acce535b8fca9cdefd26f702c9565faeae5`.
- PR: #8.
- PR doğrulaması: base `main`, mergeable=true; son ölçüm 118 commit / 160 changed files.
- CI: `Webclient Quality` run #444 (`34975156131`) completed / success.
- MERGE: PR #8 squash-merge edildi.
- Merge commit: `678267711588d98074510d3d67687ba11a340e0c`.
- Platform/main ile oluşan çatışma force push yapılmadan gerçek iki-parent entegrasyon commit'leriyle çözüldü; paralel UX commit geçmişi korunarak nihai PR ağacına taşındı.

### ÖNEMLİ ÖZELLİKLER / WHOLE-CODE MODERNIZATION
- PR yalnız browser baseline değişikliği olarak kalmadı; repository'nin aktif Webclient Experience katmanında geniş kontrollü modernizasyon paketi içerdi.
- `Sidebar.js` yüzlerce satırlık monolitik katalog/render yükünden çıkarıldı; `SidebarCatalog.js` ile deklaratif katalog ve `SidebarModern.css` ile ayrı responsive presentation katmanı oluşturuldu.
- Query-window yükleme modeli `QueryWindowRegistry.js` + `LazyManagedWindow.js` ile merkezileştirildi; çok sayıdaki legacy query ekranı ortak managed pattern'e taşındı. Bu, ilk shell render'ında bütün query UI'larının eager yüklenmesi riskini azaltan code-splitting/lazy-loading yönüdür.
- Duplicate fast-access business/query pencereleri `createFastAccessQueryBusiness.js` ve `ManagedFastAccessQueryWindow` üzerinden ortak factory/runtime yapısına taşındı.
- `QueryInteractionRuntime` ve `QuerySearchRuntime` ile stale request gate, safe external navigation, viewport yardımcıları, owned resource cleanup ve search normalization ortaklaştırıldı.
- `ExperienceCommandCenter.js` genişletildi; command/navigation yüzeyi gerçek uygulama aksiyonlarına daha yakın ortak yapıya getirildi.
- `MapComponent.js`, `NavigationBar.js` ve shell bileşenlerinde legacy/tekrarlı UI davranışları azaltıldı.
- Fulltext search, Genel Arama, Event, EGO, Numbering, Pod, Taxi, Vicinity, Route, Ada-Parsel ve Acil Toplanma Alanı gibi yüksek kullanımlı ekranlar modern loading/error/empty/result semantics, stale-response koruması ve daha tutarlı cleanup ile yenilendi.
- `WindowManager` React lifecycle ile daha kararlı hale getirildi; `App.js` platform bootstrap + `AbortController` akışına geçirildi.
- `ConfigurationBusiness` platform HTTP client ve normalize edilmiş hata/response sözleşmesiyle birleştirildi.
- Popup içeriğinde string/unsafe HTML yerine DOM tabanlı üretim ve güvenli URL normalizasyonu tercih edildi.
- Browser baseline modern evergreen/Firefox ESR hedeflerine taşındı; explicit IE9/IE11 bootstrap polyfill entrypoint baskısı kaldırıldı. Kör framework major rewrite yapılmadı; React/CRA borcu kontrollü migration konusu olarak bırakıldı.

### DEĞİŞEN DOSYALAR / YAKLAŞIK SATIR
- PR #8: 160 changed files.
- GitHub PR ölçümü: 10.442 additions / 23.768 deletions; toplam yaklaşık 34.210 satır değişim.
- 4.000 anlamlı değişiklik kriteri rahat biçimde aşıldı.
- Değişimin büyük kısmı anlamlı legacy query-window tekrarlarının kaldırılması, ortak runtime/component altyapısına geçiş, gerçek ekran modernizasyonu, platform entegrasyonu ve testlerden oluşuyor; boilerplate ile satır doldurma yapılmadı.
- Öne çıkan dosyalar: `App.js`, `MapComponent.js`, `NavigationBar.js`, `Sidebar.js`, `SidebarCatalog.js`, `SidebarModern.css`, `ExperienceCommandCenter.js`, `LazyManagedWindow.js/.css`, `QueryWindowRegistry.js`, `CommonBusiness.js`, `QueryInteractionRuntime.js`, `QuerySearchRuntime.js`, `ManagedFastAccessQueryWindow.js`, fulltext/general search ve EGO query ekranları, çok sayıdaki fast-access query window, `iconRegistry.json`, `package.json`, `webclient-quality.yml`.

### TESTLER / BUILD
- GitHub Actions `Webclient Quality` run #444 başarıyla tamamlandı.
- Workflow doğrulanan kod head `211f9acce535b8fca9cdefd26f702c9565faeae5` üzerinde çalıştı ve PR merge öncesi green doğrulandı.
- Runner: Ubuntu 24.04.5, Node v24.20.0, npm 11.19.0.
- `npm ci`: PASS.
- lint-if-present: PASS.
- typecheck-if-present: PASS.
- Test suites: 14/14 PASS.
- Tests: 307/307 PASS.
- Snapshots: 0.
- Test süresi: yaklaşık 5.2 saniye.
- `CI=true npm run build`: PASS; sonuç `Compiled successfully.`.
- Production main JS gzip yaklaşık 39.36 KB; en büyük vendor chunk yaklaşık 116.76 KB.
- `caniuse-lite` veri tabanı güncelleme uyarısı build'i engellemiyor ancak bakım borcu olarak kaldı.
- Connector runtime içinde gerçek Chrome/Firefox/Safari/device görsel testi çalıştırılamadığı için visual regression ayrıca yapılmalıdır.

### RESPONSIVE / ACCESSIBILITY
- Sidebar ve query surfaces için modern responsive presentation ayrıştırıldı.
- Semantik search/navigation/query states, keyboard interaction, visible focus, ARIA/state feedback, reduced-motion/forced-colors ve touch-target yaklaşımı önceki Experience sözleşmesiyle korunup genişletildi.
- Form/select/input label bağları ve sonuç/action buton semantics bespoke query ekranlarında güçlendirildi.
- Tekrarlı legacy query ekranlarının ortak managed shell'e taşınması accessibility davranışının tek noktadan uygulanabilirliğini artırdı.
- Gerçek screen-reader smoke ve browser/device matrisi connector ortamında çalıştırılamadı; sonraki QA turunda zorunlu.

### NETWORK DEĞİŞİKLİKLERİ / ASSET STRATEGY
- WMS/WFS eklenmedi.
- Yeni remote font/CDN/analytics/third-party UI asset bağımlılığı eklenmedi.
- Same-origin/BFF ve Platform hardening yönü korunuyor; browser Network panelinde görünen verinin gizli sayılmadığı güvenlik modeli devam ediyor.
- GIS record iconları local asset path + merkezi JSON registry üzerinden çözülüyor.
- `styles.css` içinde eski Google Fonts Mukta import'u main'de halen tespit edildi; font-family zincirinde Mukta kullanılmadığından kaldırılması yüksek öncelikli cleanup olarak kaldı. Green ve büyük PR merge'i sonrasında doğrulamasız ek kod değişikliğiyle paketi oynatmamak tercih edildi.

### GÜVENLİK KONTROLLERİ
- Experience turu secret/token/client-key eklemedi; harici analytics veya yeni UI endpoint eklenmedi.
- Platform bootstrap servis URL'lerinde control-character/newline enjeksiyonu `trim()` öncesinde reddediliyor; lint uyumu için kontrol regex yerine karakter kodu doğrulamasıyla yapılıyor.
- Dış harita/yol tarifi pencerelerinde safe-open ve `noopener,noreferrer` yaklaşımı yaygınlaştırıldı.
- Popup web URL'leri yalnız HTTP/HTTPS protokollerine normalize ediliyor.
- CI'da `npm audit --omit=dev --audit-level=high` görünür hale getirildi fakat legacy kırıcı upgrade'i otomatik zorlamamak için non-blocking tutuldu.
- Son audit: 197 vulnerability = 10 low, 116 moderate, 53 high, 18 critical.
- Önemli borçlar arasında legacy `react-scripts` zinciri ile birlikte eski axios, DOMPurify, crypto-js ve jsPDF sürümleri bulunuyor.
- `npm audit fix --force` uygulanmadı; önerilen react-scripts/axios/jsPDF sıçramaları breaking değişiklik içeriyor ve ayrı kontrollü dependency modernization turu gerektiriyor.

### İKON EŞLEŞTİRME
- İkinci GIS icon mapping sistemi oluşturulmadı.
- Mevcut `Webclient.app/src/gis-engine/iconRegistry.json` + shared resolver/presentation tek GIS icon authority olarak korunuyor.
- Eczane, Taksi ve Acil Toplanma Alanı gibi bespoke marker yüzeyleri registry/resolver zincirine alındı.
- Registry testleri list/2D/3D modelin aynı icon key ve local asset'i çözmesini doğruluyor.
- Aktif UI içinde bağımsız yeni SceneView entrypoint icat edilmedi; mevcut 3D contract/parity korundu.

### MODERNİZASYON KARARLARI
- En büyük kazanım, onlarca kopya query componentini ortak managed runtime/component yaklaşımına taşımak oldu; bakım maliyeti ve interaction drift azaltıldı.
- React/CRA major migration bu pakette körlemesine yapılmadı. Mevcut stabil davranış ve CI korunarak browser baseline modernleştirildi; framework/runtime migration ayrı ölçümlü tur olmalı.
- 21st.dev/shadcn yaklaşımından lisanslı kod kopyalamak yerine composable surface, command, lazy registry, focus/touch/responsive gibi desenler mevcut projeye adapte edildi.
- Styling pipeline tamamen Tailwind'e zorla taşınmadı; mevcut CSS ile kontrollü modern component CSS birlikte kullanıldı. Büyük styling migration ancak bundle/build/browser ölçümüyle yapılmalı.
- CI actions/checkout ve setup-node v7, Node 24 ve Ubuntu 24.04 tabanına taşındı.

### PERFORMANS ETKİSİ
- Query windows için lazy managed registry, başlangıç render/import baskısını azaltacak mimari sağlar.
- Sidebar monolitinin katalog/presentation ayrımı render ve bakım karmaşıklığını azaltır.
- Tekrarlı query component kodunun büyük ölçüde kaldırılması bundle/source parse yükü ve future regression yüzeyini düşürür.
- Stable React keys ve shared interaction runtime duplicated event/state logic maliyetini azaltır.
- Owned-resource modeli sayesinde Rota/Global Identify/Ada-Parsel gibi ekranların başka araçlara ait tüm graphics'i global olarak temizlemesi engellendi.
- Stale async sonuçların yeni sorguyu/selection state'ini ezmesi request gates ile önlendi.
- Query layer filtreleri sonuç sorgusuyla aynı district/neighborhood/name/nearby semantiğini taşıyor.
- Modern browser baseline gereksiz legacy transpilation/polyfill baskısını azaltmaya yöneliktir.

### ÇÖZÜLEN HATALAR
- CI=true altında lint/hook warning'lerinin build'i kırdığı tüm bilinen noktalar kapatıldı; final production build green.
- Çok sayıda query ekranındaki kopya interaction/state kodu ortak sözleşmeye taşındı.
- Shell/sidebar ve command/navigation coupling azaltıldı.
- Search/query ekranlarında loading/error/empty/result durumlarının tutarlılığı iyileştirildi.
- Literal object throw kullanımları typed Error'a geçirildi.
- Fast-access katmanlarının form filtresini haritaya uygulamama regresyonu düzeltildi.
- Route tarafındaki cross-window `RemoveAllGraphics()` yan etkisi scoped/owned cleanup'a dönüştürüldü.
- Numbering/Pod/Taxi/Vicinity/EGO/Genel Arama'da hook cleanup, stale async ve erişilebilir interaction regresyonları kapatıldı.
- Platform URL normalizer'ın leading newline/control karakterini `trim()` ile kaybetme açığı düzeltildi.
- CRA `resetMocks` ile App bootstrap test mock'larının silinmesi giderildi.
- Search category normalizasyonunda teknik type bilgisinin semantik kategoriyi ezmesi düzeltildi.

### KALAN SORUNLAR
- Son audit'teki 197 dependency bulgusu ayrı kontrollü dependency modernization turu gerektiriyor; özellikle axios, DOMPurify, crypto-js, jsPDF ve CRA toolchain öncelikli.
- `Webclient.app/src/styles.css` Google Fonts Mukta import'u kaldırılmalı ve browser regression ile doğrulanmalı.
- `caniuse-lite` veri tabanı güncellenmeli.
- React 17/CRA-era dependency ve build zinciri kontrollü migration planı gerektiriyor; `npm audit fix --force` gibi kırıcı otomatik upgrade yapılmamalı.
- Gerçek Chrome/Firefox/Safari responsive visual regression, touch-device smoke, screen-reader smoke, forced-colors ve reduced-motion device/browser matrisi çalıştırılmalı.
- 2D↔3D kullanıcı entrypoint'i GIS/engine ekibiyle ortak tasarlanmalı; paralel 3D mapping/UI authority üretilmemeli.

### SONRAKİ GÖREV NOTU
- Dependency modernization için kırıcı olmayan paketleri önce izole et; axios/DOMPurify/crypto-js/jsPDF yükseltmelerini targeted testlerle yap.
- Google Fonts Mukta import'unu kaldır; kullanılan font stack'i local/system fontlarla browser/device matrisinde ölç.
- `caniuse-lite` verisini kontrollü güncelle ve build çıktısını karşılaştır.
- SharedGISIcon'u gerçek record result/table/card surfaces'e merkezi resolver üzerinden yay.
- Browser visual regression + keyboard + NVDA/VoiceOver smoke tamamla.
- Search/query performansını gerçek servis latency ve büyük sonuç setleriyle profile et.
- Aktif 3D ürün entrypoint'i netleşirse mevcut `sceneRuntime` + shared icon registry üzerinden 2D↔3D parity'yi genişlet; ikinci state veya icon mapping sistemi oluşturma.

## Kurallar
- Çalışan davranışlar korunur; WMS/WFS eklenmez; gerçek servis ve response şeması incelenmeden endpoint varsayılmaz.
- Browser Network panelinin tamamen gizlenemeyeceği kabul edilir; güvenlik server-side authorization, least privilege ve data minimization ile kurulur.
