# Kent Rehberi — Geliştirme İlerleme Kaydı

## Başlangıç Durumu
- Ortak agent kuralları repository'ye eklendi.
- Ana kural dosyası: `KENT_REHBERI_AGENT_RULES.md`
- Görev sırası: Architecture / Platform → UI/UX → 2D GIS + 3D GIS + Spatial Engine → GIS Data/Services → Search/Address → Performance → Security → Accessibility/Responsive → Testing/Observability → Final QA/Release

## Platform Tur 2 — 2026-09-15
- Güvenli yapılandırma temeli tamamlandı.
- `.gitignore` local environment dosyalarını ignore ediyor; `.env.example` eklendi; client key/debug/source map riskleri azaltıldı; API base same-origin `/api` oldu.

## GIS Engine Tur 2 — 2026-09-15
- `Webclient.app/src/gis-engine/serviceRegistry.js` ve `iconResolver.js` eklendi.
- Servis timeout/retry/health state ve deterministik tür/kategori ikon çözümleme temeli kuruldu.
- WMS/WFS eklenmedi.

## GIS Engine Tur 3 — 2026-09-15
- Branch: `agent/gis-engine-2026-09-15`
- PR: `#2`
- Head commit: `a32f6f2f7a66a8c14b60a322953dca4e509f8d7d`
- Merge commit: `1140467cfe88e73f5fdae1fd112f1862949d0d12`
- Merge durumu: PR #2 kapalı ve gerçekten merged.
- `serviceCatalog.js`, `layerRuntime.js`, `spatialEngine.js` eklendi; ArcGIS REST tabanlı servis türleri ve 2D/3D/spatial helper sınırları tanımlandı.
- WMS/WFS/WMTS/OGC varyantları reddediliyor. Gerçek JSON ikon kaynağı bulunmadan sahte mapping üretilmedi.

## Experience/UI Quality Tur — 2026-09-15
- PR #3 conflict nedeniyle kapatıldı; force-push yapılmadı.
- PR #4 `agent/experience-ui-2026-09-15-r2` ile merged Experience katmanı, erişilebilir GIS command center, responsive/dark-light/reduced-motion tasarım sistemi ve CI tabanı eklendi.
- UI turunda yeni remote font/CDN/analytics/third-party asset çağrısı eklenmedi.
- Shared JSON GIS icon presentation sonraki main commits ile gerçek `SharedGISIcon` yüzeyine taşındı.

## Platform Deep Engineering Tur — 2026-09-15

### Başlangıç doğrulaması
- Güncel `main` tabanı bu turun başında `71d8d54f9bae4e8ce8ee740aabee56cf5d6f203f` idi.
- `main` son paralel GIS/UI commitleriyle ilerlemişti; platform çalışması bu güncel tabandan yeni branch `agent/platform-deep-2026-09-15-r3` üzerinde yürütüldü. Önceki platform branch'ı ezilmedi.
- Eski Platform PR #1 açık ve merged değil olarak doğrulandı; yeni çalışma onun üzerine force-push yerine temiz güncel-main branch'ı ile yapıldı.

### Derin mimari bulguları
- Frontend: React 17, react-scripts 4, Bootstrap/react-bootstrap, Redux, esri-loader, axios. `package.json` içinde ayrıca eski IE9/IE11 uyumluluk hedefleri ve Node/webpack dönemi eski araçlar var. Ölçüm olmadan framework göçü yapılmadı.
- Backend: ASP.NET Core `net6.0`; EF Core 7 paketleri ve daha eski ASP.NET Core paketleri aynı projede karışık nesil oluşturuyor. CI/uyumluluk ölçümü olmadan toplu runtime yükseltmesi yapılmadı.
- `ConfigurationBusiness` gerçek bootstrap call-site'ı olarak incelendi; raw axios ve browser-generated bearer kullanıyordu.
- `AuthBusiness` içinde `REACT_APP_CLIENT_KEY` ile AES bearer üretildiği görüldü. `REACT_APP_*` değerlerinin browser bundle'ına girdiği için gizli sayılamayacağı doğrulandı.
- `Api.User/Controllers/Base/BaseUserApiController.cs` içinde API request AES secret'ının hard-coded olduğu doğrulandı.
- `Api.User/appsettings.json` ve `Api.Admin/appsettings.json` içinde gerçek DB credential'ları bulunduğu doğrulandı.
- `GisProxyController` generic URL fallback ve bypass yoluyla arbitrary upstream request kabul edebiliyordu; bu turdaki en yüksek etkili network/SSRF riski olarak ele alındı.
- Legacy `CommonBusiness.CreateLayer()` içinde WMSLayer dalı bulundu. Proje kuralı gereği yeni WMS/WFS/WMTS entegrasyonu eklenmedi ve legacy davranış GIS ekibinin kontrollü migration'ına bırakıldı.
- Beklenen CRA service worker/registration dosyaları repository'de yoktu; gerçek offline desteği varsayılmadı.
- `public/index.html` içinde ArcGIS SDK stylesheet CDN'i mevcut ve uygulamanın mevcut runtime bağımlılığı olarak korundu; yeni CDN eklenmedi.

### Uygulanan network/platform değişiklikleri
- `Webclient.app/src/platform/config/runtimeConfig.js`: API URL, timeout, cache TTL, retry, release, telemetry ve TKGM public config tek sınırda toplandı. Absolute/protocol-relative dış API URL'leri same-origin `/api`'ye düşürülüyor.
- `Webclient.app/src/platform/network/endpointPolicy.js`: uygulama client'ının yalnızca same-origin relative path kullanması zorunlu hale getirildi; `https://...` ve `//host` engelleniyor.
- `Webclient.app/src/platform/http/httpClient.js`: timeout, axios 0.21 uyumlu cancellation, bounded retry/backoff, normalized errors, opt-in GET/HEAD cache ve opt-in request deduplication eklendi. Caller-bound cancellation olduğunda promise sharing yapılmıyor.
- `Webclient.app/src/platform/cache/requestCache.js`: bounded in-memory TTL cache, LRU-benzeri touch/eviction ve prefix invalidation eklendi.
- `Webclient.app/src/platform/errors/appError.js`: 401/403/404/408/429/5xx/network/abort hata modeli ve güvenli kullanıcı mesajları tanımlandı.
- `Webclient.app/src/Business/ConfigurationBusiness.js`: map configuration ve GIS public service bootstrap çağrıları merkezi API client'a taşındı; public read cache TTL'si belirginleştirildi; browser-side secret header bağımlılığı kaldırıldı.
- `Webclient.app/src/Core/AppConfig.js`: legacy facade platform runtime config ile birleştirildi.
- `Webclient.app/.env`: tracked local environment dosyası kaldırıldı. `.env.example` artık client secret alanı içermiyor.

### Backend security/network
- `Api.User/Controllers/Base/ApiConfiguration.cs`: hard-coded API request secret kaldırıldı; secret config key ile server configuration'dan okunuyor.
- `Api.User/Controllers/Base/BaseUserApiController.cs`: missing server secret fail-closed; malformed bearer/crypto input kontrollü reddediliyor.
- `Api.User/Controllers/Core/AppSettingsController.cs`: public bootstrap yalnızca `GisMapConfig` key'i için izinli; diğer settings anahtarları dışarı açılmıyor.
- `Api.User/Controllers/Extensions/Gis/ConfigServiceController.cs`: sanitized public GIS descriptor endpointi anonymous/public bootstrap olarak sadeleştirildi.
- `Api.User/Controllers/Extensions/Gis/GisProxyController.cs`: arbitrary URL fallback ve `ByPassProxy` kaldırıldı. Proxy yalnızca server-owned opaque service identifiers üzerinden çalışıyor; target HTTPS `*.gissrv.org` sınırı, request body limiti, timeout, request cancellation ve kontrollü response handling eklendi.
- `Api.User/Startup.cs` ve `Api.Admin/Startup.cs`: CORS explicit `AllowedOrigins` konfigürasyonuna taşındı; boş liste varsayılanı cross-origin açmıyor. Exception response'ları raw exception detail vermiyor; trace id loglanıyor. `nosniff`, `no-referrer`, `X-Frame-Options` gibi güvenlik başlıkları eklendi. DB connection string server environment/secret store olmadan startup'ta fail ediyor.
- `Api.User/appsettings.json` ve `Api.Admin/appsettings.json`: repository'deki DB credential'ları kaldırıldı; secret/db connection artık server-side environment/secret store sorumluluğunda.

### Authentication notu
- Diğer eski authenticated endpointler hâlâ `AuthBusiness.GetRequestHeaders()` call-site'larına bağlı olabilir. Bu nedenle mevcut custom auth header sistemi global replace ile silinmedi.
- Bunun yerine public bootstrap flow secret bağımlılığından çıkarıldı ve server hard-coded secret kaldırıldı. Kalan auth migration, gerçek call-site envanteri + backend auth contract'ı ile ayrı kontrollü faz olarak bırakıldı.
- Git tarihçesinde daha önce commit edilmiş credential'ların kaldığı varsayılmalıdır; gerçek secret rotation/revocation operasyonu deployment sahibi tarafından yapılmalıdır.

### PWA / offline
- `Webclient.app/public/service-worker.js` eklendi. Yalnızca same-origin `static/`, `images/`, `fonts/` kaynaklarını cache'ler; `/api`, GIS ve form/POST trafiğini cache'lemez.
- Navigasyon için network-first shell fallback eklendi; offline durumda cached `index.html` kullanılabilir.
- `Webclient.app/src/platform/pwa/serviceWorkerRegistration.js` production-only registration sınırı sağlar.
- `Webclient.app/public/manifest.json` PWA install metadata'sı eklenmiştir.
- `Webclient.app/public/web.config`: güvenlik header'ları ve yalnızca hashed `/static` assetleri için cache policy eklendi.
- Gerçek GIS offline veri stratejisi eklenmedi; bu turda offline map data cache'lemesi bilinçli olarak yapılmadı.

### Frontend runtime / maintainability
- `App.js` içinde `WindowManager` state initializer'a alındı; bootstrap request cancellation/unmount guard eklendi; map config parsing ve empty service config kontrollü hale getirildi.
- `src/index.js` service worker registration'a bağlandı.
- Starter CRA `learn react` testi anlamlı bootstrap smoke test ile değiştirildi.
- `platform.test.js` runtime config, external URL blocking, endpoint policy, bounded cache, safe storage ve HTTP error normalization regression coverage sağlar.
- `safeStorage` yalnızca credential-like olmayan uygulama state anahtarlarını kabul edecek şekilde sınırlandı.
- Structured logger secret-shaped field redaction sağlar; browser telemetry varsayılanı kapalıdır.

### CI / build / dependency
- `.github/workflows/platform-webclient-validation.yml`: Node 20 ile `npm ci`, optional lint/typecheck, test, production build ve advisory npm audit.
- `.github/workflows/platform-backend-validation.yml`: .NET 6 restore/build for User/Admin APIs ve advisory vulnerable package listesi.
- Mevcut `Webclient Quality` workflow'undaki `--if-present` yaklaşımı korunarak sahte lint/typecheck script'i eklenmedi.
- Local Node/.NET execution bu connector ortamında mevcut olmadığı için gerçek local PASS sonucu iddia edilmedi. CI'nin gerçek runner sonucu referans kabul edilecek.

### Network inventory / policy
- Doğrulanan zorunlu browser third-party kaynağı: ArcGIS JS SDK stylesheet `https://js.arcgis.com/4.25/esri/css/main.css`.
- GIS service URLs runtime browser config'e doğrudan veri olarak açılmak yerine server-owned opaque identifiers/proxy contract ile yönetiliyor.
- Yeni analytics, remote font, generic CDN, external geocoding veya yeni map provider eklenmedi.
- WMS/WFS/WMTS eklenmedi.

### Performans etkisi
- Bootstrap config GET'leri cache + request cancellation ile tekrar indirme ve stale async update riskini azaltıyor.
- Opt-in cache/dedupe tasarımı, private authenticated GET cevaplarını yanlışlıkla paylaşma riskini azaltıyor.
- Static service worker cache'i API/GIS cache'inden ayrılıyor; runtime data stale-cache riski yaratılmıyor.
- IE compatibility/framework migration bu turda yapılmadı; bundle/CWV ölçümleri gerçek browser/CI artifact'iyle sonraki performance fazına bırakıldı.

### Test / doğrulama durumu
- GitHub connector üzerinde branch/ref/tree/file diff doğrulandı.
- Local `npm test`, `npm run build`, `dotnet build`, lint ve typecheck çalıştırılamadı; ortamda local runtime bulunmuyor.
- GitHub Actions workflow dosyaları gerçek runner validation için eklendi.
- Browser smoke/CWV/Network HAR/memory profiling bu turda gerçek browser oturumu olmadığı için iddia edilmedi.

### Git / PR / merge
- Deep work branch: `agent/platform-deep-2026-09-15-r3`.
- Platform üretim commit: `dce855f7b3137448dff3aa524b00798d3ec56d2c`.
- Bu kayıt commitinden sonra branch HEAD yeni progress commitidir.
- PR açılmadan önce güncel `main` ile mergeability yeniden kontrol edilmelidir.
- Eski Platform PR #1: açık, merged değil ve stale base'e bağlı; yeni r3 PR onun yerine kullanılmalıdır. Eski PR merge edilmemelidir.

### Kalan riskler / sonraki görev
1. CI runner sonuçlarını al, başarısız test/build varsa aynı turda düzelt.
2. Platform r3 PR'sini current `main` üzerine aç ve mergeability/check sonuçlarını doğrula.
3. `AuthBusiness.GetRequestHeaders()` kullanım envanterini tamamla; uygun authenticated flow varsa HttpOnly/Secure/SameSite server-issued session/token modeline kontrollü migrate et.
4. `CommonBusiness` unsafe `innerHTML` / popup generation ve legacy WMS branch'i GIS team ile koordineli güvenlik/migration konusu olarak ele al.
5. `Api.User`/`Api.Admin` için gerçek production secret rotation ve CORS origin configuration deployment tarafında doğrulanmalı.
6. Gerçek browser Network/CWV/bundle/memory ölçümlerini al; React/CRA migration veya IE compatibility kaldırma kararını ölçüme bağla.
7. CSP, ArcGIS SDK'nın gerçek runtime connect/script/font ihtiyaçları envanterlendikten sonra production header seviyesinde enforce edilsin; tahmini geniş `https:` CSP yazılmasın.

## Kurallar
- Çalışan davranışlar korunur; WMS/WFS eklenmez; gerçek servis ve response şeması incelenmeden endpoint varsayılmaz.
- Browser Network panelinin tamamen gizlenemeyeceği kabul edilir; güvenlik server-side authorization, least privilege ve data minimization ile kurulur.
