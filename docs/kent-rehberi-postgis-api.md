# Kent Rehberi PostGIS JSON / GeoJSON API

## Amaç

Bu servis, tarayıcının PostgreSQL/PostGIS'e doğrudan bağlanmasını engeller ve
Kent Rehberi verisini mevcut `Api.User` uygulaması üzerinden same-origin bir
JSON/GeoJSON sözleşmesiyle sunar. Dış istemci yalnızca reverse proxy üzerindeki
`/api/kent-rehberi` yolunu görür; PostgreSQL hostu, portu, kullanıcı adı ve
parola browser bundle'ına girmez.

Repo zaten .NET 10, C# 14, PostgreSQL/Npgsql, merkezi rate limiting, CORS,
request timeout, response compression, security headers ve health-check
altyapısına sahip olduğu için ikinci bir Node/Go/Python runtime eklenmemiştir.
Bu, deployment yüzeyini ve secret dağıtımını küçültür.

## Veri kaynağı

Sunucu tarafındaki sabit kaynak:

- şema: `kent_rehberi`
- tablo: `kent_rehberi_tumu_pggeom`
- geometri: `shape`, EPSG:4326
- public API'de kullanılan alanlar: `objectid`, `adi`, `adres`, `ilce`,
  `mahalle`, `x`, `y`, `tur`, `yapan`, `web_sayfasi`,
  `durak_no`, `shape`

`gdb_geomattr_data` bilinçli olarak sorgulanmaz ve istemciye gönderilmez.

## Secret / environment

Tracked `appsettings.json` içinde bağlantı dizesi boş kalır. Deployment secret
store veya process environment üzerinden aşağıdaki anahtar verilir:

`ConnectionStrings__KentRehberi`

Örnek biçim:

```text
Host=<internal-postgres-host>;Port=5432;Database=<database>;Username=kent_rehberi_select;Password=<secret>;Pooling=true
```

Gerçek host, veritabanı adı, kullanıcı/parola veya başka internal network
bilgileri GitHub'a commit edilmemelidir.

Mevcut `ConnectionStrings__Primary` başka uygulama verileri için kullanılmaya
devam eder. Kent Rehberi bağlantısı ayrıdır; yanlış DB'ye bağlanma veya mevcut
BusinessContext'i istemeden başka veritabanına yöneltme riski bu şekilde
önlenir.

## Endpoint sözleşmesi

Reverse proxy `/api/` prefix'ini User API'ye aktarıyorsa public yollar:

### Liste / viewport

```http
GET /api/kent-rehberi
GET /api/kent-rehberi?ilce=Çankaya
GET /api/kent-rehberi?ilce=Çankaya&mahalle=Kızılay&tur=5
GET /api/kent-rehberi?q=belediye
GET /api/kent-rehberi?bbox=32.80,39.85,32.95,40.00
GET /api/kent-rehberi?bbox=32.80,39.85,32.95,40.00&limit=1000
GET /api/kent-rehberi?afterObjectId=12345&limit=500
```

`bbox` sırası `minLon,minLat,maxLon,maxLat` ve SRID EPSG:4326'dır.
Bbox filtresi önce GiST bounding-box operatörünü, ardından
`ST_Intersects` kontrolünü uygular.

Listeleme `objectid` üzerinden artan sırada keyset pagination kullanabilir.
Kaynak DDL `objectid` için UNIQUE constraint göstermediği için cursor özelliği
tracked config'te **fail-closed kapalıdır**. Önce
`database/kent-rehberi-api.sql` içindeki duplicate preflight çalıştırılmalı,
sorgu sıfır satır döndürmeli ve cursor açılmadan önce ObjectID benzersizliğini
kalıcı olarak garanti eden unique index/constraint oluşturulmalıdır. Bundan
sonra deployment config'inde:

`KentRehberiData__ObjectIdCursorEnabled=true`

verilebilir. Özellik açıkken ilk response `meta.hasMore=true` ise
`meta.nextAfterObjectId` sonraki istekte `afterObjectId` olarak kullanılır.
Özellik kapalıyken istemciden `afterObjectId` gönderilmesi 400 döner ve
capabilities response'u cursor desteğinin kapalı olduğunu açıkça belirtir.

### Tek kayıt

```http
GET /api/kent-rehberi/12345
```

Bulunmazsa 404 döner.

### Yakındaki kayıtlar

```http
GET /api/kent-rehberi/nearby?lon=32.85&lat=39.92
GET /api/kent-rehberi/nearby?lon=32.85&lat=39.92&radiusMeters=2000&tur=5
GET /api/kent-rehberi/nearby?lon=32.85&lat=39.92&radiusMeters=5000&ilce=Çankaya
```

Mesafe `shape::geography` ile metre cinsinden hesaplanır. Varsayılan yarıçap
2000 m, tracked config'teki varsayılan üst sınır 50000 m'dir. Sonuçlar
`distanceMeters` artan sırasıyla gelir.

### Capability bilgisi

```http
GET /api/kent-rehberi/capabilities
```

Bu endpoint DB hostu veya connection state açıklamadan public limit ve filtre
sözleşmesini verir.

### Tür kataloğu

```http
GET /api/kent-rehberi/types
```

Bu endpoint, eski hızlı erişim menüsündeki tüm belediye katmanlarının sayısal
`tur` kimliğini hard-code etmeden çözebilmesi için sınırlı bir katalog döndürür.
Her tür için yalnız toplam kayıt sayısı ve küçük bir public örnek kümesi
(`objectid`, `adi`, `adres`, `durakNo`) bulunur. SQL, host, schema
topolojisi, connection bilgisi veya hata ayrıntısı response'a eklenmez.

Varsayılan güvenlik bütçeleri:

- en fazla 256 tür,
- tür başına en fazla 8 örnek,
- örnek metin alanlarında en fazla 240 karakter,
- katalog response'u en fazla 512 KiB,
- server-side katalog cache TTL'i 300 saniye.

Browser bu katalog üzerinden servis profillerini sınıflandırır ve güvenli bir
`tur` sonucu oluştuğunda kategori verisini doğrudan
`GET /api/kent-rehberi?tur=<id>&limit=2000` ile yükler. Katalog yetersizse eski
metin probe davranışı yalnız bounded fallback olarak korunur; bu fallback
PostGIS API dışına çıkmaz.

## Örnek response

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
        "tur": 5,
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

## Güvenlik özellikleri

- SQL kullanıcı girdisiyle string interpolation yapmaz. Filtre değerleri
  Npgsql parameter olarak gönderilir.
- Şema ve tablo adı server-owned sabittir; query parametresinden alınmaz.
- `q` içindeki `%`, `_` ve backslash LIKE wildcard olarak değil literal
  veri olarak escape edilir.
- İlçe/mahalle uzunluğu 50 karakterle sınırlıdır; serbest metin `q`
  araması en az 2, en fazla 120 karakter kabul eder. Böylece tek karakterli
  pahalı `%q%` taramaları public endpointte engellenir.
- `limit`, radius, koordinat ve bbox sınırları fail-closed doğrulanır.
- Request cancellation PostgreSQL komutuna aktarılır.
- Command timeout ve connection timeout ayrıca sınırlandırılır.
- Ayrı Kent Rehberi datasource'u `/health/ready` readiness zincirine dahildir;
  feature enabled iken secret eksikse veya tablo okunamıyorsa readiness unhealthy
  olur. Public health payload DB hostu/SQL/exception ayrıntısı içermez.
- DB erişim hatalarında controller logu exception mesajı/stack yerine yalnız
  güvenli hata sınıfı + trace id kaydeder.
- Npgsql error detail kapalıdır; HTTP 503 cevabı internal exception/host/SQL
  ayrıntısı döndürmez.
- Global Platform rate limiter ve request timeout yeni endpointleri de kapsar.
- Public response yalnız gerekli kolonları içerir; binary GDB metadata dışarı
  verilmez.
- DB kullanıcısı için tablo seviyesinde geniş SELECT yerine column-level
  least-privilege grant önerilir.

## Reverse proxy

Uygulamanın mevcut same-origin modelini koruyun. Örnek Nginx parçası:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:<user-api-port>/;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    proxy_connect_timeout 3s;
    proxy_send_timeout 15s;
    proxy_read_timeout 15s;
}
```

User API portunu internetten doğrudan publish etmeyin. PostgreSQL portunu da
public network'e açmayın. Uygulama sunucusundan DB subnet'ine yalnız gerekli
port için firewall/ACL erişimi verin.

Forwarded-header işleme yalnız gerçekten güvenilen reverse proxy katmanından
gelen trafiğe göre yapılandırılmalıdır. Client tarafından doğrudan gönderilen
`X-Forwarded-For` bir kimlik veya authorization kaynağı değildir.

## PostgreSQL hazırlığı

`database/kent-rehberi-api.sql`:

1. runtime rolüne yalnız schema usage + gerekli kolonlarda SELECT verir,
2. `objectid` pagination indexini ekler,
3. `shape` için geometry GiST indexini ekler,
4. metre bazlı nearby sorgusu için `shape::geography` expression GiST indexini
   ekler,
5. ilçe/mahalle/tür filtreleri için yardımcı indexleri ekler,
6. ObjectID duplicate preflight sağlar,
7. preflight temizlendikten sonra cursor özelliğinin deployment config ile
   explicit açılmasını gerektirir.

`CREATE INDEX CONCURRENTLY` komutlarını explicit transaction içinde
çalıştırmayın.

## Performans davranışı

Harita pan/zoom sırasında bütün tabloyu tekrar indirmek yerine güncel viewport
bbox'ı kullanılmalıdır. Default 500, maksimum 2000 kayıt sınırı browser memory,
JSON boyutu ve render maliyetini sınırlar.

Response'lar kısa süreli public cache header taşır. Reverse proxy/CDN eklemek
zorunlu değildir; same-origin reverse proxy kendi cache politikasını ayrıca
uygulayabilir. User-specific veri bu endpointlere eklenirse public cache
politikasının yeniden değerlendirilmesi zorunludur.

Substring `q` araması ilk sürümde extension zorunluluğu yaratmaz. Gerçek
production profiling aramanın sıcak yol olduğunu gösterirse DBA onayıyla
`pg_trgm` indexi ayrıca değerlendirilebilir.

## Deployment smoke test

Secret/config uygulandıktan ve SQL hazırlığı tamamlandıktan sonra:

```text
GET /api/kent-rehberi/capabilities
GET /api/kent-rehberi?limit=1
GET /api/kent-rehberi?bbox=<known-small-bbox>&limit=10
GET /api/kent-rehberi/nearby?lon=<known-lon>&lat=<known-lat>&radiusMeters=500&limit=10
GET /health/ready
GET /api/kent-rehberi/capabilities
```

Kontrol edin:

- response'da DB host/parola veya exception detail yok,
- GeoJSON geometry doğru ve longitude/latitude sırası korunuyor,
- `Cache-Control`, correlation id, security headers ve rate limiting mevcut,
- bbox planı geometry GiST indexini,
- nearby planı geography expression GiST indexini kullanıyor,
- büyük result setler limit ile bounded kalıyor,
- `/health/ready` içinde `kent-rehberi-data` healthy görünüyor,
- ObjectID duplicate preflight temizlenmeden cursor özelliği açılmıyor.

Gerçek DB credentials olmadan CI yalnız contract/validation/build testlerini
çalıştırır; production DB bağlantısı deployment ortamında smoke test edilir.

## Frontend GeoJSONLayer bağlantısı

Webclient harita kabuğu açıldığında `src/data-services/kentRehberiGeoJsonLayer.ts`
üzerinden same-origin:

`GET /api/kent-rehberi?limit=500`

isteğini yapar. Response doğrudan ArcGIS constructor'a verilmez; önce aşağıdaki
sınırlar uygulanır:

- response yalnız `application/geo+json` / `application/json` kabul eder,
- HTTP error body istemci hata mesajına yansıtılmaz,
- FeatureCollection ve her Feature yapısı doğrulanır,
- her kayıtta pozitif integer `properties.objectid` zorunludur,
- feature sayısı public API üst sınırı olan 2000'i aşamaz,
- frontend payload bütçesi varsayılan 8 MiB ile sınırlıdır,
- request timeout + AbortSignal ile iptal edilebilir,
- API base yalnız canonical same-origin relative path kabul eder.

Doğrulanmış FeatureCollection bir Blob'a çevrilir ve ArcGIS 5.1
`GeoJSONLayer` Blob URL desteği kullanılarak yüklenir. Alan şeması explicit
tanımlanır; ilk feature içindeki null değerlerden field type tahmini yapılmaz.
Layer load tamamlanınca Blob URL revoke edilir. React map shell dispose olursa
pending request abort edilir ve eklenmiş katman map'ten kaldırılıp destroy
edilir.

Bu katman yüklemesi **best-effort** çalışır: Kent Rehberi datasource geçici
olarak 503 dönerse ana harita ve diğer GIS yetenekleri açılmaya devam eder;
veritabanı hatası browser'a ayrıntılı olarak yansıtılmaz.

### Yerel Vite gerçek-backend akışı

Synthetic Kent Rehberi middleware kaldırılmıştır. Vite development server
`/api` isteklerini local User API'nin HTTPS endpointine proxy eder:

`https://localhost:3003`

Böylece development ve production aynı controller, validation, cache,
PostGIS repository ve GeoJSON sözleşmesini kullanır. Browser PostgreSQL'e
doğrudan bağlanmaz; DB bağlantı dizesi yalnız User API process environment /
secret store tarafında kalır.

Yerel doğrulama için önce `Api.User` HTTPS profilini, sonra
`Webclient.app` Vite server'ını başlatın. Aşağıdaki akışın tamamı gerçek
backend üzerinden çalışmalıdır:

`/api/kent-rehberi/types -> tur çözümü -> /api/kent-rehberi?tur=... -> FeatureCollection validation -> GeoJSONLayer -> map.add()`


## 40 katmanlı hızlı erişim sözleşmesi

ABB, EGO, ASKİ ve iştirak gruplarındaki toplam 40 hızlı erişim kaydı artık
`SidebarCatalog.ts` içinde explicit `serviceKey` taşır. Bu kimlik aynı anda:

1. `kentRehberiFastAccessProfiles.ts` profilini,
2. `iconRegistry.json` içindeki tekil ikon alias'ını,
3. lazy query-window kaydını,
4. PostGIS tabanlı fast-access runtime'ını

birbirine bağlayan stable identity'dir.

`createFastAccessQueryBusiness`, bu 40 key için önce Kent Rehberi runtime'ını
seçer. Eski service runtime yalnız bu profile dahil olmayan servisler için
compatibility fallback olarak kalır. Sonuçlar
`source: "kent-rehberi"` ile işaretlenir ve kategori layer'ı paylaşılan
GeoJSON renderer + ikon registry üzerinden oluşturulur.

Release sırasında aşağıdaki fail-closed audit çalışır:

```text
npm run quality:kent-rehberi-all-layers
```

Audit; 40 sidebar kaydının grup dağılımını, service-key benzersizliğini,
query-window kapsamasını, profil kapsamasını, service-key → ikon alias
tekilliğini, katalog-first runtime sözleşmesini, same-origin/abort/payload
sınırlarını, gerçek HTTPS local proxy kullanımını, backend `/types`
endpointini, parameterized katalog SQL'ini ve CI/package entegrasyonunu kontrol
eder. Webclient Quality ve Release QA bu audit başarısızsa release'i durdurur.
