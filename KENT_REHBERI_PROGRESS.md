# Kent Rehberi — Geliştirme İlerleme Kaydı

> Bu canonical entrypoint bounded tutulur. Bu checkpoint öncesindeki tam canonical progress sürümü [`KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261005_PRE_PR459.md`](./KENT_REHBERI_PROGRESS_ARCHIVE_MAIN_THROUGH_20261005_PRE_PR459.md) içinde aynı Git blob SHA ile kayıpsız korunur; önceki archive zinciri de o dosyadan erişilebilir.

## Deep Platform / governed browser runtime coordination — PR #459 merge-gate checkpoint — 2026-10-05
- Önceki Platform checkpoint'i archive zincirinde korunur; bu dosyanın önceki main blob'u `179cbbc63d9ea678ff44809b299fd9f3acd56b7b` üzerinden kayıpsız erişilebilir.

## Deep Experience / notification triage modernization — PR #470 merge-gate checkpoint — 2026-10-05
- Önceki Experience checkpoint'i archive zincirinde ve yukarıdaki önceki main blob'unda kayıpsız korunur.

## Deep QA / release-regression continuation — 2026-10-05
- TUR / GÖREV: Deep QA / Release / Regression / Whole-Code Modernization; #471 squash merge sonrasında fresh-main release döngüsü.
- BRANCH: `agent/qa-release-20261005-2145-d364f99`, doğrudan verified current main `d364f991b88a0668a1337490227af4936eac232f` üzerinden oluşturuldu; eski squash-merged QA branch'i yeniden kullanılmadı.
- CURRENT MAIN: `d364f991b88a0668a1337490227af4936eac232f`; commit GitHub tarafından verified ve parent `1773e720964df105a3728b2eab54a5e3c730023c`.
- AÇIK PR ENTEGRASYON RİSKİ: #477 GIS current main'i takip ediyor; #473 Platform current main'den 1 behind olduğunu kendi checkpoint'inde bildiriyor; #474 Experience ve #472 Search daha eski base lineage üzerinde. Bunlar global blokaj değildir fakat QA merge öncesi fresh-main refresh ve cross-surface regression zorunludur.
- QA BASELINE: #471 ile release admission/lifecycle/evidence, page usability, whole-page experience ve tooling-language contract auditleri main'e girdi. Yeni tur bunları gevşetmeyecek; yeni HIGH finding veya exact-base regresyon ancak kök neden düzeltmesiyle kapatılacak.
- CI: squash merge commit'i için pull-request-triggered workflow run bulunmaması beklenen durumdur; yeni QA PR exact head'i oluştuğunda Release QA, Webclient Quality, Platform Architecture Audit, Platform Typed Test Validation, Release Evidence Contract ve QA Typed Release Diagnostics yeniden doğrulanacak.
- GATE: Bu yeni QA turunda base...head additions henüz >=4,000 değildir; merge yasaktır. Satır doldurma yapılmayacak. Aynı branch/PR üzerinde gerçek release/regression/modernizasyon işi biriktirilecek.
- SECURITY / NETWORK / GIS: yeni endpoint, secret, telemetry, remote asset, WMS/WFS/WMTS veya ikinci icon authority eklenmedi. Açık GIS/Experience/Platform/Search değişiklikleri final QA sırasında birlikte değerlendirilecek.
- SONRAKİ GÖREV NOTU: fresh-main branch üzerinde release-risk auditini genişlet; özellikle açık PR'ların QA tooling ile etkileşimi, dependency/build/test sözleşmeleri, 2D/3D GIS lifecycle, network sınırları, responsive/a11y ve exact-base regression davranışlarını denetle. Meaningful additions >=4,000 olmadan merge etme; CI pending ise PR açık/draft kalsın.