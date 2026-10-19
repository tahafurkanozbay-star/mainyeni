# 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması

Bu deponun etkin ürünü `Webclient.app/` altındaki React, TypeScript, Vite ve ArcGIS tabanlı web istemcisidir. Uygulama, Kent Rehberi verilerini tarayıcıdan doğrudan resmi PlanASKI servisine alır. Üretim dağıtımı statik web dosyalarından oluşur; bu mimaride ABB'ye ait ayrı bir uygulama API'si, yönetim API'si veya backend sunucusu bulunmaz.

## Veri kaynağı

Kent Rehberi kayıtları resmi PlanASKI servisine doğrudan yüklenir:

`https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=`

Tarayıcı tarafında aynı-köken `/api` çağrısı, API kimlik bilgisi veya belediyeye ait proxy kullanılmaz. PlanASKI servisi, yayımlanan CBS istemcisinin origin'i için CORS izni vermelidir. İlk harita görünümü yerel ve sabit bir Ankara görünümüdür; eski GIS servis kataloğu ve API üzerinden çalışan eski sorgu işlevleri başlatılmaz. PlanASKI üzerinden desteklenmeyen eski işlevler uygulamadan çıkarılmıştır.

## Geliştirme

Gereksinimler: Node.js 24+ ve npm 11+.

```powershell
cd Webclient.app
npm ci
npm run dev
```

## IIS dağıtımı

Üretim paketi ve statik IIS yayını için depo kökünde:

```powershell
.\Operations\build-webclient-iis.ps1
.\Operations\deploy-webclient-iis.ps1
```

İki betik statik web istemcisini oluşturur/yayımlar; API uygulaması kurmaz veya API derlemez. Eski IIS sunucusunda daha önce oluşturulmuş bir `/api` eşlemesi ya da fiziksel `user` klasörü varsa, bu kaynak kod değişikliği sunucu üzerindeki eşlemeyi kendiliğinden kapatmaz veya silmez. Bu eski eşlemenin kaldırılması, canlı sunucuda ayrı bir bakım işlemidir.

## Geliştirme notları

- Güncel durum ve kararlar: [`KENT_REHBERI_PROGRESS.md`](./KENT_REHBERI_PROGRESS.md)
- `KENT_REHBERI_PROGRESS_ARCHIVE_*.md` dosyaları tarihsel bağlam için korunur.
