# Platform Deep Audit — 2026-09-15

## Evidence-first findings
- Frontend is React 17 + react-scripts 4 with Bootstrap/react-bootstrap, Redux, esri-loader and axios.
- The current CRA browser entry imports IE9/IE11 polyfills, adding compatibility cost to every build.
- `App.js` loads map configuration and GIS service configuration concurrently and then registers proxy rules from the public service descriptors.
- `ConfigurationBusiness` still wraps raw axios calls in unnecessary Promise constructors and depends on a browser-generated AES bearer value.
- `AuthBusiness` uses `REACT_APP_CLIENT_KEY`, but any `REACT_APP_*` value is public after build and cannot be a security secret.
- `Api.User/Controllers/Base/BaseUserApiController.cs` validates that bearer using a hard-coded AES secret; this creates a shared-secret browser/server design that should be retired in a controlled migration.
- `Api.User/Controllers/Extensions/Gis/GisProxyController.cs` is the highest network/security risk: it can fall back from encrypted service identifiers to URL lookup and has a `ByPassProxy` path that can forward the raw requested URL.
- `GisConfigServiceOperations.GetAllForPublic()` intentionally withholds the real URL and publishes only an encrypted service identifier, which is compatible with a server-owned allowlist model.
- Legacy `CommonBusiness.CreateLayer()` still loads `WMSLayer`; project policy forbids new WMS/WFS and future platform work must not expand that path.
- `Api.User/appsettings.json` was previously cleaned, while `Api.Admin/appsettings.json` still contains database credentials and must be remediated.
- Backend targets net6.0. Dependency generations are mixed (EF Core 7 packages on net6 target, old ASP.NET Core 2.2 packages); migration should be measured rather than performed as part of this change.
- Existing test surface includes starter-style CRA assertions; meaningful tests are needed around platform HTTP and configuration behavior.
- No service worker file exists at `Webclient.app/public/service-worker.js`; PWA behavior must be verified from the actual public/runtime files before assuming offline guarantees.

## Priorities
1. Prevent arbitrary proxy destinations and remove the URL fallback.
2. Move public bootstrap GETs to the centralized API client with cache/deduplication.
3. Remove browser-side shared-secret dependence from bootstrap configuration calls.
4. Move remaining server secrets out of source control.
5. Add meaningful platform tests and CI validation before framework migration.
6. Measure bundle/network/runtime costs before changing React/CRA or removing compatibility dependencies.
