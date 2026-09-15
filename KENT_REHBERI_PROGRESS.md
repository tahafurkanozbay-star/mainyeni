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

## Platform Tur 2 — 2026-09-15
- İşlem: Güvenli yapılandırma ve network politikası temeli
- Commitler:
  - `b706a8c4a217add97919400b444c915b7828eceb`
  - `decf93e85dd5bfeed363b5b357ca6cc8d0a0f035`
  - `0d90226b91cbed46a041e2cd0c4f3a083d705537`
- Merge: değişiklikler varsayılan `main` branch'ına işlendi; ayrı PR açılmadı.
- Test/build: connector turunda lokal komut çalıştırma yoktu.

## GIS Engine Tur 2 — 2026-09-15
- İşlem: Ortak GIS servis yönetişimi ve JSON ikon çözümleyici temeli
- Commitler:
  - `66cd1e9e5e3552785dde9e64329fb5bc06f018c1`
  - `b8dac96c371fcdee180e810aa5fb413fa4d25215`
- Özellikler: merkezi servis kaydı, timeout, sınırlı retry/backoff, health state, kontrollü GIS hata modeli; tür/kategori/kind/className/iconKey/id alanlarından deterministik JSON ikon eşleştirme, alias ve fallback.
- WMS/WFS: eklenmedi.
- Test/build: lokal npm komutları çalıştırılamadı.

## Platform Tur 3 — 2026-09-15
- İşlem: API istemci sınırı, cache/deduplication, endpoint policy, safe storage, observability, CI ve backend security hardening.
- Branch: `agent/platform-2026-09-15`
- Son commit: `8c25f7335b5c8b94d9329ee3d7aac98f73a3964e` — `ci(platform): validate agent branches before merge`
- PR: #1 — `feat(platform): harden network, security and API boundaries`
- PR durumu: açık, mergeable/conflict-free doğrulandı; merge edilmedi çünkü repository connector üzerinden gerçek CI job sonucu oluşmadı ve lokal runtime çalıştırılamadı.
- Değişen/eklenen dosyalar: `Webclient.app/src/platform/config/runtimeConfig.js`, `cache/requestCache.js`, `errors/appError.js`, `http/httpClient.js`, `security/safeStorage.js`, `network/endpointPolicy.js`, `observability/logger.js`, `index.js`, `platform.test.js`; `Webclient.app/src/gis-engine/serviceRegistry.js`; `Api.User/Startup.cs`; `Api.User/appsettings.json`; `docs/platform-network-policy.md`; `.github/workflows/webclient-ci.yml`; `KENT_REHBERI_PROGRESS.md`.
- Yaklaşık değişiklik: 1000+ satır toplam PR farkı; bunun tamamı gerçek platform işlevi/konfigürasyon/security/docs/test kodudur. 4000 satır yapay dolgu yapılmadı.
- Network: browser API varsayılanı same-origin `/api`; cache ve concurrent GET deduplication; timeout/cancellation; safe GET/HEAD retry/backoff; explicit endpoint policy; keyfi cross-origin endpointler engelleniyor. WMS/WFS/WMTS eklenmedi.
- Güvenlik: `Api.User/appsettings.json` içindeki sürümlenmiş DB credential'ları kaldırıldı. DB bağlantısı server environment/secret store üzerinden zorunlu hale getirildi. CORS `Cors:AllowedOrigins` ile açıkça yapılandırılıyor ve boş varsayılan cross-origin erişim açmıyor. Exception response artık exception/inner exception detaylarını sızdırmıyor; trace id server logunda tutuluyor. API `nosniff`, `no-referrer`, `X-Frame-Options` başlıkları eklendi.
- Storage/token: istemci token/secret depolama helper'ı eklenmedi; geçici uygulama durumu için güvenli storage wrapper var; auth için HttpOnly/Secure/SameSite cookie politikası dokümante edildi.
- Observability: redaction-aware structured logger token/password/API-key/authorization/cookie gibi alanları gizliyor.
- İkon: mevcut shared resolver/registry değişmeden korunuyor; gerçek JSON kaynağı entegrasyonu sonraki GIS/Experience turuna bırakıldı.
- CI: `.github/workflows/webclient-ci.yml` ile Node 18 + `npm ci` + test + production build + advisory audit tanımlandı. Agent branch'larında da doğrulama tetikleyicisi eklendi.
- Test/build: Bu GitHub bağlantı ortamında lokal Node/.NET komutları çalıştırılamadı. PR head için GitHub Actions workflow run sorgusu bu connector'da boş döndü; bu nedenle test/build PASS iddiası yapılmıyor.
- Kalan riskler: API projelerinin tamamındaki gerçek upstream endpoint envanteri henüz bitmedi; geçmiş git tarihindeki credential'ların güvenli kabulü için gerçek secret rotation gerekir; mevcut frontend axios call-site'ları yeni client'a henüz topluca taşınmadı; CSP/static hosting header politikası ayrı release/security turunda doğrulanmalı.
- Sonraki görev: PR #1 için gerçek CI sonucu/merge akışını doğrula. Sonraki Platform turunda axios call-site envanteri çıkar, yüksek tekrar/traffic GET akışlarını kontrollü `ApiClient` adapter'larına taşı ve Core Web Vitals/network timing ölçümleri ekle.

## Genel Kurallar
Her görev önce `KENT_REHBERI_AGENT_RULES.md`, ardından kendi görev kuralını ve bu dosyayı okumalıdır. Önceki değişiklikler korunmalı; çakışma ve overwrite önlenmelidir.
