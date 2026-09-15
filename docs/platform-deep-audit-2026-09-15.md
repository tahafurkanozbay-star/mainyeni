# Platform Deep Audit — 2026-09-15

## Scope
Enterprise platform architecture audit after the merged Experience/GIS work. This document records evidence before further refactoring.

## Current runtime observations
- Frontend: React 17, react-scripts 4, Bootstrap/react-bootstrap, Redux, esri-loader and axios.
- Backend: ASP.NET Core 6 API projects with shared Api.Core/Business/Toolbox projects.
- GIS: backend-owned configuration is exposed through API contracts; frontend has shared GIS registry/layer runtime primitives.
- PWA: runtime/service-worker implementation must be verified from repository rather than assumed from package metadata.
- Configuration: browser configuration must contain routing/public metadata only; server secrets stay outside source control.

## Highest-risk findings
1. Legacy business modules still create raw axios calls and custom auth headers instead of using the platform HTTP boundary.
2. `AuthBusiness` derives a bearer value with a client-side key. A client-exposed encryption key cannot be treated as a secret and should not be the security boundary.
3. `AppConfig` reads `REACT_APP_API_URL`; the platform runtime config already defines a safer same-origin default, so configuration has two competing sources.
4. API CORS is safer than the original permissive configuration, but the service should prefer same-origin deployment and keep allowed origins empty unless cross-origin access is explicitly required.
5. Backend API projects target net6.0; package versions are mixed across EF Core 6/7-era dependencies. Upgrade requires compatibility and runtime evidence, not blind migration.
6. Existing frontend compatibility targets include IE-era polyfills/browserslist, increasing bundle and maintenance cost for modern browsers.
7. A default Create React App test still references the starter "learn react" content and is not a meaningful regression test for the actual application.
8. The frontend has a growing platform layer, but the highest-value migration is call-site-by-call-site rather than a broad rewrite.

## Network policy
Only existing, justified application/GIS endpoints should be reachable. New third-party analytics, fonts, generic CDNs, geocoding or map providers are prohibited unless explicitly justified and reviewed. Browser-visible data is not considered secret merely because it is proxied.

## Migration strategy
1. Consolidate browser API configuration on `runtimeConfig`.
2. Migrate low-risk, read-only configuration calls first.
3. Preserve existing response contracts and auth behavior until server-side authentication is available.
4. Add tests around abort/error/cache behavior before migrating higher-risk calls.
5. Measure before dependency/framework migration.
