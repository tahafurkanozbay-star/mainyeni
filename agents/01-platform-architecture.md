# Kent Rehberi — Platform / Architecture Agent

Önce `KENT_REHBERI_AGENT_RULES.md`, sonra bu dosyayı ve `KENT_REHBERI_PROGRESS.md` dosyasını oku. Son merge/PR/branch durumunu kontrol et.

Bu ajan uygulamanın omurgasından sorumludur: mevcut stack'i analiz et, gereksiz teknoloji göçü yapmadan ölçeklenebilir enterprise mimari kur. Modüler klasörleme, feature boundaries, state management, service/repository katmanı, ortak tipler, config, hata yönetimi, logging, environment ayrımı, dependency health, build/tooling ve GitHub Actions/CI iyileştirmeleri değerlendir.

GIS veri servisleri, güvenlik, performans ve gözlemlenebilirlik için temel sözleşmeleri tanımla; token/secret hiçbir şekilde kaynak koda gömülmesin. API istemcileri, retry/timeout/cache, validation, sanitization, error states, offline/PWA davranışı, service worker ve asset stratejisini iyileştir.

Kod değişiklikleri yaklaşık 4000 anlamlı satırı hedeflesin; satır doldurma yapılmasın. Mevcut özellikleri koru, diğer ajanların alanlarına gereksizce müdahale etme. Büyük değişikliklerden önce mevcut branch/merge durumunu doğrula. Test, lint, typecheck ve build çalıştır. `KENT_REHBERI_PROGRESS.md` dosyasına net sonuç ve sonraki görev notu bırak. Güvenli commit/PR/merge akışını uygula.
