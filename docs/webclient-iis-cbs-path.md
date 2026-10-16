# Webclient.app — IIS alt-yol yayını

## Hedef

- Webclient: `https://cbs.ankara.bel.tr/kentrehberiumit/`
- Same-origin API base: `/kentrehberiumit/api`
- API uygulama fiziksel yolu: `C:\inetpub\wwwroot\kentrehberiumit\user`
- Frontend fiziksel yolu: `C:\inetpub\wwwroot\kentrehberiumit`

Bu yayın, yeni bir DNS adı gerektirmez. Vite zaten göreli asset tabanı (`base: './'`) kullanır; derlenmiş JS/CSS/font/resim dosyaları `/kentrehberiumit/` altındaki yoldan yüklenir. Kent Rehberi verileri tarayıcıdan doğrudan `https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=` uç noktasından alınır. Bu nedenle PlanASKI sunucusunun `https://cbs.ankara.bel.tr` kaynağına CORS izni vermesi gerekir. `/kentrehberiumit/api` IIS API uygulaması yayımlanmaya devam eder; ancak Kent Rehberi veri katmanının kaynağı olarak seçilmez.

## Tasarım ve işlev sınırı

Yeni public workspace CSS'i ortak bir yerleşim sistemi kurar: floating üst gezinme/arama, tutarlı kategori paneli, sağ araç rayı, tek panel ölçüleri, modal için açık z-index önceliği, dar ekran düzenleri, reduced-motion ve forced-colors desteği. ArcGIS MapView, mevcut sorgu pencereleri, klavye denetimleri, katman/arama bileşenleri ve veri doğrulama kodları korunur.

`VITE_PUBLIC_MAP_ONLY_MODE=true` üretim derlemesinde eski `/AppSettings/List?key=GisMapConfig` ve `/Gis/ConfigService/List` isteklerini yapmadan Ankara merkezli güvenli bir harita başlangıç ayarı ve boş servis listesi kullanır. Bu ayar 401 ile engellenen eski yapılandırma uç noktalarına bağımlılığı kaldırır; **eski GIS servis tanımlarını geri getirmez**. PlanASKI Kent Rehberi veri uç noktası yine çalışır. Eski GIS/iş uygulaması servis yapılandırmaları için ayrı yetkili erişim gereklidir.

## 1. Kaynağı doğrula ve üretim paketini derle

Güncel depo kökünde PowerShell açın. Node.js 24+ ve npm 11+ gerekir.

```powershell
Set-Location "C:\Users\umit.algan\Downloads\mainyeni-git"
.\Operations\build-webclient-iis.ps1
```

Betiği deponun kökündeki `Operations` klasöründen çalıştırın. Betik `npm ci`, tam `npm run verify`, production derlemesi ve `npm run build:verify` çalıştırır. Çıktı:

`Webclient.app\build\`

Derleme başlamadan önce test/kalite kapıları, production-only mod kapalıyken çalışır. Son derlemede `VITE_API_URL=/kentrehberiumit/api`, `VITE_KENT_REHBERI_SOURCE=planaski` ve `VITE_PUBLIC_MAP_ONLY_MODE=true` kullanılır. Böylece Kent Rehberi veri katmanı doğrudan sabitlenmiş PlanASKI kaynağını çağırır; genel uygulama API tabanı ise diğer uç noktalar için göreli kalır.

## 2. IIS'e yayınla

Önce üretim derlemesi başarılı olmalı. Sonra PowerShell'i **Yönetici olarak** açın ve aynı depo checkout'unda çalıştırın:

```powershell
Set-Location "C:\Users\umit.algan\Downloads\mainyeni-git"
.\Operations\deploy-webclient-iis.ps1
```

Betik yalnızca `Default Web Site` üzerinde `cbs.ankara.bel.tr:443` HTTPS bağlamasını doğruladıktan sonra ilerler. Eski web dosyalarını `C:\\inetpub\\backups\\kentrehberiumit\\<zaman damgası>\\` altına yedekler ve derlenmiş statik dosyaları `C:\\inetpub\\wwwroot\\kentrehberiumit\\` içine kopyalar. Mevcut `kentrehberiumit` API uygulama havuzunu değiştirmez; alt-yol API için ayrı `kentrehberiumit-api` havuzu kullanılır. Yalnızca bu ayrı havuz önceden mevcut olup Standalone ayarı değişirse o havuz yeniden başlatılabilir.

Önemli koruma: betik `robocopy /E` kullanır; `/MIR` veya `/PURGE` kullanmaz. Böylece mevcut `user` API klasörünün yanlışlıkla silinmesini önler. Gerekli IIS uygulamaları mevcut değilse:
- `/kentrehberiumit` → `C:\inetpub\wwwroot\kentrehberiumit`, havuz `kentrehberiumit-webclient` (No Managed Code)
- `/kentrehberiumit/api` → `C:\inetpub\wwwroot\kentrehberiumit\user`, ayrı havuz `kentrehberiumit-api` (No Managed Code; `KentRehberiData__Standalone=true`)

Yol veya havuz mevcut ama beklenen değerlerden farklıysa betik otomatik üzerine yazmaz; hata verip durur.

## 3. Yayın sonrası kontrol

Yönetici olmayan bir PowerShell oturumundan, web/API sağlık kontrollerini ve doğrudan PlanASKI kaynağını test edin:

```powershell
$base = "https://cbs.ankara.bel.tr/kentrehberiumit"

$page = Invoke-WebRequest "$base/" -UseBasicParsing -TimeoutSec 20
"Webclient HTTP: $([int]$page.StatusCode)"
"İçerik türü: $($page.Headers['Content-Type'])"

$health = Invoke-RestMethod "$base/api/health/live" -TimeoutSec 15
"API sağlık: $($health.status)"

$source = "https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=42"
$sourceResponse = Invoke-WebRequest $source -UseBasicParsing -Headers @{ Origin = "https://cbs.ankara.bel.tr" } -TimeoutSec 30
"PlanASKI HTTP: $([int]$sourceResponse.StatusCode)"
"PlanASKI CORS izni: $($sourceResponse.Headers['Access-Control-Allow-Origin'])"
$records = @($sourceResponse.Content | ConvertFrom-Json)
"PlanASKI kategori 42 kayıt sayısı: $($records.Count)"
if (-not $sourceResponse.Headers['Access-Control-Allow-Origin']) {
    Write-Warning "Tarayıcıdan doğrudan veri yükleme için CORS izni henüz yanıtlanmıyor."
}
```

Beklenen: Webclient HTTP 200; API sağlık `healthy`; PlanASKI kategori 42 isteği HTTP 200 ve JSON dizi döndürür. Tarayıcıya doğrudan veri göstermek için yanıtta `Access-Control-Allow-Origin: https://cbs.ankara.bel.tr` veya `*` bulunmalıdır. Sonra tarayıcıda `https://cbs.ankara.bel.tr/kentrehberiumit/` adresini açıp Kent Rehberi katmanının yüklenmesini doğrulayın.

## Geri dönüş

Derlemenin hedefte mevcut olan tüm çakışan üst-düzey dosya ve klasörleri yedeklenir; `user` API klasörü bu kapsama alınmaz. Gerekirse ilgili yedek öğeleri aynı IIS klasörüne geri kopyalayın. `user` klasörünün içeriği değiştirilmez; mevcut API yayın dosyaları ve mevcut `kentrehberiumit` havuzunun environment ayarları korunur. Yalnızca alt-yol uygulaması için ayrı `kentrehberiumit-api` havuzu oluşturulur/denetlenir.

## Güvenlik notları

- `VITE_PUBLIC_MAP_ONLY_MODE` sadece bilinçli olarak azaltılmış public harita dağıtımı için etkinleştirilir.
- API anahtarları/şifreleri frontend `.env` dosyasına veya bundle içine konmaz.
- `/api` IIS uygulaması mevcut PlanASKI backend'ini aynı kökenden sunar; geniş CORS açılmaz.
- `web.config` default document'ı `index.html` yapar ve IIS'te `.wasm` MIME türünü tanımlar; URL Rewrite/ARR gerektirmez.
