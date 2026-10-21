# 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması — Güncel İlerleme

## 2026-10-21 — 3B SVG harita ikonları: zeminden 50 m yüksekte callout pinleri

- Dal: `agent/3d-svg-pin-icons-50m-20261021`; taban main SHA: `e1815574f3bad5ffb5fc53ae183a545f7b00d9ac`.
- Yeni `SceneIconPresentationRuntime`, Kent Rehberi'nin mevcut `kent-rehberi-postgis` GeoJSON katmanının SVG `unique-value` renderer'ını yalnızca 3B sahne görünürken dönüştürür. Her SVG ikon, `IconSymbol3DLayer` içeren billboard `PointSymbol3D` olarak çizilir; `verticalOffset` min/max world length tam 50 m, ikon bağlantısı `LineCallout3D`, anchor `bottom` ve bina/zemin engellerine karşı görünürlük `visible` ayarlanır.
- 2B'ye dönüldüğünde özgün renderer ve `elevationInfo` nesnesi geri yüklenir. Layer henüz veri yüklenirken 3B açılmışsa koleksiyon dinleyicisi katman eklendiğinde dönüşümü uygular; ayrı GeoJSON indirmesi veya kopya POI katmanı oluşturulmaz. SVG yolları `./images/...` biçimine normalize edilir, IIS alt dizin dağıtımı korunur.
- Runtime ve 3B mod köprüsü regresyon testleri eklendi; kayıt defterindeki bütün SVG harita ikonlarının dönüştürüldüğünü test eden kapsama dahil edildi. CI ve üretim dağıtımı henüz doğrulanmadı.


## 2026-10-21 — Esri 3D Buildings SceneLayer entegrasyonu (PR #593)

- Çalışma dalı: `agent/esri-3d-buildings-20261021-1048-11c7c61`; güncel main tabanı: `c81b285e87adf1d2031707cc00b6f43125c9a559`.
- Esri'nin resmi `Esri3D_Buildings_v1/SceneServer/layers/0` servisi için tembel yüklenen `Esri3DBuildingsRuntime` eklendi. Katman yalnızca 3B görünüme geçerken oluşturulur; 2B'ye dönüşte gizlenip aynı Map üzerinde korunur. Yapı adı/türü, yükseklik ve kat sayısı için popup bilgileri ile servis kaynak atfı tanımlandı.
- Aktif geçiş artık bina geometrilerini ayrıca Overpass'tan indirmek yerine Esri'nin akışlı 3B katmanını kullanır; çift bina çizimini ve ilgili gereksiz Overpass isteklerini önler. PR #592 ile ana dala alınan Ankara başlangıç/kamera iyileştirmeleri korunarak yeniden tabanlandı.
- Yeni runtime yaşam döngü testleri ve 2B/3B köprü test mock'u eklendi. İlk Release QA turunda bulunan tanı gözlemleyicisi istisnasını yutan `catch` düzeltildi. Yeniden tabanlanan en güncel başlık için zorunlu CI kontrolleri yeniden çalıştırılıyor; canlı IIS/üretim tarayıcı doğrulaması yapılmadı.


> Bu dosya kısa ve güncel başlangıç kaydıdır. Eski, ayrıntılı durum kayıtlarının tam kopyaları [`progress/archive/`](./progress/archive/) altındadır. Yapısal düzenleme öncesindeki eksiksiz kayıt [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261019_PRE_STRUCTURE_HYGIENE.md`](./progress/archive/KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261019_PRE_STRUCTURE_HYGIENE.md) dosyasında korunur.

## 2026-10-20 — Keşfet paneli, kayıt merkezli yakınlaşma ve alt uyarı

- Önceki hizalama CSS'i gerçek ekranda kazanan `kentrehberi-public-map-workspace.css` kuralından daha düşük öncelikli kaldığı için etkisizdi. Etkin kural düzeltildi: Keşfet paneli solda `0` konumunda, Mainbar'ın alt sınırına hizalı ve masaüstünde 600px; tablet/telefon için duyarlı genişlik kullanır.
- Nokta geometrilerinde `GisGraphicsHelper.ZoomToGeometry` artık doğrulanmış WGS84 / GeoJSON koordinatlarını doğrudan `center: [longitude, latitude]` olarak verir; genel/geçersiz geometri için eski target davranışı korunur. Nokta arama popup'ı etkin 3B görünümle doğrulanır; gizli 2B görünüm nedeniyle atlanmaz.
- Sol alt veri uyarısı tek satıra alındı; beyaz fon doğal metin genişliğine göre büyür ve dar ekranda yazı boyutu küçülür. Panel yerleşimi, 3B popup ve koordinat merkezleme regresyon testleri eklendi.
- Güncel taban `293edf3e20605b70785d33db1f37d5d1b8e4a8f5`; PR [#583](https://github.com/tahafurkanozbay-star/mainyeni/pull/583) 20 Ekim 2026'da squash-merge edildi; merge commit: `8e260d10df6edb576eca337100804dfddfadd2a9`. Exact-head doğrulaması başarılı: Webclient Quality (tam Vitest, exact-base regresyon, üretim Vite derlemesi, paket bütünlüğü ve build bütçeleri), Release QA, Typed Source Boundary, Platform Architecture Audit ve Platform Dependency Governance. Canlı IIS/üretim tarayıcı doğrulaması yapılmadı.

## 2026-10-20 — Hizmet penceresi başlığındaki yinelenen kontroller kaldırıldı

- Hizmet sonuç penceresinin başlığındaki yukarı okla küçült/büyüt ve X ile kapat düğmeleri kaldırıldı; mevcut `Hizmetlere dön` düğmesi tek dönüş kontrolü olarak bırakıldı.
- Başlık ızgarası iki kaldırılan kontrolün sütunlarından arındırıldı; açık/koyu ve forced-colors stilleri sadeleştirildi.
- Regresyon testleri yalnızca `Hizmetlere dön` kontrolünün bulunduğunu, dönüşte harita filtresinin temizlendiğini ve tüm noktaların geri gösterildiğini doğrular.
- PR ve son exact-head CI sonucu birleştirmeden sonra kaydedilecektir.

## 2026-10-20 — Keşfet filtre temizleme UX iyileştirmesi

- Birleştirme öncesi güncel `main` tabanı: `70d37031c421e1558fd0df974a344b2eb35b39bb`; dal: `agent/keşfet-map-filter-clear-ux-20261020`.
- Önceki üst başlıktaki genel `Ana Menü` düğmesi yerine kurum logolarının hemen altında, filtrelenen kurum/hizmet adını gösteren bağlamsal bir satır ve `Tüm noktalar` düğmesi bulunur.
- Düğme sadece harita filtresini temizler; seçili kurumun alt kategori listesini açık bırakır. Seçili kurum logosuna tekrar tıklamak da harita filtresini kapatır; alt kategori listesi kapanmaz ve sonraki tıklama filtreyi yeniden uygular.
- [PR #576](https://github.com/tahafurkanozbay-star/mainyeni/pull/576) 20 Ekim 2026 tarihinde birleştirildi; merge commit: `eb674234c93740582e03492040ef4940e7a18434`. Exact-head zorunlu CI kontrollerinin tümü başarılı: Webclient Quality (tam Vitest ve exact-base regresyon kapıları, üretim derlemesi, bütünlük ve bütçe kontrolleri), Release QA, Typed Source Boundary, Platform Architecture Audit ve Platform Dependency Governance. Canlı IIS/üretim tarayıcısı doğrulanmadı.

## 2026-10-20 — Keşfet kategori filtresi ve ana menüye dönüş

- Güncel `main` tabanı: `212373e7ccaec9cc04a80d174463034e73742b10`; çalışma dalı: `agent/gis-category-filter-20261020-1110-212373e`.
- Kent Rehberi overview katmanı ilk açılışta filtresizdir; tüm noktalar görünür kalır. Keşfet kurum ve hizmet seçimleri yüklü katmana istemci taraflı `definitionExpression` uygular; başka bir PlanASKI isteği veya katmanı yeniden yükleme gerekmez.
- Filtre etkin olduğunda `Ana menü` kontrolü görünür. Ana menüye dönüş kurum/görünüm/arama durumunu sıfırlar ve filtreyi kaldırarak tüm noktaları gösterir. Aynı kuruma ikinci kez tıklanınca alt kategori panelinin açık kalması korunur.
- Regresyon testleri: güvenli filtre ifadesi ve kategori anahtarları; yüklü katmanda filtre uygulama/temizleme; kurum/hizmet seçimi ve ana menüye dönüş.
- [PR #573](https://github.com/tahafurkanozbay-star/mainyeni/pull/573) 20 Ekim 2026 tarihinde birleştirildi; merge commit: `6562ea30858fe25fcfd7b79dbd57c193947d78e7`. Exact-head CI kontrollerinin tümü başarılı: Webclient Quality (tam Vitest regresyon kapısı, üretim derlemesi ve bütünlük/bütçe kontrolleri dahil), Release QA, Typed Source Boundary, Platform Architecture Audit ve Platform Dependency Governance. Canlı IIS/üretim tarayıcısında doğrulama yapılmadı.

## 2026-10-19 — Trafik eklentisi kaldırıldı

- Ücretsiz ve anahtarsız kullanılabildiği doğrulanabilen bir gerçek zamanlı Ankara trafik API'si bulunamadığı için sağ araç çubuğundaki Trafik butonu ve TomTom entegrasyonu tamamen kaldırıldı.
- Trafik katmanı bileşeni, TomTom URL/kimlik bilgisi yardımcıları ve testleri silindi. Uygulama derlemesi için trafik anahtarı veya `.env` ayarı artık gerekmiyor.
- ABB Trafik tüketici uygulamasının bulunması, uygulama içinden çağrılabilecek herkese açık ve anahtarsız bir API bulunduğu anlamına gelmediğinden belgelenmemiş servislere bağımlılık eklenmedi.

## 2026-10-19 — Keşfet paneli, sonuç pencereleri ve altlık önizlemeleri (önceki değişiklik)

- Dal: `agent/kesfet-panel-basemap-traffic-20261019-1747-964b860`; başlangıç tabanı: `964b8609465bfab9a6f06bc199a2c926e421e87a`.
- Keşfet kategori pencereleri için eski `.sidebar-container` kökleri ayrı ve daha yüksek bir katmanda konumlandırıldı; pencereler açık harita alanına, panel daraltıldığında ise dar rayın yanına taşınıyor. Daraltma artık yalnızca içeriği gizlemiyor, panel genişliğini de gerçekten azaltıyor.
- Nokta arama alanında tarayıcının ikinci temizleme X'i gizlendi. Sonuç tıklaması görünür 2B/3B harita görünümünü temel alacak biçimde aktif MapView/SceneView sahipliği eklendi.
- Altlık galerisi artık SDK'nın güvenli HTTPS küçük resim adresi bulunduğunda onu gösteriyor; bulunmadığında her altlık kimliği için ayrı yerel SVG önizlemesi kullanıyor.
- Not: TomTom entegrasyonu sonraki değişiklikte tamamen kaldırıldı; ücretsiz anahtarsız bir kaynak doğrulanamadığından bu eklenti artık etkin mimarinin parçası değildir.
- Regresyon testleri eklendi: aktif 3B görünümde noktaya yakınlaşma, altlık thumbnail/fallback gösterimi ve TomTom anahtar önceliği/geriye dönük uyumluluğu.
- PR: [#561](https://github.com/tahafurkanozbay-star/mainyeni/pull/561). İlk CI turunda Vite ortam-kontratı yeni public-key istisnasının eksik olduğunu yakaladı; izin listesi ve izin verilen/yasaklanan değişken öz testleri eklendi. Son exact-head kalite/derleme kontrolleri PR'da takip ediliyor; kontroller başarıyla sonuçlanmadan merge edilmemeli. Canlı IIS dağıtımı yapılmadı.
- Etkilenen alanlar: `Webclient.app/src/Components/App/SidebarModern*`, `MapComponent*`, `ExperienceMapModeBridge.tsx`, `MapManager.ts`, `Webclient.app/src/Components/Widget/Basemap/BasemapWidget*`, `Webclient.app/scripts/vite-migration-audit.mjs`, `.env.example`.

## Etkin mimari

- Yayınlanan tek ön yüz: `Webclient.app/` (React + TypeScript + Vite + ArcGIS Maps SDK).
- Kent Rehberi verilerinin tek kaynağı: `https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=N`; kategori aralığı `0..42`.
- Tarayıcı PlanASKI'ye doğrudan CORS isteği yapar. Uygulama için özel User/Admin API, PostgreSQL/PostGIS, aynı-köken `/api` proxy'si veya kaynak seçme bayrağı yoktur.
- Başlangıç harita görünümü uygulama içi sabit Ankara yapılandırmasından gelir; eski sunucu GIS kataloğu başlangıçta çağrılmaz.
- Canlı üretimde `https://cbs.ankara.bel.tr` origin'inin PlanASKI CORS izin listesinde olduğu henüz gerçek tarayıcıdan doğrulanmış sayılmaz. Bu ön koşul yayımdan sonra kontrol edilmelidir.
- IIS betikleri statik ön yüzü hazırlar ve yayımlar. Sunucuda önceki dağıtımdan kalmış `/api` eşlemesini veya `user` fiziksel klasörünü bilerek silmez.

## 2026-10-19 — Yapı ve mimari hijyeni

- Önceki tarihsel GIS/ilerleme kayıtlarının tam kopyaları `progress/archive/` altında korunuyor; `progress/` içinde eski bağlantı yollarını bozmamak için yalnız kısa yönlendirme dosyaları bırakıldı. `docs/experience-ui-deep-audit-2026-09-15.md` için de tam kayıt `docs/archive/` altına alındı ve eski yolda yönlendirme korundu.
- Root README, depo klasörleri ve statik-only yayın modelini açıklayacak biçimde güncellendi.
- HTML title/description/Open Graph/Twitter metadata, istenen **3D Altyapı / Üstyapı Koordinasyon Web Uygulaması** adına hizalandı.
- PR [#542](https://github.com/tahafurkanozbay-star/mainyeni/pull/542), `apiBaseUrl`/varsayılan `/api` runtime yapılandırmasını kaldırdı; generic HTTP singleton tahminî API çağrısı yapmak yerine kapalı hata verir. PR'ın güncel taban başlığındaki lint, exact-base TypeScript/Vitest, mimari, dependency, governance, release QA, bundle bütünlüğü ve üretim bütçesi kontrolleri geçti. Merge commit: `2736a6ea7ed1ae2ec79256016d99667393d597c0`.
- Doğrudan PlanASKI mimarisini "opt-in" veya "API ile geri dönülebilir" gösteren dokümantasyon düzeltildi.
- Artık işlevi olmayan `VITE_KENT_REHBERI_SOURCE` runtime/config anahtarı uygulama kodundan, örnek ortam dosyasından, IIS build betiğinden ve kalite sözleşmesinden kaldırıldı.
- `.gitignore` içindeki kaldırılmış .NET API/Business/Admin SPA projelerine ait eski kurallar temizlendi.
- Eski PostgreSQL API kurulum SQL'i `database/archive/retired-kent-rehberi-api.sql` altına taşındı; aktif yayın girdisi olmaktan çıkarıldı.
- `_docs` altında canlı `Webclient.app/public/fonts` kopyalarıyla bayt düzeyinde aynı olduğu Git blob SHA'larıyla doğrulanan 20 font dosyası tekrarını kaldırdı. Tarihsel CSV ve kaynak font CSS'i `docs/archive/legacy-site-reference/` altına alındı; eski görsel referansı derleme dışındaki `_docs/` içinde tutuldu.

## Doğrulama ve durum

- Önceki statik-only API kaldırma değişikliği [PR #538](https://github.com/tahafurkanozbay-star/mainyeni/pull/538) ile; yapı/hijyen düzenlemesi [PR #540](https://github.com/tahafurkanozbay-star/mainyeni/pull/540) ile birleştirildi. Daha sonraki API runtime temizliği [PR #542](https://github.com/tahafurkanozbay-star/mainyeni/pull/542) ve GIS politika arşivleme işlemi de ana dala girdi.
- Yapı/hijyen PR'ı [#540](https://github.com/tahafurkanozbay-star/mainyeni/pull/540) `0701d47f7e032832a2812208e04031da1844b4ba` exact-head SHA'sında beş kontrolün tamamını başarıyla geçti: Webclient Quality, Release QA, Platform Architecture Audit, Platform Dependency Governance ve Typed Source Boundary. PR 19 Ekim 2026 tarihinde squash-merge edildi; merge commit ve güncel `main` SHA'sı `10d4161d6576444bd83d0bfd67d5669108ff2515`.
- Bu ortamda canlı IIS sunucusu veya üretim tarayıcısında değişiklik yapılmadı; dağıtım sonucu ya da üretim CORS başarısı iddia edilmiyor.
- En son doğrulanmış ana dal: `cc087daa30dad23f96e352593af724bc062e92cf`. Bu başlıkta Release QA, Webclient Quality, Typed Source Boundary, Platform Governance Validation ve Pages deploy başarılı. Platform Architecture/Typed Test/Dependency denetimleri de PR #542'nin birleştirilen tam başlığında başarıyla tamamlandı.

## Sonraki adımlar

1. Kod tarafında mevcut statik-only release ve PlanASKI kaynak sınırlarını koru; yeni API/proxy/source toggle ekleme.
2. Canlı yayından sonra Network panelinde Kent Rehberi isteklerinin yalnız PlanASKI hostuna gittiğini ve CORS nedeniyle tarayıcı hatası oluşmadığını doğrula.
3. Eski IIS eşlemesi/klasörü için canlı sunucu envanteri çıkar; yalnız ayrı onaylı bakım adımında kaldır. Bu ortamda canlı IIS'e erişilmedi.
4. `KentRehberi/webclient/` ayrı `gis-core-quality.yml` kalite iş akışı tarafından hâlâ derlenip test ediliyor; bu modülü aktif mimari envanteri olmadan silme.
5. Eski `WebClient/src/gis/` politika dosyaları paket, tsconfig, import veya build/release workflow bağlantısı bulunmadığından silinmeden `archive/legacy-gis-policies/` altına taşındı. `KentRehberi/webclient/` ayrı `gis-core-quality.yml` tarafından aktif olarak derlenip test edildiğinden korunmalıdır.
