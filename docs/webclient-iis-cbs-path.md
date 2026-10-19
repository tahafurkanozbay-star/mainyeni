# Webclient.app — statik IIS yayını

## Hedef

- Webclient: `https://cbs.ankara.bel.tr/kentrehberiumit/`
- Fiziksel yol: `C:\inetpub\wwwroot\kentrehberiumit`
- IIS uygulama havuzu: `kentrehberiumit-webclient` (`No Managed Code`, 64-bit)
- Harita verisi: doğrudan PlanASKI Kent Rehberi uç noktası

Bu dağıtım yalnızca statik web istemcisini yayımlar. Webclient başlatılırken aynı-köken `/api`, `AppSettings` veya GIS servis kataloğu istekleri yapılmaz. Harita başlangıç görünümü yerel yapılandırmadan hazırlanır; Kent Rehberi katmanları tarayıcıdan doğrudan `https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=` adresinden alınır. PlanASKI, üretimde kullanılan `https://cbs.ankara.bel.tr` origin'ine CORS izni vermelidir.

## 1. Üretim paketini derle

Node.js 24+ ve npm 11+ gerekir. Deponun kökünde PowerShell açın:

```powershell
Set-Location "C:\Users\umit.algan\Downloads\mainyeni-git"
.\Operations\build-webclient-iis.ps1
```

Betik kilitli npm bağımlılıklarını yükler, frontend kalite/test kapılarını çalıştırır, doğrudan PlanASKI veri kaynağıyla Vite üretim paketini oluşturur ve bütünlüğünü doğrular. Çıktı `Webclient.app\build\` klasöründedir. Üretim paketinde API tabanı, API anahtarı veya backend yapılandırması bulunmaz.

## 2. IIS'e yayınla

PowerShell'i Yönetici olarak açın:

```powershell
Set-Location "C:\Users\umit.algan\Downloads\mainyeni-git"
.\Operations\deploy-webclient-iis.ps1
```

Betiğin güvenlik sınırları:

- Yalnızca `Default Web Site` üzerinde `cbs.ankara.bel.tr:443` HTTPS bağlamasını ve `/kentrehberiumit` uygulamasını doğrular.
- Derlenmiş statik dosyaları `C:\inetpub\wwwroot\kentrehberiumit` dizinine kopyalar ve çakışan var olan dosyaları zaman damgalı yedekler.
- API uygulama havuzu veya alt-yol uygulaması oluşturmaz; API DLL'si, kimlik bilgisi veya backend ayarı yayımlamaz.
- `robocopy /E` kullanır; `/MIR` ve `/PURGE` kullanmadığı için kökteki ilgisiz klasörleri silmez.

Daha önce IIS üzerinde `/kentrehberiumit/api` eşlemesi veya fiziksel `user` klasörü bulunuyorsa betik bunlara dokunmaz. Bu uygulama sürümü bunlara istek göndermese de, mevcut eşlemeyi kapatmak/silmek canlı sunucu için ayrı bir bakım kararıdır; dağıtım betiği bunu sessizce yapmaz.

## 3. Yayın sonrası kontrol

```powershell
$base = "https://cbs.ankara.bel.tr/kentrehberiumit"
$page = Invoke-WebRequest "$base/" -UseBasicParsing -TimeoutSec 20
"Webclient HTTP: $([int]$page.StatusCode)"
"İçerik türü: $($page.Headers['Content-Type'])"

$source = "https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=42"
$sourceResponse = Invoke-WebRequest $source -UseBasicParsing -Headers @{ Origin = "https://cbs.ankara.bel.tr" } -TimeoutSec 30
"PlanASKI HTTP: $([int]$sourceResponse.StatusCode)"
"PlanASKI CORS izni: $($sourceResponse.Headers['Access-Control-Allow-Origin'])"
$records = @($sourceResponse.Content | ConvertFrom-Json)
"PlanASKI kategori 42 kayıt sayısı: $($records.Count)"
if (-not $sourceResponse.Headers['Access-Control-Allow-Origin']) {
    Write-Warning "Tarayıcıdan doğrudan veri yükleme için CORS izni doğrulanamadı."
}
```

Webclient için HTTP 200 ve PlanASKI isteği için HTTP 200/JSON beklenir. Yanıtta `Access-Control-Allow-Origin: https://cbs.ankara.bel.tr` veya `*` bulunmalıdır; aksi durumda sunucu tarafı CORS izin listesi düzeltilmeden tarayıcı doğrudan veriyi okuyamaz.

## Geri dönüş

Statik web dosyalarının üzerine yazılmadan önce yedekleri `C:\inetpub\backups\kentrehberiumit\<zaman damgası>\` altında tutulur. Önceki statik dosyaları bu yedekten geri yükleyin. Eski API dosyaları/eşlemesi betik tarafından değiştirilmez.
