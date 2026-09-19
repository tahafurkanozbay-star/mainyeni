# Kent Rehberi — Geliştirme İlerleme Kaydı

> Historical progress remains canonical on `main` at base `a7b965cf26c9c8c51efc885cb884da5155e9f799`. This branch-scoped checkpoint records the current Platform continuation without rewriting concurrent teams' history.

## Deep Platform / Cache governance — 2026-09-19 22:02 TRT
- TUR / GÖREV: Deep Platform / Architecture / Whole-Code Modernization; fail-closed browser request-cache admission and data-classification contract.
- BASE MAIN: `a7b965cf26c9c8c51efc885cb884da5155e9f799`, verified current main at turn start.
- BRANCH / PR: `agent/platform-cache-governance-20260919-2202-a7b965c`; draft PR #177 `feat(platform): govern browser cache admission`.
- HEAD before this progress commit: `9cfa6f1e5d7114153ebfcc92bf122a08c632fbf9`.
- MERGE DURUMU: OPEN / NOT MERGED. PR snapshot before progress = 85 additions / 0 deletions / 2 files. Mandatory >=4,000 meaningful additions gate is not met; merge is forbidden.
- ÖNEMLİ ÖZELLİKLER: strict-TypeScript central cache policy; only explicitly cacheable public/internal GET/HEAD data can be admitted; mutation methods, personal/sensitive data and authenticated/authorization-bearing responses fail closed; TTL and stale-while-revalidate windows are bounded.
- DEĞİŞEN DOSYALAR: `Webclient.app/src/platform/cache/cachePolicy.ts`, `cachePolicy.test.ts`, this branch-scoped progress checkpoint.
- TESTLER / BUILD / CI: focused Vitest coverage was added for admission, unsafe methods, sensitive classification, authorization, explicit opt-in and duration clamping. Exact-head GitHub Actions has not completed after these commits; no PASS is claimed. Required CI remains mandatory before eventual merge.
- NETWORK DEĞİŞİKLİKLERİ: none. No new endpoint, direct fetch, WMS/WFS, telemetry, CDN or remote asset.
- GÜVENLİK KONTROLLERİ: cache defaults are fail-closed and avoid retaining authenticated/personal/sensitive responses by inference; no secret/token introduced.
- İKON EŞLEŞTİRME: unchanged; shared GIS icon authority remains canonical.
- MODERNİZASYON KARARI: extend the existing strict-TypeScript platform/cache boundary rather than introduce another caching dependency or service worker cache. Current stable stack remains unchanged.
- PERFORMANS ETKİSİ: enables bounded explicit cache freshness policy while preventing unsafe broad caching; no polling/timer loop added.
- ÇÖZÜLEN HATALAR: existing RequestCache documented cacheability expectations but had no reusable typed admission policy; consumers can now make deterministic fail-closed decisions.
- KALAN SORUNLAR / SONRAKİ GÖREV: continue only on canonical PR #177 while it remains based on current main; build meaningful Platform scope toward >=4,000 additions with cache namespace/invalidation governance, in-flight dedupe/resource ownership, HTTP cache integration and regression tests without overlapping Experience #173, GIS #175 or Business #176. Inspect exact-head CI each turn, fix real failures, run second verification, security/performance/regression review and final current-main refresh before any merge.
