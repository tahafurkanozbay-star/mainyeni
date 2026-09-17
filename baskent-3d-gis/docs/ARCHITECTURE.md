# Mimari

## Tasarım hedefleri

- 3B CBS kullanımını merkezde tutmak
- ArcGIS REST ve OGC servislerini aynı katalogdan yönetmek
- Framework bağımlılığını azaltmak
- Harita SDK'sını tembel/dinamik yükleyerek ilk uygulama kodunu küçük tutmak
- Servis kaynaklı hataları uygulamadan izole etmek

## Veri akışı

1. `services.json` doğrulanır ve normalize edilir.
2. Kullanıcı görünürlük tercihi / URL ile paylaşılan katman listesi uygulanır.
3. Katman yalnızca açıldığında ilgili ArcGIS 5.1 sınıfı `$arcgis.import` ile yüklenir.
4. Katman `load()` sonucuna göre `ready/error` durumuna geçer.
5. Harita tıklaması `hitTest` ile öznitelik paneline aktarılır.
6. Kamera ve görünürlük tercihleri localStorage'da tutulur.

## Servis adaptörleri

- FeatureServer → FeatureLayer
- SceneServer → SceneLayer
- MapServer → MapImageLayer (alt katman URL'si verilmişse sublayer ID ayrıştırılır)
- WMS → WMSLayer
- WFS → WFSLayer

Bu yaklaşım servis kataloğuna yeni kayıt eklemeyi kod değişikliğinden büyük ölçüde bağımsız hale getirir.
