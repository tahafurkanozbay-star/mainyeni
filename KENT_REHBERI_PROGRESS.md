# 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması — Güncel İlerleme

> Bu dosya kısa ve güncel başlangıç kaydıdır. Eski, ayrıntılı durum kayıtlarının tam kopyaları [`progress/archive/`](./progress/archive/) altındadır. Yapısal düzenleme öncesindeki eksiksiz kayıt [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261019_PRE_STRUCTURE_HYGIENE.md`](./progress/archive/KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261019_PRE_STRUCTURE_HYGIENE.md) dosyasında korunur.

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
