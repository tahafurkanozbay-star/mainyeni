# Kent Rehberi Yönetim Arayüzü

`Webclient.admin`, ana harita uygulamasından ayrı dağıtılan React + TypeScript + Vite yönetim SPA'sıdır. Yönetim oturumu ve yönetici API uçları üzerinden uygulama/harita ayarları, GIS servisleri, katmanlar, altlık haritalar, TAKBİS yapılandırması ve sistem sayfalarını sunar.

Bu klasör **kullanılmayan bir Create React App şablonu değildir**: kendine ait `package.json`, `package-lock.json`, Vite giriş noktası, testler ve `.github/workflows/admin-webclient-quality.yml` kalite iş akışı vardır. Yönetim sayfaları `Api.Admin` ile birlikte çalışır; yalnızca ana web istemcisinin bulunması yönetim işlevlerinin taşındığı anlamına gelmez.

## Gereksinimler

- Node.js 24
- npm 11

## Yerel geliştirme

```powershell
npm ci
npm run dev
```

Vite geliştirme sunucusu varsayılan olarak 3001 portunu kullanır. API taban adresi `VITE_API_URL` ile ayarlanır; varsayılan değer `/api`'dir. Yerel örnek için `.env.example` dosyası vardır.

## Doğrulama ve üretim derlemesi

```powershell
npm run verify
```

Bu komut dil sınırı denetimini, araç/regresyon testlerini, lint ve TypeScript kontrollerini, Vitest testlerini, üretim Vite derlemesini ve paket boyutu bütçesini çalıştırır. Sadece üretim derlemesi gerektiğinde `npm run build` kullanılabilir.

Yönetim arayüzünü kaldırmak için önce ona bağlı yönetim ekranlarının, yönetici API işlevlerinin ve dağıtım hedefinin başka bir uygulamaya taşındığı doğrulanmalıdır.
