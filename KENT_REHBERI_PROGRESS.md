# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Önceki canonical kayıtlar repository archive zincirinde kayıpsız korunur.

## Deep Platform / dependency supply-chain governance — PR #473 checkpoint — 2026-10-05
- TUR / GÖREV: Deep Platform / Whole-Code Modernization; dependency manifest, lock graph, registry/integrity provenance, transitive peer metadata ve lifecycle/deprecation yüzeylerini deterministic fail-closed authority ile yönetme.
- BRANCH / PR: `agent/platform-wholecode-20261005-1329-07d197bc`; PR #473 kanonik Platform devam PR'ıdır ve draft kalır.
- CURRENT MAIN / LINEAGE: PR base/current-main checkpoint `d364f991b88a0668a1337490227af4936eac232f`; reconciliation sonrası Platform branch current main'e 0 behind ve PR mergeable=true idi. Her merge kararından önce main/merge-base tekrar doğrulanmalıdır.
- KAPSAM / GATE: reconciliation head `90132b0c469d4695f09348b9f6284f966d9137fe` için GitHub base...head 3,449 additions / 94 deletions / 15 dosya; mandatory >=4,000 meaningful-additions gate henüz kapalıdır.
- CI / ROOT CAUSE: exact reconciliation head'de Platform Architecture Audit, Release Evidence Contract ve Platform Typed Test Validation success; Platform Dependency Governance, Webclient Quality ve Release QA failure. Dedicated dependency artifact açıldı: manifest/source/lock/resolution kontrolleri PASS; graph 418 reachable / 428 node, unresolved=0, deprecated=4, install-script=10. Transitive governance yalnız üç `unnecessary peer exception` nedeniyle fail-closed durdu: Vitest `@vitest/browser-webdriverio`, `happy-dom`, `jsdom`. Bu peer'ler mevcut graph'ta policy finding üretmediği için exception tutulması stale debt sayılıyor.
- REPAIR: `dependency-policy.json` üç gereksiz Vitest peer exception'ından arındırıldı; gerçek kullanılan exception sayısı 8'e ratchet edildi. Global peer enforcement, exact package+peer+range matching, expiry/owner/reason kuralları ve hard budget gevşetilmedi. Repair commit `5f7ff8834e6acf5f2fb8ef46cb1a54dd992dcda2`.
- SECURITY / NETWORK: yeni endpoint, browser transport, telemetry, secret, remote asset veya WMS/WFS eklenmedi. Değişiklik yalnız supply-chain policy borcunu azaltır.
- MERGE DURUMU: additions <4,000 ve repair exact-head CI henüz materialize olmadığı için merge yapılmaz.
- SONRAKİ GÖREV NOTU: repair exact-head CI'ını doğrula. Dependency governance PASS olursa aynı PR üzerinde install-script provenance/exception ratchet ve doğrulanmış unused/deprecated direct dependency removal planning ile gerçek Platform kapsamını >=4,000 additions'a ilerlet. Final exact-head full CI, security/performance/regression review, fresh-main 0-behind/exact merge-base ve mergeable=true olmadan merge etme.
