# 3B CBS Başkent

Ankara odaklı, modern ve üretime hazır bir **3B Altyapı / Üstyapı Koordinasyon Web Uygulaması**. Proje; ArcGIS **FeatureServer, SceneServer, MapServer** servisleriyle OGC **WMS/WFS** servislerini tek bir 3B sahnede birleştirir.

Arayüz, sağlanan referans ekranın operasyonel mantığını koruyup daha çağdaş, erişilebilir ve mobil uyumlu hale getirilmiştir.

## Teknoloji

- TypeScript (strict)
- Native ES Modules + TypeScript 5.9 (framework ve runtime bağımlılığı yok)
- ArcGIS Maps SDK for JavaScript 5.1 (CDN + `$arcgis.import` ile tree-friendly dinamik yükleme)
- Framework bağımsız, düşük katmanlı mimari
- GitHub Actions CI + GitHub Pages dağıtımı
- Node testleri ve servis şema doğrulaması

ArcGIS SDK uygulama paketine gömülmez; 5.1 CDN üzerinden ihtiyaç duyulan modüller dinamik alınır. TypeScript doğrudan modern ES2022 modüllerine derlenir. Böylece uygulama küçük kalır, CBS katmanları servis bazında tembel yüklenir ve gereksiz framework yükü oluşmaz.

## Özellikler

- 3B yerel sahne, uydu/hibrit/topografik altlık seçenekleri ve dünya yükseklik modeli
- `public/services.json` içindeki servisleri türlerine göre otomatik yükleme
- FeatureServer, SceneServer, MapServer, WMS ve WFS desteği
- Katman arama, kurum bazlı gruplama, görünürlük, saydamlık, bağlantı durumu ve katmana yaklaşma
- 3B mesafe/alan ölçümü, gün ışığı, kesit, görüş hattı, lejant ve altlık galerisi
- Adres/yer arama, Home, pusula ve tam ekran kontrolleri
- Harita tıklamasında öznitelik paneli
- Kamera, altlık ve katman tercihlerinin tarayıcıda saklanması
- Kamera + aktif katmanların URL ile paylaşılması
- Responsive tasarım, klavye kısayolları ve `prefers-reduced-motion` desteği
- Servis hataları için görünür durum, kullanıcı bildirimi ve yeniden deneme
- GitHub Pages için otomatik deployment workflow'u

## Kurulum

Gereksinim: Node.js 22.12+.

```bash
npm install
npm run dev
```

Kalite kontrolü:

```bash
npm run check
```

Üretim derlemesi:

```bash
npm run build
npm run dev
```

## Servis kataloğu

Herkese açık belediye servisleri `public/services.json` dosyasına alınmıştır. Erişim belirteci içeren WMS/WFS adresleri güvenlik nedeniyle public depoya yazılmaz; güvenli proxy şablonu `public/services.private.example.json` ve `docs/SECURE_SERVICES.md` altında açıklanır. Şema:

```json
{
  "services": [
    {
      "ustKurumAdi": "...",
      "metaveriSahibiKurumAdi": "...",
      "cografiVeriKatmanAdi": "...",
      "servisTuruAdi": "WMS | WFS | MapServer | FeatureServer | SceneServer",
      "tokenUrl": "https://..."
    }
  ]
}
```

> **Güvenlik notu:** `tokenUrl` alanındaki URL'ler tarayıcı tarafından doğrudan kullanılacağı için GitHub Pages gibi statik bir yayında ziyaretçiler tarafından görülebilir. Bu nedenle erişim belirteci içeren adresler public yapılandırmadan çıkarılmıştır. Ayrıntı için `docs/SECURE_SERVICES.md` dosyasına bakın.

## CORS ve servis uyumluluğu

WMS/WFS servisleri tarayıcıdan çağrıldığı için servis sunucusunda CORS izni bulunmalıdır. ArcGIS REST servislerinde de HTTPS ve tarayıcı erişimi beklenir. Uygulama yükleme hatalarını katman kartında gösterir ve yeniden deneme sunar.

## GitHub Pages

`.github/workflows/pages.yml` hazırdır. Depo ayarlarında **Settings → Pages → Source: GitHub Actions** seçildiğinde `main` dalına yapılan push sonrası dağıtım otomatik çalışır.

## Kısayollar

- `H`: başlangıç görünümü
- `L`: katman paneli
- `F`: tam ekran
- `Esc`: açık analiz aracını kapat

## Yapı

```text
src/
  services/       servis kataloğu + layer factory
  ui/             katman paneli, araç çubuğu, bildirimler
  utils/          DOM ve localStorage yardımcıları
  main.ts         3B sahne ve uygulama orkestrasyonu
public/
  services.json   sağlanan servis kataloğu
scripts/
  validate-services.mjs
.github/workflows/
  ci.yml
  pages.yml
```

## Lisans

MIT. Harita/veri servislerinin kendi lisans ve kullanım koşulları ayrıca geçerlidir.
