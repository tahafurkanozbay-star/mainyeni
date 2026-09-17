# Güvenli WMS/WFS servisleri

Bu depo herkese açık olduğu için kullanıcı tarafından sağlanan, erişim belirteci içeren UCBP WMS/WFS URL'leri repoya yazılmaz. Statik bir web uygulamasına gömülen URL veya token ziyaretçiler tarafından görülebilir.

`public/services.private.example.json` yalnızca şablondur. Gerçek erişim adreslerini doğrudan GitHub'a, JavaScript'e veya GitHub Pages çıktısına koymayın.

Üretimde önerilen model:

1. Tarayıcı yalnızca kurumunuza ait aynı-origin bir `/geoservices/*` proxy adresini çağırır.
2. Proxy gerçek WMS/WFS hedefini ve kısa ömürlü erişim bilgisini sunucu tarafında saklar.
3. Proxy istek başına yetkilendirme, hız sınırı, audit log ve CORS politikasını uygular.
4. Gerekirse GetCapabilities yanıtları ve salt-okunur harita istekleri kısa süreli önbelleğe alınır.

Uygulamanın WMS/WFS katman motoru hazırdır; güvenli proxy URL'leri `public/services.json` içine eklendiğinde diğer katmanlarla aynı panelde çalışır.
