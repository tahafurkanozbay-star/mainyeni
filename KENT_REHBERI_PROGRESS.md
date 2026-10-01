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
- GATE: GitHub base...head bu checkpoint öncesinde yalnız 508 additions / 544 deletions gösteriyordu; mandatory >=4,000 additions gate’i henüz çok uzakta. PR kesinlikle merge edilmemeli. Yeni exact head CI henüz oluşmadı; Platform Backend Validation/Architecture Audit/Release QA sonuçları gelmeden PASS ilan edilmemeli.
- SONRAKİ GÖREV: CI compile/test bulgularını düzelt; lifecycle validation’ı merkezi validator içine taşı; database cancellation/degraded-readiness state authority, shutdown drain completion/timeout behavior ve adversarial middleware/integration testlerini gerçek kapsamla ekle. 4,000 meaningful additions eşiğine ulaşana kadar aynı PR üzerinde devam et.

## Deep Platform / PR #423 CI repair checkpoint — 2026-10-01
- EXACT FAILED HEAD: `0af67c315fc0f49fe03dac901a8a2f6661ca9a9d`. Platform Architecture Audit success; Platform Backend Validation ve Release QA backend lane Release build aşamasında failure. Typed release audit ve webclient release validation success.
- ROOT CAUSE / REPAIR: lifecycle policy health-path karşılaştırması `PathString.Equals(string, StringComparison)` biçiminde geçersiz overload kullanıyordu. Karşılaştırma `path.Value` üzerinde `string.Equals(..., OrdinalIgnoreCase)` ile compile-safe hale getirildi; repair commit `654c552a16ed214f9f969eb25274988987d70da8`.
- GATE: PR #423 bu repair öncesi 512 additions / 581 deletions ve draft/open/mergeable=true idi; mandatory >=4,000 additions sağlanmadığından merge yasak. Repair/progress exact head workflow’ları yeniden completed+success doğrulanmalı.
- SONRAKİ GÖREV: yeni exact head CI sonucunu kontrol et; kalan compile/test finding varsa düzelt. Ardından merkezi lifecycle validation, bounded drain completion semantics, degraded-readiness/database cancellation governance ve adversarial integration coverage ile aynı PR üzerinde anlamlı Platform kapsamını büyüt.

## Deep Platform / PR #423 second build repair checkpoint — 2026-10-01
- EXACT FAILED HEAD: `6b0a4b42beab87629e836a0ec470897e0e2605d7`. Platform Architecture Audit `36903490437` completed+success; Platform Backend Validation `36903490454` ve Release QA `36903490635` completed+failure. Backend validation restore ve NuGet audit geçti, failure `Build Release` adımında oluştu.
- ROOT CAUSE / REPAIR: lifecycle entegrasyonu sırasında `ApiPlatformApplicationExtensions.cs` içindeki `Microsoft.AspNetCore.HttpOverrides` using'i kaldırılmıştı; ancak `UseForwardedHeaders(...)` extension method'u bu namespace üzerinden çözülüyor. Existing forwarded-proxy authority değiştirilmeden using geri eklendi. Repair commit `1254a17ce68e22bddc99590608d608fb9e9fbf58`.
- GATE / MERGE: PR open/draft ve mandatory >=4,000 additions eşiğinin altında; merge yapılmaz. Bu progress write yeni exact head oluşturacağından üç workflow yeniden completed+success doğrulanmalıdır.
- SECURITY / REGRESSION: forwarded-header trust policy semantiği değiştirilmedi; yalnız compile-time extension resolution restore edildi. Yeni endpoint, WMS/WFS/WMTS, browser transport, secret, telemetry veya remote asset eklenmedi.
- SONRAKİ GÖREV: yeni exact-head backend build/test sonucunu doğrula. Yeşil olduğunda aynı PR'da merkezi lifecycle validation, bounded drain completion, degraded-readiness/database cancellation governance ve adversarial middleware/integration testleriyle anlamlı kapsamı büyüt; >=4,000 additions gate sağlanmadan merge etme.
