# 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması — Güncel İlerleme

> Bu dosya kısa ve güncel başlangıç kaydıdır. Eski, ayrıntılı durum kayıtlarının tam kopyaları [`progress/archive/`](./progress/archive/) altındadır. Yapısal düzenleme öncesindeki eksiksiz kayıt [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261019_PRE_STRUCTURE_HYGIENE.md`](./progress/archive/KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261019_PRE_STRUCTURE_HYGIENE.md) dosyasında korunur.

## 2026-10-20 — Keşfet kategori filtresi ve ana menüye dönüş

- Güncel `main` tabanı: `0e2785c4786f9a36246ce4c7ece8a027153279fb`; çalışma dalı: `agent/gis-category-filter-20261020-1057-0e2785c`.
- Kent Rehberi overview katmanı başlangıçta filtresiz kalır; tüm kayıtları tek seferde göstermeye devam eder. Kurum kategorisi seçimi, aynı yüklü katmanda yerel `definitionExpression` uygular; hizmet seçimi de hizmetin SVG ikon anahtarına göre filtreler. Ek API çağrısı veya veri katmanını yeniden yükleme yoktur.
- Filtre etkinken `Ana menü` düğmesi görünür. Bu düğme kategori/görünüm/arama seçimini sıfırlar ve filtreyi kaldırarak bütün noktaları geri getirir. Aynı kuruma tekrar tıklanınca mevcut alt kategori panelinin açık kalma davranışı korunur.
- Regresyon kapsamı: filtre durum modeli ve güvenli SQL üretimi; yüklü haritada kategori filtresinin uygulanıp temizlenmesi; kurum/hizmet seçimi ve ana menüye dönüş.
- CI, PR ve merge durumu bu checkpoint oluşturulurken beklemededir. Canlı IIS/üretim tarayıcısı doğrulanmış değildir.

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

- Tarihsel kök seviye GIS/ilerleme dosyaları `progress/archive/` altına alındı; içerikleri arşiv blob doğrulamasıyla korundu. Kök `KENT_REHBERI_PROGRESS.md` kısa güncel giriş noktası olarak yeniden düzenlendi.
- Root README, depo klasörleri ve statik-only yayın modelini açıklayacak biçimde güncellendi.
- HTML title/description/Open Graph/Twitter metadata, istenen **3D Altyapı / Üstyapı Koordinasyon Web Uygulaması** adına hizalandı.
- PR [#542](https://github.com/tahafurkanozbay-star/mainyeni/pull/542), `apiBaseUrl`/varsayılan `/api` runtime yapılandırmasını kaldırdı; generic HTTP singleton tahminî API çağrısı yapmak yerine kapalı hata verir. PR'ın güncel taban başlığındaki lint, exact-base TypeScript/Vitest, mimari, dependency, governance, release QA, bundle bütünlüğü ve üretim bütçesi kontrolleri geçti. Merge commit: `2736a6ea7ed1ae2ec79256016d99667393d597c0`.
- Doğrudan PlanASKI mimarisini "opt-in" veya "API ile geri dönülebilir" gösteren dokümantasyon düzeltildi.
- Artık işlevi olmayan `VITE_KENT_REHBERI_SOURCE` runtime/config anahtarı uygulama kodundan, örnek ortam dosyasından, IIS build betiğinden ve kalite sözleşmesinden kaldırıldı.
- `.gitignore` içindeki kaldırılmış .NET API/Business/Admin SPA projelerine ait eski kurallar temizlendi.
- Eski PostgreSQL API kurulum SQL'i `database/archive/retired-kent-rehberi-api.sql` altına taşındı; aktif yayın girdisi olmaktan çıkarıldı.
- `_docs` altında canlı `Webclient.app/public/fonts` kopyalarıyla bayt düzeyinde aynı olduğu Git blob SHA'larıyla doğrulanan 20 font dosyası tekrarını kaldırdı. Tarihsel CSV ve kaynak font CSS'i `docs/archive/legacy-site-reference/` altına alındı; eski görsel referansı derleme dışındaki `_docs/` içinde tutuldu.

## Doğrulama ve durum

- Ana dal tabanı, bu çalışmanın başlangıcında `9d83821c132e43afe14d9924435e271d5506fbc6` idi; önceki statik-only API kaldırma değişikliği [PR #538](https://github.com/tahafurkanozbay-star/mainyeni/pull/538) ile birleştirilmişti.
- Yapı/hijyen PR'ı [#540](https://github.com/tahafurkanozbay-star/mainyeni/pull/540) `0701d47f7e032832a2812208e04031da1844b4ba` exact-head SHA'sında beş kontrolün tamamını başarıyla geçti: Webclient Quality, Release QA, Platform Architecture Audit, Platform Dependency Governance ve Typed Source Boundary. PR 19 Ekim 2026 tarihinde squash-merge edildi; merge commit ve güncel `main` SHA'sı `10d4161d6576444bd83d0bfd67d5669108ff2515`.
- Bu ortamda canlı IIS sunucusu veya üretim tarayıcısında değişiklik yapılmadı; dağıtım sonucu ya da üretim CORS başarısı iddia edilmiyor.
- PR #542 sonrası `main` üzerindeki Release QA, Webclient Quality, Platform Typed Test/Validation ve Pages deploy iş akışları da `2736a6ea...` başlığında başarılı olarak doğrulandı.

## Sonraki adımlar

1. Kod tarafında mevcut statik-only release ve PlanASKI kaynak sınırlarını koru; yeni API/proxy/source toggle ekleme.
2. Canlı yayından sonra Network panelinde Kent Rehberi isteklerinin yalnız PlanASKI hostuna gittiğini ve CORS nedeniyle tarayıcı hatası oluşmadığını doğrula.
3. Eski IIS eşlemesi/klasörü için canlı sunucu envanteri çıkar; yalnız ayrı onaylı bakım adımında kaldır. Bu ortamda canlı IIS'e erişilmedi.
4. `KentRehberi/webclient/` ayrı `gis-core-quality.yml` kalite iş akışı tarafından hâlâ derlenip test ediliyor; bu modülü aktif mimari envanteri olmadan silme.
5. Eski `WebClient/src/gis/` politika dosyaları; paket/tsconfig, uygulama import'u, build/release workflow'u veya etkin kalite aracı referansı bulunmadığı denetlendikten sonra silinmeden `archive/legacy-gis-policies/` altına taşınmak üzere ayrı PR'da arşivleniyor. `KentRehberi/webclient/` ayrı `gis-core-quality.yml` tarafından aktif olarak derlenip test edildiğinden korunmalıdır.
