# 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması

Bu depo, ABB'nin 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması için ana web istemcisini ve halen kullanılan yardımcı kullanıcı API'sini içerir.

## Etkin uygulama bileşenleri

- **`Webclient.app/` — ana web istemcisi.** React, TypeScript, Vite ve ArcGIS tabanlı harita arayüzü.
- **PlanASKI Kent Rehberi veri kaynağı — doğrudan tarayıcı bağlantısı.** Üretim derlemesi, Kent Rehberi verilerini `https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=` adresinden alır. Bu veri akışı için arada bir Kent Rehberi proxy API'si gerekmez; PlanASKI kaynağının yayınlanan web istemcisinin kökenine CORS izni vermesi gerekir.
- **`Api.User/` — ek özelliklerin kullanıcı API'si.** Web istemcisinde geri bildirim, bazı TKGM/EGO entegrasyonları ve GIS/proxy gibi yardımcı özellikler için çağrılar hâlen vardır. Bu nedenle yalnızca PlanASKI Kent Rehberi katmanının doğrudan yüklenmesi, uygulamanın tüm API bağımlılığının kaldırıldığı anlamına gelmez.
- **`Api.Core/`, `Business/`, `Toolbox/` — `Api.User` için ortak sunucu altyapısı ve iş mantığı.**
- **`tests/Platform.Security.Tests/` — backend güvenlik ve platform regresyon testleri.**
- **`KentRehberi/webclient/` — ayrı CI iş akışında sınanan GIS sorgu modülleri.** Testler `Webclient.app` içindeki kilitli TypeScript/Vitest araç zincirini kullanır.

Ayrı yönetim uygulaması `Webclient.admin/` ve ona bağlı `Api.Admin/` bu dağıtımın parçası değildir; bu klasörler ve yönetim-API derleme/yayın bağlantıları kaldırılmıştır. Yardımcı API'nin tamamı ise mevcut diğer özellikleri bozmamak için korunmuştur.

## Geliştirme

Gereksinimler: .NET 10 SDK; web istemcisi için Node.js 24 ve npm 11.

Ana web istemcisi:

```powershell
cd Webclient.app
npm ci
npm run dev
```

Yardımcı kullanıcı API'si ve backend testleri:

```powershell
dotnet restore CityWorks.NetCore.sln
dotnet build CityWorks.NetCore.sln --configuration Release --no-restore
dotnet run --project tests/Platform.Security.Tests/Platform.Security.Tests.csproj --configuration Release --no-build --no-restore
```

IIS için statik web istemcisi paketi `Operations/build-webclient-iis.ps1` ile, gerekli olduğunda yardımcı API paketi `Operations/publish-webclient-api-iis.ps1` ile ayrı hazırlanır. Paketleme betikleri IIS'e kendiliğinden dağıtım yapmaz.

## Geliştirme notları

- Güncel durum ve kararlar: [`KENT_REHBERI_PROGRESS.md`](./KENT_REHBERI_PROGRESS.md)
- Eski ilerleme kayıtları `KENT_REHBERI_PROGRESS_ARCHIVE_*.md` dosyalarında tarihsel bağlam için korunur.
- Uygulama günlükleri, istisna dökümleri ve üretilmiş XML çıktıları kaynak dosyası olarak depoya eklenmemelidir.
