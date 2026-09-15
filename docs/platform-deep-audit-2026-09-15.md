# Platform Deep Audit — 2026-09-15

## Evidence-first findings
- Frontend: React 17 + react-scripts 4, Bootstrap/react-bootstrap, Redux, esri-loader and axios.
- Backend: ASP.NET Core 6 API projects with shared Api.Core/Business/Toolbox projects.
- Configuration: browser build variables are public and must never be treated as secrets. Server DB/request credentials must come from environment or secret storage.
- `ConfigurationBusiness` was a high-value bootstrap call site still using raw axios and a browser-generated bearer value.
- `Api.User/Controllers/Extensions/Gis/GisProxyController.cs` was the highest-risk network path because URL fallback and bypass behavior allowed arbitrary upstream forwarding.
- `GisConfigServiceOperations.GetAllForPublic()` already exposes a sanitized service descriptor with an opaque encrypted identifier rather than the configured URL.
- Legacy `CommonBusiness.CreateLayer()` still contains a WMSLayer branch; platform work does not add to it because project policy forbids new WMS/WFS/WMTS integrations.
- Backend dependency generations are mixed (net6 target with EF Core 7 and older ASP.NET Core packages); no blind framework migration is justified without CI/runtime evidence.
- The project did not contain a registered service-worker path at the expected CRA locations, so offline support could not be assumed.

## Implemented priorities
1. Application API requests are constrained to same-origin relative paths.
2. Bootstrap reads use a centralized HTTP boundary with timeout, cancellation compatibility, bounded retries, explicit opt-in cache and safe error normalization.
3. Public bootstrap endpoints are restricted to intentionally public data; the map config endpoint accepts only `GisMapConfig`.
4. GIS proxy accepts only server-owned encrypted service identifiers on HTTPS `*.gissrv.org`; arbitrary URL fallback and bypass were removed.
5. DB/API shared secrets were removed from tracked configuration; missing server secrets fail closed.
6. Browser storage is bounded to non-secret application state.
7. Static-only PWA caching was added; API and GIS traffic are excluded from service-worker caching.
8. IIS security headers and static-asset cache policy were added.
9. Node/.NET CI validation workflows were added; dependency audit remains advisory until the existing legacy dependency surface is intentionally remediated.

## Remaining risks
- The repository still contains legacy raw axios call sites and a client-generated request secret path for other endpoints; those require call-site inventory and server-auth migration rather than a destructive global replacement.
- Historical Git commits may contain credentials that were removed from the current tree. Real-world secret rotation is still required.
- ArcGIS CDN usage remains for the current SDK and must be included in the eventual CSP allowlist; no new CDN was introduced.
- Real browser smoke, CWV and bundle-size measurements require a runnable checkout/CI artifact and are not claimed from the connector environment.
