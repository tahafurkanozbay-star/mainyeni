# Platform Network ve Secret Politikası

## Amaç

Kent Rehberi web istemcisinin ağ yüzeyini küçültmek, dış kullanıcı tarayıcısının gereksiz üçüncü taraf servislerle konuşmasını önlemek ve yetkilendirmeyi sunucu tarafında tutmak.

## Browser varsayılanı

`Webclient.app` için API başlangıç yolu same-origin `/api` olmalıdır. `REACT_APP_API_BASE_URL` absolute bir dış URL olarak verilirse runtime config bunu üretim tarayıcısında otomatik olarak kabul etmez; güvenli varsayılan `/api`'dir.

Browser tarafında kimlik bilgileri, DB credential'ları, özel servis tokenları veya kalıcı API secret'ları tutulmaz. `Authorization`, `Cookie` ve secret benzeri log alanları redakte edilir.

## İzinli cross-origin trafik

Platform katmanı yalnızca repository'de gerçekten ihtiyaç duyulan ArcGIS REST/MapServer/FeatureServer kullanımını istisna olarak kabul eder. Keyfi cross-origin endpointler varsayılan olarak engellenir.

WMS/WFS/WMTS yeni bir entegrasyon olarak kabul edilmez.

Kimlik doğrulama, yetkili kullanıcıya özel veri, filtreleme/aggregation veya ayrıcalıklı GIS erişimi gerektiğinde browser -> same-origin API/BFF -> upstream servis akışı tercih edilir. Upstream credential browser'a verilmez.

## Cache ve request ömrü

Sadece güvenli idempotent isteklerde uygulama içi TTL cache kullanılmalıdır. Aynı anda tekrarlanan GET istekleri request deduplication ile birleştirilir. GET dışındaki metodlar otomatik cache edilmez.

Her istek timeout ve caller cancellation desteklemelidir. Otomatik retry yalnızca güvenli GET/HEAD işlemlerinde transient network, timeout, 429 ve 5xx koşullarında sınırlı backoff ile uygulanır.

## Backend secret configuration

`Api.User/appsettings.json` içinde credential bulunmamalıdır. Örnek sunucu değişkenleri:

- `Environment=prod`
- `DbConfigProd__Type=PGSQL`
- `DbConfigProd__ConnectionString=<secret-store-reference-or-secret-value>`

Aynı yaklaşım test ortamında `DbConfigTest__...` için uygulanır. Secret Manager, container secret, CI/CD secret veya kurumsal secret vault tercih edilir.

Daha önce git tarihine girmiş credential'lar yalnızca dosyadan silinmiş sayılmaz; gerçek sistemde ilgili parola/credential mutlaka döndürülmeli ve erişim kayıtları gözden geçirilmelidir.

## CORS

API CORS izinleri `Cors:AllowedOrigins` üzerinden açıkça tanımlanır. Boş liste cross-origin browser çağrılarını varsayılan olarak kabul etmez. `AllowCredentials` yalnızca açıkça tanımlanmış origin listesiyle birlikte kullanılır.

## Hata yanıtları

İstemciye stack trace, inner exception, SQL hatası veya upstream credential bilgisi gönderilmez. Beklenmeyen API hataları `application/problem+json` biçiminde genel hata ve trace id döndürür; ayrıntı sunucu loguna bırakılır.

## İzleme

Network performansı için en az request adı, HTTP status, süre, cache hit/miss, retry sayısı ve trace/request id izlenebilir olmalıdır. Payload ve kişisel/kimlik doğrulama verileri loglanmamalıdır.
