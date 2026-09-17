# Security Policy

## Hassas servis URL'leri

Bu uygulama istemci tarafında çalışır. `public/services.json` içindeki URL'ler kullanıcı tarayıcına gönderildiği için **gizli kabul edilemez**.

- Uzun ömürlü erişim anahtarlarını veya yönetici tokenlarını repoya koymayın.
- Kimlik doğrulama gerekiyorsa kısa ömürlü token üreten sunucu tarafı bir katman/proxy kullanın.
- Token sızıntısı şüphesinde ilgili tokenı iptal edip yenileyin ve Git geçmişinden de temizleyin.
- CORS izinlerini mümkün olduğunca yalnızca gerekli origin'lerle sınırlandırın.

## Raporlama

Güvenlik açığı bulursanız herkese açık issue açmadan depo sahibine özel kanaldan iletin.
