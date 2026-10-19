# 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması

Bu deponun yayımlanan ürünü, **`Webclient.app/`** altındaki React, TypeScript, Vite ve ArcGIS tabanlı istemcidir. Üretim paketi statik web dosyalarından oluşur; uygulamanın çalışması için ayrı ABB User API, Admin API, uygulama veritabanı veya Kent Rehberi proxy'si gerekmez.

## Veri kaynağı ve çalışma ilkeleri

Kent Rehberi kayıtları tarayıcıdan doğrudan ABB PlanASKI'nin sabit HTTPS uç noktasından alınır:

`https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=`

Tarayıcı tarafında özel `/api` proxy'si veya kimlik bilgisi iletimi yoktur. İstekler yalnızca doğrulanmış `tur=0..42` kategorilerine yönelir; JSON yanıtları GeoJSON'a dönüştürülmeden önce boyut, şema, kimlik ve koordinat kontrollerinden geçer. Başlangıç haritası yerel bir Ankara görünümüyle açılır.

**Dağıtım ön koşulu:** PlanASKI, istemcinin yayımlandığı origin için CORS izni vermelidir. Üretim origin'inden tarayıcı erişimi ayrıca doğrulanmadan bu izin var kabul edilmemelidir. CORS engelini aşmak için özel bir proxy veya ikinci veri kaynağı kendiliğinden eklenmemelidir.

## Depo yapısı

- `Webclient.app/` — yayımlanan web uygulaması, UI, ArcGIS motoru, PlanASKI taşıması, testler ve Vite/TypeScript yapılandırmaları.
- `Operations/` — statik IIS paketini üreten ve yayımlayan PowerShell betikleri.
- `docs/` — mimari, veri kaynağı ve dağıtım belgeleri.
- `progress/` — kısa güncel görev/devam kaydı; ayrıntılı eski kayıtlar `progress/archive/` altındadır.
- `_docs/` — derlemeye girmeyen tarihsel görsel referansı; canlı uygulama varlıkları `Webclient.app/public/` altındadır.
- `database/archive/` — kaldırılan API mimarisine ait tarihsel SQL referansı; aktif yayın girdisi değildir.
- `quality/` ve `tools/` — sürüm kalite denetimleri, mimari sözleşmeler ve CI araçları.
- `KentRehberi/webclient/` — ayrı GIS çekirdek modülünün test ve kalite iş akışı; ana statik SPA ile aynı dağıtım paketi değildir.
- `WebClient/` — ayrı tutulan GIS deneyim/politika kaynakları; üretim SPA'sının giriş noktası olarak kullanılmaz ve bağımsız kalite/bağımlılık kanıtı olmadan aktif uygulamaya taşınmamalıdır.

Kaldırılmış API dağıtım zinciri için gereken .NET projeleri artık statik web istemcisinin yayımlanma adımında kullanılmaz. Eski IIS sunucusunda kalmış `/api` eşlemesi veya fiziksel `user` klasörü kaynak kod değişikliğiyle otomatik kaldırılmaz; canlı sunucu üzerindeki ayrı bakım çalışmasında doğrulanmalıdır.

## Geliştirme

Gereksinimler: Node.js 24+ ve npm 11+.

```powershell
cd Webclient.app
npm ci
npm run dev
```

Üretim paketinin kalite ve bütünlük doğrulaması:

```powershell
npm run verify
```

## IIS dağıtımı

Depo kökünde, sırasıyla:

```powershell
.\Operations\build-webclient-iis.ps1
.\Operations\deploy-webclient-iis.ps1
```

Derleme/dağıtım betikleri statik istemciyi hazırlar ve IIS'e kopyalar; DNS, TLS, PlanASKI CORS ayarlarını veya eski API eşlemelerini sessizce değiştirmez.

## Güncel durum

- Aktif mimari ve bir sonraki tur başlangıcı: [`KENT_REHBERI_PROGRESS.md`](./KENT_REHBERI_PROGRESS.md)
- Önceki ayrıntılı ilerleme kayıtları: [`progress/archive/`](./progress/archive/)
- IIS statik dağıtım rehberi: [`docs/webclient-iis-cbs-path.md`](./docs/webclient-iis-cbs-path.md)
- Doğrudan PlanASKI veri kaynağı: [`docs/planaski-direct-browser.md`](./docs/planaski-direct-browser.md)
