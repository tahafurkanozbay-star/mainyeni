# Ankara Kent Rehberi

Ankara Büyükşehir Belediyesi Kent Rehberi yazılım deposudur. Depo; harita web istemcisini, ayrı yönetim arayüzünü ve .NET API hizmetlerini içerir.

## Uygulamalar

- **`Webclient.app/` — ana Kent Rehberi web istemcisi.** React, TypeScript, Vite ve ArcGIS tabanlı harita deneyimi.
- **`Webclient.admin/` — ayrı yönetim arayüzü.** Harita yapılandırması, GIS servisleri, katmanlar, altlık haritalar, TAKBİS ayarları ve sistem sayfaları için kullanılır. Ana harita istemcisinin yerine geçmez; ayrı yönetim sayfaları ve `Api.Admin` uçları vardır.
- **`Api.User/` — kullanıcı/harita API'si.**
- **`Api.Admin/` — yönetim API'si.**
- **`Api.Core/`, `Business/`, `Toolbox/` — API altyapısı, iş mantığı ve ortak yardımcılar.**
- **`tests/Platform.Security.Tests/` — backend güvenlik ve platform regresyon testleri.**
- **`KentRehberi/webclient/` — ayrı CI iş akışında sınanan GIS sorgu modülleri.** Bu klasörün testleri `Webclient.app` içindeki kilitli TypeScript/Vitest araç zincirini kullanır.

## Geliştirme

Gereksinimler: .NET 10 SDK; web istemcileri için Node.js 24 ve npm 11.

Ana web istemcisi:

```powershell
cd Webclient.app
npm ci
npm run dev
```

Yönetim arayüzü:

```powershell
cd Webclient.admin
npm ci
npm run dev
```

Yönetim arayüzü yerel geliştirmede Vite'ın 3001 portunu kullanır. Her iki web istemcisinde doğrulama betiği `npm run verify` olarak tanımlıdır.

Backend:

```powershell
dotnet restore CityWorks.NetCore.sln
dotnet build CityWorks.NetCore.sln --configuration Release --no-restore
dotnet run --project tests/Platform.Security.Tests/Platform.Security.Tests.csproj --configuration Release --no-build --no-restore
```

GitHub Actions iş akışları web istemcilerini, GIS sorgu modüllerini ve backend'i ayrı kalite/test kontrollerinden geçirir.

## Geliştirme notları

- Güncel durum ve kararlar: [`KENT_REHBERI_PROGRESS.md`](./KENT_REHBERI_PROGRESS.md)
- Eski ilerleme kayıtları `KENT_REHBERI_PROGRESS_ARCHIVE_*.md` dosyalarında tutulur; tarihsel bağlam için bu arşivler bilerek korunur.
- Uygulama günlükleri, istisna dökümleri ve üretilmiş XML çıktıları kaynak dosyası olarak depoya eklenmemelidir.
