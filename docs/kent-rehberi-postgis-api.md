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
