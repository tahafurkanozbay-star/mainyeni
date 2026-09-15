# Kent Rehberi — Geliştirme İlerleme Kaydı

## Platform Tur 3 — 2026-09-15
- Görev: API istemci sınırı, cache/deduplication, endpoint policy, safe storage, observability, CI ve backend security hardening.
- Branch: `agent/platform-2026-09-15`
- Son anlamlı kod commit'i: `2553a249d2c350600ff690851400e0985d828812` — runtime config environment-safety düzeltmesi.
- PR: #1 — `feat(platform): harden network, security and API boundaries`.
- PR durumu: açık; merge edilmedi. Branch `main` ile karşılaştırmada main'in branch'ten 2 commit ileride olduğu doğrulandı; güvenli biçimde rebase/merge edilmeden PR kapatılmadı ve force-push yapılmadı.
- Değişen alanlar: shared runtime config, request cache/dedup, normalized error model, cancellation-aware API client, safe storage, outbound endpoint policy, privacy-safe logger, GIS service registry, `Api.User` CORS/exception/security headers, DB secret removal, CI workflow ve network policy dokümantasyonu.
- Yaklaşık değişiklik: ~1000 anlamlı satır toplam PR farkı. 4000 satır hedefi yapay biçimde doldurulmadı.
- Network: browser API varsayılanı same-origin `/api`; cache + concurrent GET deduplication; timeout/cancellation; safe GET/HEAD retry/backoff; keyfi cross-origin endpointler varsayılan engelli. WMS/WFS/WMTS entegrasyonu yok.
- Güvenlik: `Api.User/appsettings.json` içindeki sürümlenmiş DB credential'ları kaldırıldı; DB connection string server environment/secret store'a taşındı. CORS explicit `Cors:AllowedOrigins`; exception detayları client'a sızdırılmıyor; `nosniff`, `no-referrer`, `X-Frame-Options` eklendi.
- Token/storage: auth token için client-side generic token storage oluşturulmadı; HttpOnly/Secure/SameSite cookie yaklaşımı dokümante edildi.
- Observability: redaction-aware structured browser logger.
- İkon: mevcut deterministic shared resolver/registry korunuyor; gerçek 2D/3D/table call-site entegrasyonu bu turda yapılmadı.
- CI: Webclient CI workflow Node 18 + `npm ci` + test + production build + advisory audit tanımlıyor ve `agent/**` branch push'larını da doğrulamak üzere yapılandırıldı.
- Test/build: bu bağlantı ortamında lokal Node/.NET runtime yok; GitHub Actions workflow run sorgusu görünür bir job döndürmedi. Bu nedenle test/build PASS iddiası yapılmıyor.
- Git status: lokal çalışma ağacında `git status` çalıştırılamadı; remote branch SHA/PR/compare durumları doğrulandı.
- Merge: PR #1 açık ve merge edilmedi. Merge güvenliği için main'in 2 commit ileride olması nedeniyle bu turda otomatik merge yapılmadı.
- Kalan riskler: git geçmişine girmiş credential'lar gerçek sistemde rotate/revoke edilmelidir; mevcut dağınık axios call-site'ları yeni client'a henüz kademeli taşınmadı; gerçek BFF/upstream endpoint envanteri tamamlanmalı; CSP/static hosting headers ayrıca doğrulanmalı.
- Sonraki görev: önce PR #1 için main ile güvenli senkronizasyon ve CI sonucu doğrulansın; ardından yüksek trafik/tekrarlı axios GET çağrıları ölçülerek `ApiClient` adapter'larına kademeli migrate edilsin ve Core Web Vitals/network timing ölçümü eklensin.

## Kurallar
Her görev önce `KENT_REHBERI_AGENT_RULES.md`, ardından kendi görev kuralını ve bu dosyayı okumalıdır. Önceki değişiklikler korunmalı; çakışma ve overwrite önlenmelidir.
