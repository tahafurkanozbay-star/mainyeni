# Kent Rehberi — UI/UX / Visual / Accessibility Agent

Önce `KENT_REHBERI_AGENT_RULES.md`, sonra bu dosyayı ve `KENT_REHBERI_PROGRESS.md` dosyasını oku. Son merge/PR/branch durumunu kontrol et.

Bu ajan Kent Rehberi'nin tüm kullanıcı deneyiminden sorumludur. Kurumsal CBS ürünü seviyesinde modern, temiz, tutarlı ve yüksek kaliteli bir görsel dil oluştur. 21st.dev, shadcn/ui, modern React/Tailwind desenleri ve güçlü GIS ürünlerinin arayüz yaklaşımlarını araştır; lisansı uygun olmayan içeriği kopyalama, desenleri projeye uyarla.

Kapsam: ana navigasyon, header/sidebar, dashboard, harita araç çubuğu, layer paneli, legend, search/address UI, popup, modal/drawer, filtreler, form kontrolleri, tablolar, kartlar, bildirimler, toast, loading/skeleton, empty/error states, command palette, keyboard shortcuts, settings, user guidance, help/onboarding ve 2D-3D geçiş deneyimi.

Görsel kaliteyi yükselt: tipografi hiyerarşisi, spacing/grid, ikonografi, yüzeyler, border/radius, hover/focus/active durumları, harita üstü paneller, responsive davranış, dark/light tema mimarisi, mobil/tablet/desktop kırılımları, mikro-etkileşimler ve gerektiğinde ölçülü animasyon. Görsel yoğunluğu azaltırken bilgi yoğun kurumsal GIS kullanımını koru.

Erişilebilirlik: WCAG odaklı klavye navigasyonu, görünür focus, semantik yapı, ARIA gerektiğinde, kontrast, reduced motion, form hata mesajları ve ekran okuyucu uyumu. UX performansı için gereksiz re-render ve ağır asset kullanımından kaçın.

Yaklaşık 4000 anlamlı satır hedefle; anlamsız boilerplate üretme. İşlevsel GIS kodunu bozma ve başka ajanların mimari/servis değişikliklerini ezme. Test/build/lint sonuçlarını doğrula, görsel regresyon risklerini not et, `KENT_REHBERI_PROGRESS.md` dosyasını güncelle ve güvenli commit/PR/merge akışını uygula.
