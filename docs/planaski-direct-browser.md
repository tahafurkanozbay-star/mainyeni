# Doğrudan PlanASKI veri kaynağı

## Etkin mimari

Yayımlanan `Webclient.app`, Kent Rehberi için tek veri kaynağı olarak resmi PlanASKI Kent Rehberi uç noktasına doğrudan tarayıcı isteği yapar:

`https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=N`

Bu mimari isteğe bağlı bir mod değildir. Üretim istemcisi için aşağıdakiler kullanılmaz:

- ABB User API/Admin API veya uygulama veritabanı/PostGIS,
- aynı-köken `/api/kent-rehberi` ara servisi ya da Vite geliştirme proxy'si,
- API kimlik bilgisi/token iletimi,
- eski sunucu tabanlı GIS servis kataloğu.

Desteklenen kategori aralığı `tur=0..42` olarak sabitlenmiştir. PlanASKI'nin düz JSON yanıtları, ArcGIS'e verilmeden önce sınırlandırılmış boyut ve kayıt sayısı, alan türleri, benzersiz kayıt kimliği ve WGS84 koordinat kontrollerinden geçirilip GeoJSON'a dönüştürülür.

## İstek ve kaynak sınırları

Tarayıcı isteği `GET`, `mode: cors`, `credentials: omit`, `cache: no-store` ve `redirect: error` seçeneklerini kullanır. Kaynak URL'si kod içinde sabittir; kullanıcı girdisi ile host/path oluşturulmaz. İstekler iptal edilebilir; her kategori için yanıt boyutu/kayıt sayısı sınırları ve kategori indirmelerinde eşzamanlılık sınırı vardır.

Kategori başına kaynak sınırları 20.000 kayıt ve 8 MiB yanıttır. Uygulama sorgularında normal varsayılan sonuç üst sınırı 500, maksimum sınır 2.000 kayıttır. Filtrelenmemiş arama ve kategori kataloğu, 43 kategorinin taranmasını gerektirebilir; bu, gecikme ve PlanASKI isteği sayısını artırabilir. Gereksiz arama çağrılarını tetikleyen UI değişikliklerinden kaçınılmalı; cache/proxy eklenmeden önce kaynak servisinin gerçek davranışı ölçülmelidir.

## CORS ve üretim kontrolü

Tarayıcı aynı-origin politikası nedeniyle başka bir origin'in yanıtını ancak PlanASKI'nin ilgili yayın origin'ine CORS izni vermesi halinde okuyabilir. Üretim hedefi `https://cbs.ankara.bel.tr` olduğundan bu izin canlı tarayıcıdan ayrıca doğrulanmalıdır. Yerel ortamda daha önce başarılı bir HTTP yanıtı alınmış olması üretim origin'inde CORS izni olduğunu kanıtlamaz.

Yayın sonrası tarayıcıda Developer Tools → Network açıp `kentrehberi?tur=` filtresi uygulanmalıdır. İsteklerin yalnızca `planaski.ankara.bel.tr` hostuna gittiği; yanıtların JSON olduğu ve konsolda CORS hatası olmadığı kontrol edilmelidir. CORS başarısızsa sorunun kaynağı/izin listesi veri servisi sahibiyle düzeltilmelidir. CORS kısıtını aşmak için özel API, proxy veya ikinci veri kaynağı eklenmemelidir.

## Geliştirme ve dağıtım

```powershell
cd Webclient.app
npm ci
npm run dev
```

IIS statik paketi için depo kökünden `Operations/build-webclient-iis.ps1`, ardından yetkili PowerShell oturumundan `Operations/deploy-webclient-iis.ps1` çalıştırılır. Bu betikler kod ve statik dosyaları hazırlar; DNS/TLS/CORS yapılandırması yapmaz ve eski IIS API eşlemelerini sessizce silmez.

## Doğrulama kapsamı

CI testleri kategori dönüştürme, kayıt/koordinat reddi, sınırlandırma, iptal ve veri eşleştirme mantığını denetler. Testler tek başına üretim origin'inden CORS erişimini veya canlı IIS davranışını kanıtlamaz; yayın sonrası tarayıcı doğrulaması zorunludur.
