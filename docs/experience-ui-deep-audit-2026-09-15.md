# Kent Rehberi — Deep Experience/UI Audit — 2026-09-15

## İncelenen yüzeyler
- Global application shell / `App.js`
- Header / `NavigationBar`
- Sidebar and query-window shell
- Map chrome / `ToolbarWidget`
- Layer management / `LayerListWidget`
- Legend tab / ArcGIS `Legend`
- Global search result window / `GenelAramaQeryWindow`
- ArcGIS popup styles and feature inspection surface
- Shared loading / error / empty primitives
- Utility rail / help / command center
- Responsive CSS paths and touch-target rules
- GIS icon resolver and service policy
- 3D entrypoint search

## Current architecture finding
The application is React 17 + Bootstrap/react-bootstrap + ArcGIS `esri-loader`, with a large legacy global CSS layer. A full framework migration would be high risk for a live GIS product, so this audit applies a compatibility-first design-system overlay rather than replacing the application shell.

## Existing design-system extraction
### Typography
Legacy CSS starts from 9px root sizing, while many components use 1.15–2.5rem values. This makes visual sizing inconsistent and produces oversized headings in some GIS dialogs. The deep layer establishes a component scale of:
- title: 20–28px
- section title: 15px
- body/control: 12–13px
- caption/meta: 10–11px
- keyboard/monospace hints: 9–10px

Local Ankara Display files are available through the application font stylesheet, so the design layer does not add a remote font dependency.

### Spacing
The compatibility overlay uses a 4px base scale: 4 / 8 / 12 / 16 / 20 / 24 / 32. Dense data rows use 8–12px vertical rhythm rather than legacy 20px padding.

### Control sizing
Desktop controls target ~40px height. Touch interactions target at least 44px for icon buttons and key action controls. Small visual affordances can remain below 44px only when they are not the interactive hit area.

### Grid
Desktop content uses max-width-aware two/four column patterns; tablet collapses to two columns; mobile collapses to one column. Query windows use a viewport-safe max width instead of fixed 400–750px geometry.

### Color
Light:
- page background: `#f4f7fb`
- surface: `#ffffff`
- secondary surface: `#f8fafc`
- tertiary surface: `#eef3f8`
- border: `#d8e0e9`
- primary text: `#172337`
- secondary text: `#4f6074`
- muted text: `#6b7a8d`
- accent: `#155eef`

Dark uses deep blue-gray surfaces and high-contrast text with lighter accent tones. Semantic success/warning/danger/info tokens are paired with text and borders so status is not conveyed by color alone.

### Surfaces / border / radius / elevation
- interactive control radius: 8px
- card: 12px
- panel: 14–16px
- dialog/modal: 16–18px
- pill/status: 999px
- small elevation uses border + subtle shadow, not large diffuse shadows
- modal/drawer gets the strongest elevation

### Iconography
The UI chrome added by Experience uses lightweight inline SVG only for generic chrome. GIS record/category icons are NOT re-mapped independently: the existing `gis-engine/iconResolver.js` remains the authority for JSON-driven GIS type/category resolution. The repository search did not expose a concrete JSON icon catalog path, so no fabricated mapping was added.

### Interaction states
Every deep-layer interactive component supports or documents:
- default
- hover
- focus-visible
- active/pressed
- selected
- disabled
- loading
- error

Focus uses a visible outline + focus ring and is not dependent on hover or color-only change.

### Motion
Motion is limited to transform/opacity/background/border transitions. The loading spinner is CSS-only. `prefers-reduced-motion: reduce` disables continuous spinner animation and transition-heavy effects.

### Responsive breakpoints
- ~1100px: lower grid density
- ~900px: panel width becomes viewport-safe
- ~780px: tablet behavior, toolbar compaction
- ~680px: header redesign, mobile query/drawer behavior
- ~520px: compact layer rows and 44px controls
- ~420px: command palette becomes mobile bottom sheet-like surface

### Theme behavior
The Experience layer uses `data-experience-theme` and localStorage. The deep tour also isolates theme ownership in `ExperienceThemeProvider`. Legacy NavigationBar dynamic stylesheet behavior was removed from the header implementation in favor of the unified token system.

## High-impact findings and fixes
### P0 — Header search state inconsistency
Legacy NavigationBar initialized the search state as a string but rendered `query.name`, then converted the state to an object on input. This could make the first render inconsistent and complicate keyboard behavior. The deep tour replaces this with a single string state and semantic `<form role="search">` input/submit behavior.

### P0 — Layer command bridge was decorative
The prior Experience utility could emit a layer event but the actual LayerList window was not mounted by `MapComponent`. The deep tour mounts `LayerListWidget` from the Experience surface and routes the utility action into the real widget lifecycle.

### P0 — Legend action did not target a real legend state
Layer List now owns an explicit `activeTab` so the utility can request either `layers` or `legend` instead of merely opening the window.

### P1 — Layer tree had unstable render keys
The legacy implementation created a new GUID key for every layer row on every render. Deep refactor uses persistent layer/group identifiers when available, reducing avoidable reconciliation churn.

### P1 — Layer tree controls were non-semantic div clicks
Visibility and layer rows now use actual buttons with `aria-pressed`, accessible labels and touch-safe hit areas.

### P1 — Loading depended on GIF assets
Shared loading primitives now use CSS spinners and semantic `role=status` / `aria-busy` states. This reduces one unnecessary asset dependency and provides better screen-reader output.

### P1 — Popup/result hover relied on forced white text
Result and popup surfaces now inherit the shared foreground/background tokens so light/dark mode does not invert legibility unexpectedly on hover.

### P1 — Global CSS had mixed visual contracts
A final-loaded compatibility layer normalizes query windows, ArcGIS popup surfaces, form controls, table-like results, focus states and responsive drawers without rewriting the underlying GIS business logic.

## Network / performance review
- No new remote font, analytics, CDN or third-party UI asset was introduced.
- Generic UI icons use inline SVG.
- Loading primitives avoid the legacy GIF.
- Existing ArcGIS SDK assets remain because they are functional platform dependencies, not decorative UI downloads.
- `styles.css` still contains a legacy Google Fonts `@import`; it should be removed in a dedicated CSS cleanup after validating that no legacy screen depends on it. This deep tour deliberately avoids copying a 13KB legacy stylesheet into an automated rewrite without browser regression testing.
- Search/result and layer surfaces use stable DOM and CSS transitions; no perpetual JS animation was introduced.

## Accessibility review
Implemented:
- semantic header/aside/nav/form/section/dialog/button controls
- accessible names for icon controls
- `aria-pressed` on layer visibility controls
- `aria-busy` + `role=status` for loading
- `role=alert` for fatal error surface
- reduced-motion
- forced-colors handling
- visible focus
- touch-target sizing
- keyboard shortcuts for command center/help
- Escape close behavior

Remaining browser validation:
- full keyboard traversal across every legacy query window
- screen-reader pass for dynamically generated GIS popup content
- contrast measurement against every third-party ArcGIS theme state

## 2D / 3D
No concrete `SceneView` / 3D UI entrypoint was found in repository code search during this tour. The deep tour therefore does not invent a new 3D experience. The design-system contract leaves room for 2D/3D parity when a real 3D entrypoint is introduced by the GIS/engine workstream.

## Acceptance checklist
- [x] shared design tokens
- [x] header/search polish
- [x] utility rail / command center
- [x] accessible layer tree
- [x] legend addressability
- [x] loading/error/empty semantics
- [x] responsive desktop/tablet/mobile rules
- [x] reduced motion / forced colors
- [x] no new WMS/WFS UI
- [x] no new remote UI assets
- [x] no second GIS icon mapping authority
- [ ] local browser visual regression
- [ ] final npm CI test/build result
- [ ] production browser screen-reader pass

## Next deep-pass priorities
1. Remove the legacy Google Fonts import after an isolated browser verification.
2. Replace duplicate theme ownership with one source of truth across Experience + NavigationBar + legacy light stylesheet.
3. Bind more command-center actions to existing WindowManager tools instead of introducing parallel routing.
4. Locate the actual JSON icon catalog and add integration tests around `resolveIcon` across table/list/2D/3D callers.
5. Add browser-level responsive and accessibility smoke coverage.
