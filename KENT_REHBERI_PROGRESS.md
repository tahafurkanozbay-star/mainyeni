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

- Tarihsel kök seviye GIS/ilerleme dosyaları `progress/archive/` altına alındı; içerikleri arşiv blob doğrulamasıyla korundu. Kök `KENT_REHBERI_PROGRESS.md` kısa güncel giriş noktası olarak yeniden düzenlendi.
- Root README, depo klasörleri ve statik-only yayın modelini açıklayacak biçimde güncellendi.
- HTML title/description/Open Graph/Twitter metadata, istenen **3D Altyapı / Üstyapı Koordinasyon Web Uygulaması** adına hizalandı.
- Doğrudan PlanASKI mimarisini "opt-in" veya "API ile geri dönülebilir" gösteren dokümantasyon düzeltildi.
- Artık işlevi olmayan `VITE_KENT_REHBERI_SOURCE` runtime/config anahtarı uygulama kodundan, örnek ortam dosyasından, IIS build betiğinden ve kalite sözleşmesinden kaldırıldı.
- `.gitignore` içindeki kaldırılmış .NET API/Business/Admin SPA projelerine ait eski kurallar temizlendi.
- Eski PostgreSQL API kurulum SQL'i `database/archive/retired-kent-rehberi-api.sql` altına taşındı; aktif yayın girdisi olmaktan çıkarıldı.
- `_docs` altında canlı `Webclient.app/public/fonts` kopyalarıyla bayt düzeyinde aynı olduğu Git blob SHA'larıyla doğrulanan 20 font dosyası tekrarını kaldırdı. Tarihsel CSV ve kaynak font CSS'i `docs/archive/legacy-site-reference/` altına alındı; eski görsel referansı derleme dışındaki `_docs/` içinde tutuldu.

## Doğrulama ve durum

- Ana dal tabanı, bu çalışmanın başlangıcında `9d83821c132e43afe14d9924435e271d5506fbc6` idi; önceki statik-only API kaldırma değişikliği [PR #538](https://github.com/tahafurkanozbay-star/mainyeni/pull/538) ile birleştirilmişti.
- Bu yapı/hijyen çalışması `agent/structure-hygiene-20261019-0520-9d83821` dalında. CI sonucu bu tam başlık SHA'sı için henüz onaylanmış sayılmamalıdır; PR oluşturulduktan sonra kalite iş akışları exact-head bazında kontrol edilecek.
- Bu ortamda canlı IIS sunucusu veya üretim tarayıcısında değişiklik yapılmadı; dağıtım sonucu ya da üretim CORS başarısı iddia edilmiyor.

## Sonraki adımlar

1. PR oluşturulduktan sonra bütün ilgili GitHub Actions iş akışlarını bu dalın son SHA'sında kontrol et.
2. Başarısız lint/test/build/kalite kapılarını kapsamı düşürmeden düzelt; ardından exact-head CI'ı yeniden doğrula.
3. Canlı yayından sonra Network panelinde Kent Rehberi isteklerinin yalnız PlanASKI hostuna gittiğini ve CORS nedeniyle tarayıcı hatası oluşmadığını doğrula.
4. Eski IIS eşlemesi/klasörü için canlı sunucu envanteri çıkar; yalnız ayrı onaylı bakım adımında kaldır.
5. Ayrı GIS modülleri `KentRehberi/webclient/` ve `WebClient/` dosyalarını otomatik silme veya birleştirme: aktif bağımlılık/CI rolünü kanıtlayan envanter tamamlandıktan sonra ayrı bir migration planı hazırla.
