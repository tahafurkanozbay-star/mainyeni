# Kent Rehberi PlanASKI upstream + same-origin GeoJSON API

## Amaç

Kent Rehberi tarayıcısı dış veri kaynağına doğrudan bağlanmaz. React/Vite
istemcisi yalnız same-origin `/api/kent-rehberi` sözleşmesini çağırır.
`Api.User`, Ankara Büyükşehir Belediyesi'nin resmi PlanASKI Kent Rehberi
endpointini server-side upstream olarak kullanır, gelen veriyi doğrular,
normalize eder, sınırlar ve kısa süreli cache'ler.

Primary upstream:

```text
https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi
```

Kategori çağrıları yalnız `tur` query parametresiyle yapılır. Tracked
configuration inclusive aralığı `tur=0` ile `tur=42` olarak sınırlar.

Örnek upstream istekleri:

```text
https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=0
https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=1
...
https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=42
```

Browser bu URL'leri görmez veya çağırmaz; bütün dış network erişimi User API
tarafındadır.

## Kaynak seçimi

`KentRehberiData:Source` iki server-side mod destekler:

- `PlanAski` — varsayılan ve primary kaynak.
- `Postgis` — mevcut internal PostgreSQL/PostGIS repository için kontrollü
  compatibility fallback.

Tracked `appsettings.json` primary kaynağı açıkça `PlanAski` seçer.
PostGIS fallback etkinleştirilirse connection string source code'a yazılmaz;
deployment secret/environment üzerinden aşağıdaki anahtar kullanılır:

```text
ConnectionStrings__KentRehberi
```

Bu fallback için mevcut server-owned tablo
`kent_rehberi.kent_rehberi_tumu_pggeom` olarak kalır. Browser hiçbir modda
database hostu, kullanıcı adı, parola veya SQL topolojisi görmez.

## PlanASKI güvenlik ve kaynak sınırları

Upstream URI serbest config edilen genel amaçlı bir proxy değildir. Startup
validation yalnız şu canonical hedefe izin verir:

```text
scheme: https
host:   planaski.ankara.bel.tr
port:   443
path:   /kentrehberiapi/api/kentrehberi
query:  empty in configured base URI
user-info: empty
fragment: empty
```

Her runtime request bu sabit URI'ye yalnız `tur=<0..42>` ekler.
Redirect takip edilmez. TLS sertifika doğrulaması gevşetilmez.

Default upstream bütçeleri:

- `PlanAskiMinTur = 0`
- `PlanAskiMaxTur = 42`
- request timeout: 10 saniye
- cache TTL: 300 saniye
- aynı anda en fazla 6 upstream request
- tür başına en fazla 20.000 kayıt
- tür başına en fazla 8 MiB response

Aynı `tur` için eşzamanlı istekler single in-flight fetch üzerinde
birleştirilir. Başarılı response tür bazında cache'e yazılır. Caller
cancellation shared upstream fetch'i başka aboneler için bozmaz; abonelik bekleyişi
iptal edilir, fetch kendi bounded timeout'una kadar devam eder.

## Upstream response normalizasyonu

PlanASKI endpointinin tarayıcıya aynen forward edilmesi yerine User API
aşağıdaki güvenli alanları normalize eder:

- `objectid`
- `adi`
- `adres`
- `ilce`
- `mahalle`
- `x`
- `y`
- `tur`
- `yapan`
- `web_sayfasi` / `webSayfasi`
- `durak_no` / `durakNo`
- varsa Point GeoJSON geometry

Parser flat array, yaygın `data/results/items/records/features/result`
envelope'ları ve GeoJSON FeatureCollection biçimlerini kabul eder. Alan
isimleri için yaygın case/snake/camel varyasyonları normalize edilir.

Fail-closed kontroller:

- pozitif integer `objectid`,
- requested `tur` ile response `tur` uyumu,
- tür içinde duplicate `objectid` reddi,
- eksik/tek taraflı coordinate pair reddi,
- EPSG:4326 longitude/latitude bounds,
- finite numeric değerler,
- bounded text alanları ve control-character reddi,
- bounded JSON depth,
- bounded payload bytes,
- bounded record count,
- beklenmeyen content-type reddi,
- HTTP error body veya upstream içeriğinin public hata mesajına yansıtılmaması.

## Public same-origin endpoint sözleşmesi

Reverse proxy `/api/` prefix'ini User API'ye aktarıyorsa public yollar:

### Liste / kategori

```http
GET /api/kent-rehberi
GET /api/kent-rehberi?tur=0
GET /api/kent-rehberi?tur=42
GET /api/kent-rehberi?tur=12&limit=500
GET /api/kent-rehberi?ilce=Çankaya&tur=12
GET /api/kent-rehberi?q=belediye&tur=12
GET /api/kent-rehberi?bbox=32.80,39.85,32.95,40.00&tur=12
```

PlanASKI mode'da `tur` 0..42 dışında gönderilirse request 400 ile
fail-closed reddedilir. Tek bir `tur` verildiğinde yalnız o upstream kategori
çağrılır; diğer 42 kategori gereksiz yere indirilmez.

### Tek kayıt

```http
GET /api/kent-rehberi/12345
```

Object lookup mevcut public contract nedeniyle bütün configured tür cache'i
üzerinden benzersiz `objectid` arar. Aynı objectid farklı türlerde görülürse
sessizce yanlış kayıt seçmek yerine data-integrity hatası üretir.

### Yakındaki kayıtlar

```http
GET /api/kent-rehberi/nearby?lon=32.85&lat=39.92&radiusMeters=2000&tur=12
```

PlanASKI Point koordinatları üzerinde Haversine mesafesi hesaplanır ve sonuç
`distanceMeters` artan sırada döner. Coordinate bilgisi olmayan kayıtlar
nearby sonucuna alınmaz.

### Tür kataloğu

```http
GET /api/kent-rehberi/types
```

Catalog, configured aralığın tamamını inclusive biçimde temsil eder:

```text
0, 1, 2, ... 42
```

Boş türler de katalogda `count: 0` ile kalır; böylece browser tür aralığını
tahmin etmez. Her tür için küçük, dağıtılmış bir public sample kümesi kullanılır.

Tracked catalog bütçeleri:

- en fazla 43 tür,
- tür başına en fazla 16 sample,
- sample text alanı en fazla 240 karakter,
- serialized catalog en fazla 1 MiB,
- catalog cache TTL 300 saniye.

Frontend mevcut fast-access profile terimlerini bu sample'lara karşı
sınıflandırır. Güvenli bir tür çözülürse:

```http
GET /api/kent-rehberi?tur=<id>&limit=2000
```

çağrısı yapılır. Catalog sınıflandırması güven vermezse bounded text-probe
fallback yine aynı User API üzerinden çalışır; browser PlanASKI'ye doğrudan
çıkmaz.

### Capability

```http
GET /api/kent-rehberi/capabilities
```

Response public query limitlerini verir; upstream URL, DB connection state,
SQL veya exception ayrıntısı açıklamaz.

## Örnek GeoJSON response

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "id": 123,
      "geometry": {
        "type": "Point",
        "coordinates": [32.8541, 39.9208]
      },
      "properties": {
        "objectid": 123,
        "adi": "Örnek Tesis",
        "adres": "Örnek adres",
        "ilce": "Çankaya",
        "mahalle": "Kızılay",
        "x": 32.8541,
        "y": 39.9208,
        "tur": 12,
        "yapan": null,
        "webSayfasi": null,
        "durakNo": null
      }
    }
  ],
  "meta": {
    "count": 1,
    "limit": 500,
    "hasMore": false
  }
}
```

## Cache ve performans davranışı

İki cache katmanı birbirini tamamlar:

1. PlanASKI source cache — upstream response'u tür bazında 300 saniye saklar.
2. Mevcut bounded query-result cache — normalize edilmiş public query
   sonuçlarını kısa süreli saklar.

Böylece `/types` için 43 kategori bir kez warm olduktan sonra kullanıcı her
sidebar katmanına tıkladığında yeniden 43 dış istek yapılmaz. Bir kategori
seçildiğinde ilgili `tur` cache'te ise dış network çağrısı olmadan sonuç
üretilir.

Upstream fan-out en fazla 6 eşzamanlı request ile sınırlandırılır; `Task.WhenAll`
oluşturulan işleri başlatabilir ancak network gate aynı anda çalışan bağlantı
sayısını bounded tutar.

## Readiness

`/health/ready` içindeki `kent-rehberi-data` check configured source'a göre
davranır:

- PlanASKI mode: official upstream üzerinde bounded probe.
- PostGIS mode: mevcut table visibility / SELECT probe.

Health payload süre gibi güvenli diagnostic değerler taşıyabilir; upstream
response body, URL query ayrıntısı, DB hostu, SQL veya secret taşımamalıdır.

## Frontend GeoJSONLayer bağlantısı

Webclient yalnız same-origin endpoint kullanır:

```text
GET /api/kent-rehberi/types
GET /api/kent-rehberi?tur=<resolved>&limit=2000
```

Response ArcGIS constructor'a verilmeden önce:

- content-type doğrulanır,
- HTTP body hata mesajına yansıtılmaz,
- FeatureCollection/Feature/objectid doğrulanır,
- max feature/payload budgets uygulanır,
- request timeout ve AbortSignal kullanılır,
- API base yalnız canonical same-origin relative path kabul eder.

Doğrulanan data Blob üzerinden ArcGIS `GeoJSONLayer` olarak yüklenir ve
existing deterministic icon registry renderer'ı kullanılır.

## Local development

Browser PlanASKI'ye doğrudan gitmez. Local geliştirmede veri akışı:

```text
Webclient /api
  -> Vite localhost proxy
  -> Api.User
  -> https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=0..42
```

Tracked `Api.User/Properties/launchSettings.json` içindeki iki geliştirme
profili artık aynı portları kullanır:

```text
api.user Project : https://localhost:3003 / http://localhost:3002
IIS Express      : https://localhost:3003 / http://localhost:3002
```

Her iki profil de development ortamında explicit olarak:

```text
KentRehberiData__Source=PlanAski
KentRehberiData__PlanAskiBaseUri=https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi
KentRehberiData__PlanAskiMinTur=0
KentRehberiData__PlanAskiMaxTur=42
```

ayarlarıyla başlar. Böylece hangi Visual Studio profili seçilirse seçilsin
Vite'ın varsayılan backend hedefi ile port uyuşmazlığı oluşmaz.

Vite varsayılan hedefi:

```text
VITE_API_PROXY_TARGET=https://localhost:3003
```

olarak doğrulanır. Bu ayar yalnız `localhost`, `127.0.0.1` veya loopback
IPv6 HTTP(S) origin'lerine izin verir; PlanASKI gibi external bir host Vite
proxy target olarak kabul edilmez. Özel bir local profil gerekiyorsa örneğin:

```text
VITE_API_PROXY_TARGET=https://localhost:44357
```

ile yalnız local override yapılabilir.

Fresh checkout'ta `VITE_LOCAL_BOOTSTRAP_PREVIEW=true` kullanılır. Bu preview
yalnız eski `AppSettings/List` ve `Gis/ConfigService/List` map bootstrap
bağımlılığını local geliştirmede güvenli varsayılanlarla karşılar. Kent Rehberi
verisini mock'lamaz; `/api/kent-rehberi` ve `/api/kent-rehberi/types`
gerçek Api.User -> PlanASKI akışında kalır.

Beklenen local akış:

```text
Webclient
  -> local bootstrap preview (yalnız map shell config)
  -> /api/kent-rehberi/types
  -> Api.User https://localhost:3003
  -> official PlanASKI tur=0..42
  -> validation/cache/type catalog
  -> /api/kent-rehberi?tur=<resolved>
  -> GeoJSONLayer
```

Mevcut bir Visual Studio workspace'i eski IIS Express binding'ini
`https://localhost:44357` olarak cache'lemişse, yeni launchSettings'i
uygulamak için backend'i kapatıp workspace'i yeniden açın; gerekirse local
`.vs` klasörünü yeniden oluşturun. Alternatif olarak yalnız geliştirme için
`VITE_API_PROXY_TARGET=https://localhost:44357` override'ı kullanılabilir.

Local makinede official PlanASKI'ya outbound HTTPS erişimi yoksa readiness ve
gerçek data smoke testi başarısız olabilir. Frontend Kent Rehberi verisi için
synthetic/demo kaynağa sessizce düşmez.

## PostGIS compatibility fallback

PlanASKI geçici olarak deployment stratejisinden çıkarılmak istenirse
`KentRehberiData__Source=Postgis` seçilebilir. Bu mod mevcut Npgsql repository,
fixed table ve parameterized SQL yolunu kullanır.

Secret yalnız deployment tarafında verilir:

```text
ConnectionStrings__KentRehberi=Host=<internal-host>;Port=5432;Database=<db>;Username=<read-only-user>;Password=<secret>
```

Tracked repository hiçbir gerçek internal host/username/password içermez.
`database/kent-rehberi-api.sql` read-only grant/index/preflight runbook'u bu
fallback için korunur.

## Deployment smoke testi

Primary PlanASKI mode için:

```text
GET /health/ready
GET /api/kent-rehberi/types
GET /api/kent-rehberi?tur=0&limit=1
GET /api/kent-rehberi?tur=42&limit=1
GET /api/kent-rehberi?tur=12&limit=10
GET /api/kent-rehberi/nearby?lon=32.85&lat=39.92&radiusMeters=2000&tur=12&limit=10
```

Kontrol edin:

- `/types` 0..42 aralığını içeriyor,
- boş türler güvenli biçimde count 0 dönüyor,
- upstream error body public response'a sızmıyor,
- timeout/cancellation çalışıyor,
- category response 2000 feature limitini aşmıyor,
- geometry longitude/latitude sırası doğru,
- same-origin security headers/rate limiting/correlation-id korunuyor,
- `/health/ready` içindeki `kent-rehberi-data` healthy.

CI gerçek external endpointi zorunlu dependency yapmaz. Upstream parser,
caching, concurrency, timeout, failure behavior ve tur=0..42 fan-out sentetik
HTTP handler'larla deterministic test edilir. Deployment ortamındaki smoke
test gerçek PlanASKI network erişimini doğrular.

## 40 katmanlı hızlı erişim sözleşmesi

ABB, EGO, ASKİ ve iştirak gruplarındaki 40 hızlı erişim kaydı explicit
`serviceKey` taşır. Bu identity:

1. sidebar item,
2. lazy query window,
3. fast-access profile,
4. icon registry alias,
5. same-origin Kent Rehberi runtime

arasında tekil bağlantıdır.

Frontend service key'i doğrudan external URL'ye çevirmiyor. Profile
classification `/types` catalog'undan bir `tur` seçer; data User API
üzerinden gelir.

Fail-closed release audit:

```text
npm run quality:kent-rehberi-all-layers
```

Audit; 40-layer inventory, profile/query-window/icon coverage, same-origin
frontend transport, official PlanASKI host/path pinning, 0..42 config,
bounded concurrency/cache/byte/record budgets, no-redirect HTTP transport,
PostGIS compatibility fallback ve CI wiring'ini denetler.
