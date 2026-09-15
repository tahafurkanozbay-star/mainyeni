# Kent Rehberi — Geliştirme İlerleme Kaydı

## Başlangıç Durumu
- Ortak agent kuralları repository'ye eklendi.
- Ana kural dosyası: `KENT_REHBERI_AGENT_RULES.md`
- Sıralı görev alanları: Architecture → UI/UX → 2D GIS → 3D GIS → GIS Data/Services → Search/Address → Performance → Security → Accessibility/Responsive → Final QA/Release

## Son İşlem
- İşlem: Experience UI temelinin ve kurumsal GIS tasarım sözleşmesinin eklenmesi
- Durum: tamamlandı
- Eklenen belge: `docs/experience-ui-foundation.md`
- İncelenen uygulama: `Webclient.app`
- Mevcut stack gözlemi: React 17, react-scripts 4, Bootstrap 5, react-bootstrap, Font Awesome, react-icons, Redux, esri-loader, axios
- Not: WMS/WFS eklenmedi. UI görevi mevcut GIS davranışlarını koruyacak şekilde tasarım sistemi ve erişilebilirlik temeliyle sınırlı tutuldu.

## Yapılanlar
- AppShell, header/sidebar, map toolbar, layer tree, legend, search, feature details, table, toast, command palette, settings ve onboarding için ortak UI sözleşmesi tanımlandı.
- Responsive desktop/tablet/mobile yerleşim modeli belirlendi.
- Dark/light tema, reduced-motion, WCAG, keyboard navigation, visible focus, ARIA ve screen-reader gereksinimleri tanımlandı.
- Harita paneli yoğunluğu, loading/empty/error durumları ve 2D/3D geçiş tutarlılığı için tasarım kuralları eklendi.
- UI performansı için lazy-load, virtualization, asset bütçesi ve gereksiz re-render önleme ilkeleri kaydedildi.

## Network / Veri Politikası
- Gereksiz üçüncü taraf çağrıları, remote font/CDN/analytics ve dış asset istekleri eklenmeyecek.
- Browser'a ulaşan verinin Network panelinden tamamen gizlenemeyeceği kabul edildi; sahte gizlilik garantisi verilmeyecek.
- Uygulama verisi için same-origin/BFF/server-side taşıma Platform ekibiyle koordineli ilerleyecek.

## İkon Eşleştirme Politikası
- Tür/kategori → JSON ikon konfigürasyonu → deterministic shared icon resolver/registry yaklaşımı kullanılacak.
- Liste, tablo, 2D marker ve 3D gösterimde aynı kaynak mümkün olduğunca paylaşılacak.
- Eksik/unknown türler erişilebilir ve görsel olarak tutarlı fallback ile gösterilecek.

## Test / Doğrulama
- Bu turda repository içeriği ve `Webclient.app/package.json` incelendi.
- Stack doğrulandı; mevcut UI altyapısının React 17 + Bootstrap/react-bootstrap ağırlıklı olduğu görüldü.
- Bu çalışma ortamında uygulama build/lint/test komutları çalıştırılmadı; sonraki kod turunda doğrulanacak.

## Sonraki İşlem
- Experience: `docs/experience-ui-foundation.md` sözleşmesini gerçek `Webclient.app/src` bileşenlerine kontrollü biçimde uygulamak; önce mevcut `App.js`, `styles.css`, `styles.responsive.css` ve ana bileşenleri analiz etmek.
- GIS Engine: icon resolver/registry ve gerçek JSON ikon kaynağını bulup ortaklaştırmak; WMS/WFS eklememek.
- Platform: Network çağrıları, .env, same-origin/BFF uygunluğu ve build/test otomasyonunu doğrulamak.

## Kurallar
Her görev önce `KENT_REHBERI_AGENT_RULES.md`, ardından kendi görev kuralını ve bu dosyayı okumalıdır. Önceki değişiklikler korunmalı; çakışma ve overwrite önlenmelidir.
