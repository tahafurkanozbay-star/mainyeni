# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Bu dosyanın PR #414 kapanış checkpoint’inden hemen önceki **tam ve verbatim** sürümü [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261001_PRE_PR414.md`](./KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261001_PRE_PR414.md) içinde aynı Git blob SHA ile korunur. Daha eski arşiv zinciri de o dosyanın içindeki bağlantılar üzerinden korunmaktadır.

## Deep Platform / verified request-governance modernization — PR #422 merged — 2026-10-01
- TUR / GÖREV: Deep Platform / Whole-Code Modernization; forwarded-proxy trust, privacy-preserving client partitioning, bounded request concurrency, strict request framing/content/target governance, rate-limit partition consolidation ve backend CI diagnostics hardening.
- KAPSAM / GATE: PR #422 product head `dc68043e591ebbb7a6d3a5b3f0dc127e0dbe0d06`; 27 changed files, 4,142 meaningful additions / 748 deletions. Mandatory >=4,000 additions gate’i gerçek Platform policy/runtime/test/CI kapsamıyla karşılandı.
- CI: Platform Architecture Audit `36882792061`, Platform Backend Validation `36882792068` ve Release QA `36882792093` completed+success.
- MERGE SHA: `3b71b6f7a81dda58ab2d1941b3ef54eddb272f69`. Bu branch yeniden kullanılmaz.

## Deep Platform / operational request lifecycle — PR #423 implementation checkpoint — 2026-10-01
- TUR / GÖREV: graceful shutdown/drain, in-flight request accounting ve endpoint-class timeout/cancellation bütçeleri.
- BRANCH / PR: `agent/platform-timeouts-20261001-1857-83d845f`; PR #423 open/draft. Başlangıç base/current main `83d845f9c42a8937363484b852832d3afa81da16`.
- UYGULAMA: `RequestLifecyclePolicy`, aggregate-only `RequestLifecycleCoordinator`, idempotent lease ve `RequestLifecycleMiddleware` eklendi. GET/HEAD/OPTIONS interactive-read, mutation methods mutation, explicit import/export/bulk paths bulk, health paths kısa ve drain-exempt sınıfına ayrılıyor. Shutdown başladığında ordinary yeni işler 503/no-store ile fail-closed reddediliyor; health probe yüzeyi drain sırasında çalışabiliyor. Per-request linked cancellation budget controller/model binding zincirine `RequestAborted` üzerinden taşınıyor; timeout response başlamadıysa bounded 504 problem response üretiliyor.
- PRIVACY / MEMORY: lifecycle coordinator request body/query/claim/IP/HttpContext tutmuyor; yalnız aggregate counters ve monoton sequence kullanıyor. Lease disposal idempotent; in-flight accounting bounded ve underflow fail-closed.
- CONFIG: `Platform:Lifecycle` read=20s, mutation=30s, bulk=60s, health=5s, shutdown-drain=25s defaultları eklendi; registration boundary range ve health<=read invariant validation uyguluyor.
- TEST: `RequestLifecyclePolicyTests` classification, health exemption, drain rejection, idempotent lease ve ApplicationStopping transition davranışlarını kapsıyor.
- NETWORK / GIS / SECURITY: yeni endpoint, browser transport, WMS/WFS/WMTS, telemetry, remote asset, secret, identity partitioner veya limiter authority eklenmedi.
- GATE: GitHub base...head bu checkpoint öncesinde yalnız 508 additions / 544 deletions gösteriyordu; mandatory >=4,000 additions gate’i henüz çok uzakta. PR kesinlikle merge edilmemeli.

## Deep Platform / PR #423 build-diagnostics hardening checkpoint — 2026-10-01
- EXACT FAILED HEAD: `d0e8addb1ef509f6e5f74f4fa53766ef0f42075b`. Platform Architecture Audit completed+success; Platform Backend Validation `36911133457` ve Release QA `36911133353` completed+failure. Backend validation restore, SDK diagnostics ve NuGet vulnerability report geçti; failure `Build Release` adımında oluştu, xUnit/publish çalışmadı.
- DIAGNOSTIC GAP: mevcut workflow yalnız xUnit logunu artifact'e alıyordu. Build xUnit'ten önce kırıldığında artifact adımı `if-no-files-found:error` ile ayrıca failure üretiyor ve compiler diagnostic gövdesi connector yüzeyinde görünmüyordu. Tahmine dayalı üçüncü ürün repair'i yapılmadı.
- CI HARDENING: commit `d2fafe5a250c5dede65083e1623bbf4159b3db9f` Release build çıktısını `tee` ile bounded build diagnostic loguna alıyor; build failure summary + error annotation çıkarıyor ve build/test diagnostics'i tek always-upload artifact altında koruyor. Scanner status >1 fail-closed; no-match status 1 diagnostic-only kabul ediliyor.
- GATE / MERGE: PR #423 open/draft, mergeable=true ve son doğrulanan metadata'da 526 additions / 580 deletions / 9 dosya; mandatory >=4,000 additions gate'i sağlanmadığından merge yasak. Yeni progress commit yeni exact head yaratır; üç mandatory workflow completed+success olmadan PASS ilan edilmez.
- SHARED PROGRESS NOTE: bu branch'in progress sürümü önceki turlarda GIS/Experience canonical kayıtlarını düşürmüş durumda; final merge lineage/reconciliation sırasında current-main canonical progress baz alınmalı ve bu Platform checkpoint role-scoped append olarak taşınmalı. Ortak kayıtlar silinerek merge edilmemeli.
- SONRAKİ GÖREV: yeni exact-head CI'dan görünür compiler finding'i al, ürünü gerçek finding'e göre düzelt ve ikinci doğrulamayı çalıştır. Sonra bounded drain completion, merkezi lifecycle validation, degraded-readiness/database cancellation governance ve adversarial integration coverage ile anlamlı Platform kapsamını büyüt; >=4,000 additions olmadan merge etme.
