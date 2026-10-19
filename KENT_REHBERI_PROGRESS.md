# 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması — Güncel Geliştirme Kaydı

> Bu dosya yalnızca güncel durum ve sonraki işlerin kısa entrypoint'idir. Önceki ayrıntılı kayıtlar ve tam önceki progress snapshot'ı kayıpsız biçimde [`progress/archive/`](./progress/archive/) altında tutulur.

## Güncel ana dal ve yayın mimarisi — 2026-10-19

- **Ürün:** 3D Altyapı / Üstyapı Koordinasyon Web Uygulaması.
- **Ana dal checkpoint'i:** `9d83821c132e43afe14d9924435e271d5506fbc6` (önceki PR #538'in merge commit'i). Bu commit'te Release QA, Webclient Quality, Typed Source Boundary, Release Evidence Contract, Pages build/deployment, Platform Governance Validation ve Platform Typed Test Validation iş akışları başarıyla tamamlandı.
- **Aktif yayın ürünü:** `Webclient.app/` statik React/TypeScript/Vite/ArcGIS SPA'sı. Yayın paketi ayrı ABB User API/Admin API, veritabanı/PostGIS veya uygulamaya özel proxy gerektirmez.
- **Kent Rehberi kaynağı:** tarayıcıdan doğrudan sabit PlanASKI uç noktası: `https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=N`. `tur=0..42` sınırları, JSON şema/kimlik/koordinat doğrulaması, 8 MiB kategori yanıt bütçesi, 20.000 kayıt üst sınırı, eşzamanlılık kontrolü ve iptal kuralları korunur.
- **Başlangıç haritası:** yerel, sabit Ankara görünümü. Eski API tabanlı başlangıç yapılandırması ve özel API proxy'si aktif çalışma yolundan çıkarılmıştır.
- **Üretim önkoşulu:** PlanASKI'nin `https://cbs.ankara.bel.tr` origin'ine CORS izni canlı tarayıcıda ayrıca doğrulanmalıdır. Yerel test/CI bu üretim koşulunu kanıtlamaz.
- **IIS:** kaynak değişikliği daha önce oluşturulmuş `/api` eşlemesini veya fiziksel `user` klasörünü canlı sunucudan otomatik kaldırmaz. Silmeden önce mevcut IIS uygulama eşlemeleri ve başka uygulamalar tarafından kullanım kontrol edilmelidir.

## Bu turdaki yapı ve tutarlılık denetimi

- Root'taki büyük, tarihsel progress/arşiv dosyaları `progress/archive/` altında toplandı; tam önceki `KENT_REHBERI_PROGRESS.md` sürümü arşivlendi ve root dosyası kısa entrypoint'e dönüştürüldü. Arşiv içerikleri kopyalama öncesi/sonrası karşılaştırılarak korunmalıdır.
- README, dağıtım/veri kaynağı belgeleri ve agent çalışma kuralları statik-only + doğrudan PlanASKI mimarisiyle uyumlu hale getiriliyor.
- HTML sayfa title, açıklama ve sosyal meta verileri kullanıcı tarafından belirtilen resmi ürün adına göre düzeltildi.
- Kullanılmayan `VITE_KENT_REHBERI_SOURCE` seçim bayrağı ve buna bağlı kaynak modu açıklamaları temizleniyor; doğrudan PlanASKI taşıması artık mod seçimine bağlı değildir.
- Ayrı GIS çekirdek kaynakları (`KentRehberi/webclient/`, `WebClient/`) bağımsız test/kalite bağlamları kanıtlanmadan silinmedi veya üretim SPA'sına taşınmadı.
- Tam kalite doğrulaması bu branch'in değişiklikleri için henüz raporlanmadı; PR açıldıktan sonra yeni exact-head CI sonuçları beklenmelidir.

## Açık riskler / devam işleri

1. Bu turdaki yapısal/dokümantasyon düzenlemelerini test ve kalite iş akışlarından geçir; başarısız denetimleri kontrolü gevşetmeden düzelt.
2. Arşivlenen dosyalardaki göreli bağlantıları ve tüm progress bağlantılarını doğrula. Arşivler içerik geçmişidir; canlı durum için yalnız root entrypoint kullanılmalı.
3. Üretim `cbs.ankara.bel.tr` origin'inden gerçek tarayıcı Network testiyle PlanASKI CORS iznini doğrula. CORS başarısızsa PlanASKI yöneticisiyle izin-listesini düzelt; proxy ekleme.
4. IIS üzerinde statik paket, `web.config`, alt yol varlıkları, yenileme/SPA fallback, 2D/3D geçişleri, sorgu pencereleri ve kategori katmanlarını smoke-test et. Bu kontroller canlı sunucu/browser üzerinden yapılmadı.
5. Açık eski draft PR'ları (özellikle GIS/Experience/Search ve eski Admin odaklı iş) current main ile karşılaştırıp kanonik/superseded kararını ayrı ve kanıtlı biçimde ver; bu turda branch'leri körlemesine kapatma.
6. `Webclient.app` bağımlılık grafiğinde artık kullanılmayan paketleri gerçek import/lockfile kanıtına göre belirle; sırf klasör yaşı veya ada bakarak silme.

## Bu turdaki branch ve PR

- **Branch:** `agent/structure-hygiene-20261019-0520-9d83821`
- **Base:** `9d83821c132e43afe14d9924435e271d5506fbc6`
- **Durum:** açık değişiklik; PR/CI sonucunu doğruladıktan sonra güncelle.
- **Merge kuralı:** tüm ilgili exact-head kalite iş akışları başarılı, branch güncel/mergeable, review ve regressions temiz olmadan merge etme.

## Arşiv politikası

`progress/archive/README.md` içindeki kuralları takip et. Tarihsel entry'leri silme; root progress dosyasını büyük olay günlüğüne dönüştürme. Yeni kayıtlar kısa, tarihli ve eylem odaklı olmalıdır.
