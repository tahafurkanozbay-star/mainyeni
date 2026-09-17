# Operasyon Notları

## Yayın öncesi kontrol

- `npm run check`
- WMS/WFS servislerinde CORS kontrolü
- Token sürelerinin ve yetkilerinin kontrolü
- HTTPS mixed-content kontrolü
- SceneServer / FeatureServer extent ve spatial reference kontrolü
- Mobil ve düşük GPU profillerinde yük testi

## Yayın

GitHub Pages workflow'u `main` dalında otomatik build ve deploy yapar. Repository Settings → Pages bölümünde kaynak olarak GitHub Actions seçilmelidir.

## Sorun giderme

Katman kartındaki kırmızı durum noktası servis yükleme hatasını gösterir. `Bilgi` alanında hata metni ve servis host/path bilgisi görüntülenir. `Yeniden dene` ile layer yeniden oluşturulur.
