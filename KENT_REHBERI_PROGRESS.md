# Kent Rehberi — Geliştirme İlerleme Kaydı

## Başlangıç Durumu
- Ortak agent kuralları repository'ye eklendi.
- Ana kural dosyası: `KENT_REHBERI_AGENT_RULES.md`
- Sıralı görev alanları: Architecture → UI/UX → 2D GIS → 3D GIS → GIS Data/Services → Search/Address → Performance → Security → Accessibility/Responsive → Final QA/Release

## Son İşlem
- İşlem: Experience UI temelinin ve kurumsal GIS tasarım sözleşmesinin eklenmesi
- Durum: tamamlandı
- Eklenen belge: `docs/experience-ui-foundation.md`
- İncelenen uygulama: `Webclient.app`
- Mevcut stack gözlemi: React 17, react-scripts 4, Bootstrap 5, react-bootstrap, Font Awesome, react-icons, Redux, esri-loader, axios
- Not: WMS/WFS eklenmedi. UI görevi mevcut GIS davranışlarını koruyacak şekilde tasarım sistemi ve erişilebilirlik temeliyle sınırlı tutuldu.

## Yapılanlar
- AppShell, header/sidebar, map toolbar, layer tree, legend, search, feature details, table, toast, command palette, settings ve onboarding için ortak UI sözleşmesi tanımlandı.
- Responsive desktop/tablet/mobile yerleşim modeli belirlendi.
- Dark/light tema, reduced-motion, WCAG, keyboard navigation, visible focus, ARIA ve screen-reader gereksinimleri tanımlandı.
- Harita paneli yoğunluğu, loading/empty/error durumları ve 2D/3D geçiş tutarlılığı için tasarım kuralları eklendi.
- UI performansı için lazy-load, virtualization, asset bütçesi ve gereksiz re-render önleme ilkeleri kaydedildi.

## Network / Veri Politikası
- Gereksiz üçüncü taraf çağrıları, remote font/CDN/analytics ve dış asset istekleri eklenmeyecek.
- Browser'a ulaşan verinin Network panelinden tamamen gizlenemeyeceği kabul edildi; sahte gizlilik garantisi verilmeyecek.
- Uygulama verisi için same-origin/BFF/server-side taşıma Platform ekibiyle koordineli ilerleyecek.

## İkon Eşleştirme Politikası
- Tür/kategori → JSON ikon konfigürasyonu → deterministic shared icon resolver/registry yaklaşımı kullanılacak.
- Liste, tablo, 2D marker ve 3D gösterimde aynı kaynak mümkün olduğunca paylaşılacak.
- Eksik/unknown türler erişilebilir ve görsel olarak tutarlı fallback ile gösterilecek.

## Test / Doğrulama
- Bu turda repository içeriği ve `Webclient.app/package.json` incelendi.
- Stack doğrulandı; mevcut UI altyapısının React 17 + Bootstrap/react-bootstrap ağırlıklı olduğu görüldü.
- Bu çalışma ortamında uygulama build/lint/test komutları çalıştırılmadı; sonraki kod turunda doğrulanacak.

## Sonraki İşlem
- Experience: `docs/experience-ui-foundation.md` sözleşmesini gerçek `Webclient.app/src` bileşenlerine kontrollü biçimde uygulamak; önce mevcut `App.js`, `styles.css`, `styles.responsive.css` ve ana bileşenleri analiz etmek.
- GIS Engine: icon resolver/registry ve gerçek JSON ikon kaynağını bulup ortaklaştırmak; WMS/WFS eklememek.
- Platform: Network çağrıları, .env, same-origin/BFF uygunluğu ve build/test otomasyonunu doğrulamak.

## Platform Tur 2 — 2026-09-15
- İşlem: Güvenli yapılandırma ve network politikası temeli
- Commitler:
  - `b706a8c4a217add97919400b444c915b7828eceb` — `.gitignore` ile local environment dosyaları ignore edildi.
  - `decf93e85dd5bfeed363b5b357ca6cc8d0a0f035` — `Webclient.app/.env.example` eklendi.
  - `0d90226b91cbed46a041e2cd0c4f3a083d705537` — committed client key kaldırıldı, debug/source map kapatıldı, API base same-origin `/api` yapıldı.
- Merge: değişiklikler varsayılan `main` branch'ına işlendi; ayrı PR açılmadı.
- Doğrulanan riskler: `Webclient.app/.env` sürümleniyordu; client-exposed key, debug ve source-map ayarları vardı. `Webclient.app/package.json` React 17 + react-scripts 4 ve eski dependency/IE hedefleri içeriyor; ölçmeden kör migration yapılmamalı.
- Network: browser'a ulaşan verinin Network panelinden tamamen gizlenemeyeceği kabul edildi. Aynı-origin/BFF, server-side authorization, data minimization, least privilege, cache, deduplication, timeout ve cancellation sonraki uygulama işlerinin temeli olacak.
- WMS/WFS: yeni entegrasyon eklenmedi. Gerçek kullanılan ArcGIS REST/MapServer/FeatureServer endpointleri sonraki kod envanterinde doğrulanacak.
- İkon: runtime resolver henüz uygulanmadı; gerçek JSON ikon kaynağı bulunduğunda shared deterministic registry/resolver oluşturulacak.
- Test/build: connector turunda lokal checkout/komut çalıştırma olmadığından npm test/build/lint/typecheck çalıştırılamadı.
- Sonraki Platform adımı: dış endpoint envanteri, API client ve error model, same-origin proxy/BFF doğrulaması, config separation, shared types ve ölçüm tabanlı modül bazlı modernizasyon planı.

## GIS Engine Tur 2 — 2026-09-15
- İşlem: Ortak GIS servis yönetişimi ve JSON ikon çözümleyici temeli
- Commitler:
  - `66cd1e9e5e3552785dde9e64329fb5bc06f018c1` — `Webclient.app/src/gis-engine/serviceRegistry.js`
  - `b8dac96c371fcdee180e810aa5fb413fa4d25215` — `Webclient.app/src/gis-engine/iconResolver.js`
- Özellikler: merkezi servis kaydı, timeout, sınırlı retry/backoff, health state, kontrollü GIS hata modeli; tür/kategori/kind/className/iconKey/id alanlarından deterministik JSON ikon eşleştirme, alias ve fallback.
- WMS/WFS: eklenmedi.
- Merge: commitler varsayılan `main` branch'ına işlendi; ayrı PR açılmadı.
- Test/build: bu connector turunda lokal npm komutları çalıştırılamadı; sonraki turda gerçek import noktaları, resolver'ın 2D/3D/table bileşenlerine entegrasyonu ve smoke/regression testleri.

## Platform Tur 3 — 2026-09-15
- İşlem: API istemci sınırı, cache/deduplication, endpoint policy, safe storage, observability ve backend hardening.
- Branch: `agent/platform-2026-09-15`
- Değişen/eklenen dosyalar:
  - `Webclient.app/src/platform/config/runtimeConfig.js`
  - `Webclient.app/src/platform/cache/requestCache.js`
  - `Webclient.app/src/platform/errors/appError.js`
  - `Webclient.app/src/platform/http/httpClient.js`
  - `Webclient.app/src/platform/security/safeStorage.js`
  - `Webclient.app/src/platform/network/endpointPolicy.js`
  - `Webclient.app/src/platform/observability/logger.js`
  - `Webclient.app/src/platform/index.js`
  - `Webclient.app/src/platform/platform.test.js`
  - `Webclient.app/src/gis-engine/serviceRegistry.js`
  - `Api.User/Startup.cs`
  - `Api.User/appsettings.json`
  - `docs/platform-network-policy.md`
  - `.github/workflows/webclient-ci.yml`
- Yaklaşık değişiklik: ~500+ anlamlı yeni/değişmiş satır. 4000 satır hedefi özellikle doldurulmadı; platform omurgası için gerçek işlev odaklı ilk kontrollü dilim tamamlandı.
- Network: yeni genel cross-origin trafik açılmadı. Browser API varsayılanı same-origin `/api`; cache ve concurrent GET deduplication eklendi. Timeout/cancellation ve güvenli GET/HEAD retry/backoff eklendi. WMS/WFS/WMTS policy dışı bırakıldı; mevcut ArcGIS REST servisleri için kontrollü istisna bırakıldı.
- Güvenlik: `Api.User/appsettings.json` içindeki sürümlenmiş DB credential'ları kaldırıldı. DB connection string artık server environment/secret store üzerinden verilmek zorunda. CORS izinleri `Cors:AllowedOrigins` konfigürasyonuna taşındı ve boş liste varsayılanında cross-origin erişim açılmıyor. Exception response artık exception/inner exception ayrıntılarını istemciye vermiyor; trace id loglanıyor. API güvenlik başlıkları (`nosniff`, `no-referrer`, `X-Frame-Options`) eklendi.
- Token/storage: client secret/token storage helper eklenmedi; session/local storage yalnızca hassas olmayan geçici uygulama durumu için sınırlandı ve auth token için HttpOnly/Secure/SameSite cookie önerildi.
- Observability: structured, redaction-aware browser logger eklendi; token/password/API key/authorization/cookie alanları logdan çıkarılıyor.
- İkon: mevcut resolver/registry korunuyor; bu turda 2D/3D/table entegrasyonu yapılmadı.
- CI: Webclient için Node 18 + npm ci + test + production build workflow eklendi; dependency audit advisory olarak çalışıyor. Lint/typecheck için mevcut stack'te ayrı komut bulunmadığından yeni sahte komut eklenmedi.
- Test/build: GitHub connector ortamında lokal checkout/Node/.NET runtime çalıştırılamadığı için bu turda komut sonucu doğrulanamadı. CI workflow PR açıldıktan sonra otomatik doğrulama amacıyla eklendi.
- Kalan riskler: `Api.User` ve diğer API projelerinin gerçek upstream/third-party endpoint envanteri henüz tam çıkarılmadı; secret rotation'ın gerçek altyapıda uygulanması gerekir; frontend'in mevcut dağınık axios çağrıları henüz yeni `ApiClient`'a migrate edilmedi; browser CSP ve static hosting headers ayrı bir release/security turunda ölçülmeli.
- Sonraki görev notu: PR CI sonucu kontrol edilmeli. Başarılıysa merge doğrulanmalı. Sonraki Platform turunda mevcut axios call-site envanteri çıkarılarak yalnızca yüksek trafik/tekrar eden GET akışları kontrollü biçimde `ApiClient`'a taşınmalı; ardından performance metrics ve BFF adapter sınırları eklenmeli.

## Kurallar
Her görev önce `KENT_REHBERI_AGENT_RULES.md`, ardından kendi görev kuralını ve bu dosyayı okumalıdır. Önceki değişiklikler korunmalı; çakışma ve overwrite önlenmelidir.
