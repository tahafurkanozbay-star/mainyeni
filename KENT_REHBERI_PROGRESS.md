# Kent Rehberi — Geliştirme İlerleme Kaydı

> Full historical progress remains available on `main` at the parent commit. This continuation record preserves the current canonical handoff state.

## Deep GIS continuation — 2026-09-16 14:14 TRT
- PR #66 continued bounded ArcGIS feature data lifecycle work from `c89ef2a5ab2fd1d633d10447c5db56f177811bed`; exact historical detail remains in the parent history.

## Deep Platform / Architecture — 2026-09-16 17:00 TRT
- PR #72 delivered runtime supervision/toolchain/CI modernization with 4,944 additions and was squash merged as `3660cc87bc51a09d94297d7d752dc4bc2bbaa1fe`; the subsequent progress commit advanced main to `2dd3ce93a4581959ce37bdca7ecc9c9920b8b9c0`.

## Deep Experience continuation — 2026-09-17 04:26 TRT
- TUR / GÖREV: Deep Experience / Whole-Code Modernization; accessible GIS primitive regression hardening.
- BASE MAIN: `2dd3ce93a4581959ce37bdca7ecc9c9920b8b9c0`; PR #74 remains current and GitHub reports `mergeable=true` before this pass.
- BRANCH: `agent/experience-ui-20260916-1724-2dd3ce9`.
- PR: #74 remains the canonical open Experience PR.
- HEAD BEFORE THIS PASS: `5fd68aebd75b5a855fcfed613ddfb54eb7a859ae`; exact-head Platform Architecture Audit, Release QA and Webclient Quality all completed successfully.
- MERGE DURUMU: NOT MERGED. Pre-pass base...head = 419 additions / 30 deletions / 9 files, far below the mandatory 4,000 meaningful-additions gate.
- ÖNEMLİ ÖZELLİKLER: existing form/table/disclosure/status/progress/toolbar primitives retained. This pass fixes toolbar roving-tabindex entry when the first action is disabled: the first enabled action now receives the sole initial tab stop, while disabled/all-disabled collections remain safely non-focusable.
- DEĞİŞEN DOSYALAR THIS PASS: `Webclient.app/src/Components/Common/ExperienceToolbar.tsx`; this progress record.
- TESTLER / BUILD / CI: pre-pass head `5fd68aeb...` passed all three relevant Actions. New toolbar code commit is `34721d27eafc9082f55250cecdbbb571a73bb5a2` before this progress commit; exact-head Actions must complete again, so PASS is not claimed for the new code yet.
- NETWORK DEĞİŞİKLİKLERİ: none. No endpoint, WMS/WFS/WMTS, analytics, CDN, dependency or remote asset added. Legacy remote Mukta import remains queued for safe removal.
- GÜVENLİK / ACCESSIBILITY: toolbar remains keyboard reachable when its first declared action is disabled; Arrow/Home/End navigation continues to operate only over enabled native buttons. No secret, unsafe HTML or dynamic remote content introduced.
- İKON EŞLEŞTİRME: unchanged; shared deterministic resolver remains canonical.
- MODERNİZASYON KARARI: keep keyboard behavior in the shared native-button toolbar primitive instead of requiring each GIS screen to repair focus order independently.
- PERFORMANS ETKİSİ: one linear `findIndex` over toolbar actions per render; no polling, timers, observers, network or dependency cost.
- ÇÖZÜLEN HATALAR / UX BORCU: fixed loss of Tab entry when toolbar action index 0 is disabled.
- KALAN SORUNLAR / SONRAKİ GÖREV: verify new exact-head CI; continue same PR while current/mergeable with real-screen toolbar/panel integration, 2D↔3D controls, remote-font cleanup and repo-native interaction/accessibility regressions until >=4,000 meaningful additions. Require second interaction/regression review and final main refresh before squash merge.
