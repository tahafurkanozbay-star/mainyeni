# 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması

Bu depo için etkin dağıtım modeli, tarayıcıda çalışan statik **Webclient.app** SPA'sıdır. Kent Rehberi verileri doğrudan ABB PlanASKI'nin resmi uç noktasından alınır:

https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=

Web istemcisinin Kent Rehberi katmanları için arada bir /api/kent-rehberi proxy'sine, veritabanına, kullanıcı API'sine veya yönetim paneline ihtiyacı yoktur. Uygulama başlangıç harita görünümünü yerel, sabitlenmiş Ankara yapılandırmasıyla açar. PlanASKI uç noktası, uygulamanın yayımlandığı kökenden tarayıcı CORS isteklerine izin vermelidir; CORS yoksa tarayıcı güvenlik kısıtlamasını aşmak için özel bir proxy otomatik olarak oluşturulmaz.

## Web istemcisini çalıştırma

Gereksinimler: Node.js 24 ve npm 11.

```powershell
cd Webclient.app
npm ci
npm run dev
```

Üretim derlemesi:

```powershell
npm run build
npm run build:verify
```

IIS için statik web paketi, Windows ortamında depo kökündeki Operations/build-webclient-iis.ps1 ile hazırlanabilir. Bu işlem yalnızca statik web istemcisini üretir; IIS, DNS ve TLS ayarlarını kendisi değiştirmez.

## Bakım notları

- PlanASKI doğrudan erişim testi: src/data-services/kentRehberiPlanAskiDirect.test.ts
- GeoJSON katmanının veri doğrulama ve yaşam döngüsü testleri: src/data-services/kentRehberiGeoJsonLayer.test.ts
- Api.User, Api.Core, Business ve Toolbox sunucu projeleri statik web istemcisi dağıtımı için gerekli değildir. Bu web dağıtımında bunları derlemeyin veya yayımlamayın.
- Gizli bilgiler, yerel .env dosyaları, derlenmiş paketler ve uygulama günlükleri depoya eklenmemelidir.
