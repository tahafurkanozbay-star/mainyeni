# 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması

Bu deponun etkin harita istemcisi `Webclient.app/` altındaki React, TypeScript, Vite ve ArcGIS uygulamasıdır. Üretim dağıtımı statik web dosyalarından oluşur; bu sürüm için ayrıca `Api.User` veya yönetim API'si gerekmemektedir.

## Veri kaynağı

Kent Rehberi kayıtları tarayıcıdan doğrudan resmi PlanASKI servisine alınır:

`https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=`

Araya aynı-köken API, proxy veya API kimlik bilgisi konulmaz. Resmi PlanASKI servisi, yayımlanan CBS istemcisinin origin'i için CORS izni vermelidir. Haritanın ilk görünümü yerel ve sabit bir Ankara görünümüdür; eski GIS servis kataloğu veya backend servisleri yüklenmez. Sadece PlanASKI veri kaynağıyla desteklenmeyen eski işlevler uygulamadan kaldırılmıştır.

## Geliştirme

Gereksinimler: Node.js 24+ ve npm 11+.

```powershell
cd Webclient.app
npm ci
npm run dev
```

## IIS dağıtımı

Üretim paketini ve statik IIS yayınını hazırlamak için deponun kökünde:

```powershell
.\Operations\build-webclient-iis.ps1
.\Operations\deploy-webclient-iis.ps1
```

Paketleme yalnızca statik web istemcisini oluşturur. Eski bir IIS ortamında API uygulaması hâlâ bulunuyorsa bu betikler onu yayımlamaz, yeniden başlatmaz veya silmez; böyle bir eşlemenin devre dışı bırakılması ayrı bir sunucu bakım işlemidir.

## Geliştirme notları

- Güncel durum ve kararlar: [`KENT_REHBERI_PROGRESS.md`](./KENT_REHBERI_PROGRESS.md)
- `KENT_REHBERI_PROGRESS_ARCHIVE_*.md` dosyaları tarihsel bağlam için korunur.
