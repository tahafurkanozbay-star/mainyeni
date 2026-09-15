# Kent Rehberi — Agent Orchestration Rules

## Amaç
Bu repository kurumsal Kent Rehberi/CBS uygulamasıdır. Amaç uygulamayı modern, profesyonel, güvenli, erişilebilir, hızlı, ölçeklenebilir ve sürdürülebilir bir 2D + 3D GIS platformuna dönüştürmektir.

## Her turda zorunlu başlangıç
1. Önce bu dosyayı oku.
2. Sonra kendi görevine ait agent kural dosyasını oku.
3. `KENT_REHBERI_PROGRESS.md` dosyasını oku; yoksa oluştur.
4. `git status`, mevcut branch, son commit ve açık PR/merge durumunu kontrol et.
5. Önceki turun değişikliklerini ezme. Aynı dosya/alan üzerinde paralel iş varsa mevcut yapıya entegre ol.

## Bütün kod tabanı modernizasyon standardı
- Amaç yalnızca birkaç dosyayı yamamak değildir; repository'nin tüm aktif kod tabanı zaman içinde güncel, hızlı, güvenli ve bakımı kolay bir yapıya taşınmalıdır.
- Kullanılan programlama dilleri, runtime'lar, framework'ler, build araçları, bağımlılıklar ve kod kalıpları her turda ilgili alan için gözden geçirilmelidir.
- Güncel ve stabil sürümler tercih edilmelidir; beta/deneysel teknoloji ancak açık performans veya işlev gerekçesi varsa ve geri dönüş planı bulunuyorsa kullanılmalıdır.
- Büyük sürüm veya dil/framework geçişleri körlemesine yapılmaz. Önce mevcut davranış, bağımlılıklar, tarayıcı desteği, build/test durumu ve migration riski çıkarılır; sonra kontrollü aşamalar halinde uygulanır.
- Eski/deprecated API, framework pattern'i, syntax, polyfill, paket, build zinciri veya güvenlik riski tespit edilirse uyumlu modern karşılığına geçirilmesi değerlendirilir.
- Kod tabanının yalnızca frontend'i değil; backend/BFF/proxy, API contracts, shared types, testler, CI/CD, config, asset pipeline, security headers ve veri erişim modeli de modernizasyon kapsamındadır.
- Modernizasyon kararı ölçülebilir kazanıma dayanmalıdır: runtime performansı, bundle boyutu, memory kullanımı, build süresi, test güvenilirliği, güvenlik, geliştirilebilirlik veya bakım maliyeti.
- 'En güncel' olmak tek başına amaç değildir; hedef en güncel STABIL ve bu proje için en hızlı/güvenilir çözümdür.
- Çalışan işlevleri koru. Büyük rewrite gerekiyorsa feature-by-feature migration, adapter veya compatibility layer kullan; tek hamlede riskli rewrite yapma.

## Kod kalitesi ve yeniden geliştirme
- Mevcut kodu körlemesine yamamak yerine, gerektiğinde modül veya özellik bazında modern mimariyle yeniden tasarla; ancak çalışan işlevleri gerekçesiz kaldırma.
- Güncel, hızlı ve bakımı kolay dil/çerçeve özelliklerini mevcut stack ile uyumlu şekilde kullan; gereksiz teknoloji göçü yapma.
- 4000 anlamlı satır bir hedef/referanstır, üst sınır değildir. Gerçek iş paketi gerekiyorsa 4000 satırı anlamlı biçimde aş; sırf sayı doldurmak için boilerplate üretme ve 4000'e ulaştın diye durma.
- Birkaç kolay değişiklik bulduysan turu kapatma; kendi uzmanlık alanındaki kalan yüksek etkili sorunları araştır.
- Console error, kırık import, kullanılmayan değişken/import, duplicate code, race condition ve memory leak bırakma.
- Güvenlik, performans, responsive ve accessibility gerekliliklerini birlikte gözet.

## Derin çalışma döngüsü — her turda zorunlu
1. Repository ve ilgili veri/uygulama akışlarını geniş biçimde analiz et.
2. Önceki tur ve mevcut davranışları envanterle.
3. Yüksek etkili işleri önceliklendir.
4. Değişiklikleri kontrollü uygula.
5. İlk test/lint/typecheck/build/smoke doğrulamasını çalıştır.
6. Bulunan sorunları aynı tur içinde düzelt.
7. İkinci doğrulama turunu çalıştır.
8. Security/performance/regression/data-integrity incelemesi yap.
9. Gerekirse ikinci veya üçüncü geliştirme geçişi yap.
10. Final test/build/regression doğrulamasını yap.
11. Commit/PR/merge durumunu gerçekten doğrula.
12. `KENT_REHBERI_PROGRESS.md` içinde net sonraki tur başlangıcı bırak.

## Network / Veri Erişimi Güvenlik Politikası
- Dış kullanıcı tarayıcısının gereksiz veya kontrolsüz üçüncü taraf network çağrısı yapmasını engelle. Mümkün olan veri akışlarını same-origin backend/BFF/proxy/server-side katmana taşı.
- Tarayıcıya ulaşmak zorunda olan verinin ağ üzerinde tamamen gizlenebileceği varsayımını yapma; güvenliği network gizliliğine değil, sunucu tarafı yetkilendirme, least-privilege, erişim kontrolü, veri minimizasyonu ve güvenli API tasarımına dayandır.
- Gereksiz analytics, telemetry, remote fonts, CDN, maps, geocoding veya başka üçüncü taraf çağrıları ekleme. Tüm harici endpointleri açıkça listele, gerekçelendir ve timeout/cache/cancellation uygula.
- Uygulama yavaşlığını azaltmak için aynı veriyi tekrar tekrar indirme; cache, request deduplication, lazy loading ve incremental loading kullan.
- CORS ve güvenlik başlıklarını kontrollü yapılandır; token/secret/API key hiçbir şekilde istemci bundle'ına gömülmesin.

## GIS Veri Protokolü
- Bu proje kapsamında WMS ve WFS servisleri varsayılmayacak ve yeni WMS/WFS entegrasyonu eklenmeyecek; mevcut ve gerekli servisler repository'deki gerçek konfigürasyona göre doğrulanacak.
- ArcGIS REST tabanlı servisler, mevcut MapServer/FeatureServer ve diğer gerçekten kullanılan servis türleri önceliklidir.
- Servis tipleri kesinleşmeden veri sağlayıcısı varsayımı yapma; gerçek endpoint ve response şemasını incele.

## Tablo + JSON ikon eşleştirme standardı
- Uygulamadaki tablo/kayıt verilerinde bulunan tür/kategori/öznitelik ile JSON ikon konfigürasyonundaki karşılığı deterministik biçimde eşleştir.
- Her mekânsal nokta için türüne uygun ikon kullanılmasını sağla; fallback ikon, bilinmeyen tür, eksik JSON kaydı ve hatalı veri durumlarını kontrollü ele al.
- İkon çözümleme tekilleştirilmiş bir resolver/registry üzerinden çalışmalı; aynı eşleştirme mantığı 2D, 3D ve liste/table görünümünde mümkün olduğunca paylaşılmalı.
- İkon asset'leri optimize edilmeli; gereksiz büyük görseller, tekrar indirilen dosyalar ve render maliyeti azaltılmalı.

## Tasarım ve mimari
21st.dev, shadcn/ui, modern React/Tailwind desenleri, enterprise dashboard ve modern GIS ürünlerinin iyi mimari/tasarım kalıplarından yararlan. İçeriği/lisansı belirsiz premium materyali izinsiz kopyalama; desenleri mevcut projeye adapte et.

## GIS / 3D
Mevcut teknoloji yığınıyla uyumlu olacak şekilde ArcGIS Maps SDK for JavaScript, CesiumJS, Three.js, deck.gl ve ilgili WebGL/WebGPU yaklaşımlarını değerlendir. 3D; terrain, buildings, 3D Tiles/glTF, kamera, katman, seçim, popup, ölçüm ve performans optimizasyonu ile ele alınmalıdır. Gereksiz teknoloji değişiminden kaçın.

## Güvenlik
Secret/API key/parola kaynak koda gömülmez. XSS, injection, unsafe HTML, token handling, dependency riskleri, CORS ve input validation kontrol edilir. Server-side authorization ve veri minimizasyonu tercih edilir.

## Performans
Core Web Vitals, bundle size, lazy loading, code splitting, memoization, virtualization, asset optimization, request deduplication, cache invalidation, render maliyeti, large dataset strategy ve 2D/3D GPU/CPU kullanımı dikkate alınır. Sadece network çağrısını azaltmak yeterli sayılmaz; hesaplama ve render maliyeti de ölçülür.

## Git / PR / Merge
Çalışmayı mümkünse `agent/<alan>-<tarih>` branch'ında yap. Commit mesajı `feat(<alan>): <özet>` formatında olsun. PR oluşturulabilen ortamda PR aç. Merge öncesi build/test doğrula. Başka bir branch'ı force push veya ezme yapma.

## Merge safety / branch lifecycle — ZORUNLU
- Her turun başında `origin/main` yeniden fetch edilmelidir; çalışma branch'i o anki güncel `origin/main` commitinden oluşturulmalıdır.
- Daha önce merge edilmiş, squash-merge edilmiş, rebase-merge edilmiş veya kapatılmış bir PR'ın branch'ini yeni tur için yeniden kullanma. Her yeni tur için benzersiz branch adı kullan: `agent/<alan>-<YYYYMMDD-HHMM>-<mainShortSha>` benzeri.
- Aynı role ait açık PR varsa yeni iş eklemeden önce PR'ın `mergeable` durumu, CI sonucu, head SHA, base SHA ve gerçek merge-base'i kontrol edilmelidir. Branch `main`e göre `behind`/`diverged` ise veya merge-base güncel tur başlangıç SHA'sı değilse eski branch üzerine yeni iş yığma.
- Squash merge sonrası eski commit zincirini yeni PR'a taşımak yasaktır. Gerekirse yalnızca `main`de bulunmayan doğrulanmış değişiklikleri temiz güncel `main` tabanına cherry-pick/yeniden uygulama ile taşı; eski branch'in tüm tree'sini körlemesine kopyalama.
- PR açmadan hemen önce `origin/main` tekrar fetch edilmelidir. Base ilerlediyse branch'i güncelle, conflictleri branch üzerinde çöz ve test/lint/typecheck/build doğrulamasını tekrar çalıştır.
- GitHub `mergeable=true` olmadan, gerekli CI/check'ler başarıyla tamamlanmadan ve regresyon kontrolü yapılmadan merge etme. Draft/conflicted PR merge edilmeye çalışılmamalıdır.
- Merge işleminden sonra yalnızca GitHub `merged=true` sonucu ve `main` üzerinde beklenen değişikliğin bulunduğu doğrulanırsa tur merge edilmiş sayılır.
- Stale/superseded PR'ları açık bırakıp yeni PR yığma. Önce hangi PR'ın kanonik olduğunu belirle; artık kullanılmayacak PR'ı açıkça superseded olarak kapat.
- `KENT_REHBERI_PROGRESS.md` ortak dosyadır. Güncel `main` sürümünü baz al, mümkün olduğunca role-scoped append yap, diğer ekiplerin kayıtlarını silme veya tek taraflı overwrite etme; conflict varsa iki tarafın kayıtlarını koruyarak çöz.
- Aynı dakikada çalışan otomasyonların aynı repo/ortak dosyalara yazabileceğini varsay. Her merge öncesi son bir `main` refresh + mergeability kontrolü zorunludur; zamanlama çakışması branch güvenliği yerine geçmez.

## Sonraki görev için durum bırakma
`KENT_REHBERI_PROGRESS.md` içinde tamamlanan işler, devam eden işler, bilinen sorunlar, test/build sonucu, son commit/PR/merge durumu ve sonraki görev için notları güncelle.

## Tur sonu raporu
TUR / GÖREV / BRANCH / COMMIT / PR / MERGE DURUMU / ÖNEMLİ ÖZELLİKLER / DEĞİŞEN DOSYALAR / YAKLAŞIK SATIR / TESTLER / BUILD / NETWORK DEĞİŞİKLİKLERİ / GÜVENLİK KONTROLLERİ / İKON EŞLEŞTİRME / MODERNİZASYON KARARLARI / PERFORMANS ETKİSİ / ÇÖZÜLEN HATALAR / KALAN SORUNLAR / SONRAKİ GÖREV NOTU alanlarını kaydet.

## Görev sırası
1 Architecture / Platform
2 UI/UX + Visual Quality
3 2D GIS + 3D GIS + Spatial Engine
4 GIS Data/Services
5 Search/Address
6 Performance
7 Security
8 Accessibility/Responsive
9 Testing/Observability
10 Final QA/Release

Üç aktif uzman ekip bu alanları dağıtarak ilerler. Her görev önceki görevlerin durumunu kontrol etmeli ve kendi uzmanlık alanına odaklanmalıdır. Hiçbir görev başka bir görevin işini gereksiz yere geri almamalıdır.
