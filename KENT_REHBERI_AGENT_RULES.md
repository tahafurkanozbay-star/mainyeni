# Kent Rehberi — Agent Orchestration Rules

## Amaç
Bu repository kurumsal Kent Rehberi/CBS uygulamasıdır. Amaç uygulamayı modern, profesyonel, güvenli, erişilebilir, hızlı ve ölçeklenebilir bir 2D + 3D GIS platformuna dönüştürmektir.

## Her turda zorunlu başlangıç
1. Önce bu dosyayı oku.
2. Sonra kendi görevine ait agent kural dosyasını oku.
3. `KENT_REHBERI_PROGRESS.md` dosyasını oku; yoksa oluştur.
4. `git status`, mevcut branch, son commit ve açık PR/merge durumunu kontrol et.
5. Önceki turun değişikliklerini ezme. Aynı dosya/alan üzerinde paralel iş varsa mevcut yapıya entegre ol.

## Kod kalitesi
- Sırf satır sayısını doldurmak için anlamsız kod üretme.
- Her tur yaklaşık 4000 anlamlı satır değişikliği/eklemesi hedefle; kalite düşecekse gerçek işlev ve kalite önceliklidir.
- Çalışan özellikleri gerekçesiz kaldırma.
- Console error, kırık import, kullanılmayan değişken/import, gereksiz duplicate code bırakma.
- Güvenlik, performans, responsive ve accessibility gerekliliklerini gözet.

## Tasarım ve mimari
21st.dev, shadcn/ui, modern Tailwind/React desenleri, enterprise dashboard ve modern GIS ürünlerinin iyi mimari/tasarım kalıplarından yararlan. İçeriği/lisansı belirsiz premium materyali izinsiz kopyalama; tasarım desenlerini mevcut projeye adapte et.

## GIS / 3D
Mevcut teknoloji yığınıyla uyumlu olacak şekilde ArcGIS Maps SDK for JavaScript, CesiumJS, Three.js, deck.gl ve ilgili WebGL/WebGPU yaklaşımlarını değerlendir. 3D; terrain, buildings, 3D Tiles/glTF, kamera, katman, seçim, popup, ölçüm ve performans optimizasyonu ile ele alınmalıdır. Gereksiz teknoloji değişiminden kaçın.

## Güvenlik
Secret/API key/parola kaynak koda gömülmez. XSS, injection, unsafe HTML, token handling, dependency riskleri, CORS ve input validation kontrol edilir.

## Git / PR / Merge
Çalışmayı mümkünse `agent/<alan>-<tarih>` branch'ında yap. Commit mesajı `feat(<alan>): <özet>` formatında olsun. PR oluşturulabilen ortamda PR aç. Merge öncesi build/test doğrula. Başka bir branch'ı force push veya ezme yapma.

## Sonraki görev için durum bırakma
`KENT_REHBERI_PROGRESS.md` içinde tamamlanan işler, devam eden işler, bilinen sorunlar, test/build sonucu, son commit/PR/merge durumu ve sonraki görev için notları güncelle.

## Tur sonu raporu
TUR / GÖREV / BRANCH / COMMIT / PR / MERGE DURUMU / ÖNEMLİ ÖZELLİKLER / DEĞİŞEN DOSYALAR / YAKLAŞIK SATIR / TESTLER / BUILD / ÇÖZÜLEN HATALAR / KALAN SORUNLAR / SONRAKİ GÖREV NOTU alanlarını kaydet.

## Görev sırası
1 Architecture
2 UI/UX
3 2D GIS
4 3D GIS
5 GIS Data/Services
6 Search/Address
7 Performance
8 Security
9 Accessibility/Responsive
10 Final QA/Release

Her görev önceki görevlerin durumunu kontrol etmeli ve kendi uzmanlık alanına odaklanmalıdır. Hiçbir görev başka bir görevin işini gereksiz yere geri almamalıdır.
