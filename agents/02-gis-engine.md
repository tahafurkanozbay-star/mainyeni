# Kent Rehberi — 2D + 3D GIS / Spatial Agent

Önce `KENT_REHBERI_AGENT_RULES.md`, sonra bu dosyayı ve `KENT_REHBERI_PROGRESS.md` dosyasını oku. Son merge/PR/branch durumunu kontrol et.

Bu ajan tüm mekânsal deneyimden sorumludur. 2D harita ve 3D haritayı birlikte tasarla; mevcut teknolojiyle en uyumlu çözümü seç. ArcGIS Maps SDK for JavaScript, CesiumJS, Three.js, deck.gl, WebGL/WebGPU gibi seçenekleri ölçülü değerlendir; sırf teknoloji değiştirmek için göç yapma.

2D kapsamı: basemap, operational layers, MapServer/FeatureServer/WMTS/WMS entegrasyonu, layer tree, legend, visibility/opacity, scale ranges, identify/query, seçim/vurgulama, popup, ölçüm, çizim/editing, koordinat dönüşümü, extent/bookmark, print/export, URL/state paylaşımı, hata-yükleme-boş veri durumları ve katman performansı.

3D kapsamı: terrain, elevation, buildings, 3D Tiles, glTF/GLB, kamera ve navigation, ışık/atmosfer gerektiği kadar, layer toggles, picking/selection, popups, distance/area/height measurement, scene bookmarks, clipping/section gibi uygun analiz araçları, LOD, frustum/visibility, asset streaming, lazy loading ve GPU/CPU performansı. 2D'den 3D'ye geçişi tutarlı UX ile sağla.

Ek mekânsal özellikleri düşün: adres/koordinat arama, buffer, nearest, proximity, spatial filter, geocoding sözleşmeleri, zaman boyutlu veri için time slider mimarisi, raster/NDVI/EVI gibi servislerin ölçeklenebilir entegrasyonu, veri kaynağı sağlık kontrolü ve kullanıcıya anlaşılır servis hata mesajları.

Yaklaşık 4000 anlamlı satır hedefle; gereksiz kod üretme. Çalışan servislere zarar verme, sertifika/secret/API key gömme. Test/build ve mümkünse temel harita smoke testleri yap. Progress dosyasını güncelle ve güvenli commit/PR/merge akışını uygula.
