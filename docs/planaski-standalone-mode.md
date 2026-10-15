# Database-free PlanASKI public map API (opt-in)

The standard `Api.User` and `Api.Admin` applications still require
`ConnectionStrings__Primary`. **Do not set a dummy database connection.**

For map-only development, `Api.User` can run with the separate, explicitly
enabled `KentRehberiData__Standalone=true` profile. In this mode it does not
register `BusinessContext` or discover legacy controllers that depend on the
application database. Only the existing anonymous `KentRehberiController`
is routable; the Admin API is unchanged.

## Run locally in PowerShell

From the repository root (separate terminal):

```powershell
$env:KentRehberiData__Standalone = "true"
$env:KentRehberiData__Source = "PlanAski"
$env:ASPNETCORE_URLS = "http://127.0.0.1:3002"
dotnet run --project .\Api.User\Api.User.csproj --no-launch-profile
```

In a second terminal:

```powershell
Invoke-WebRequest "http://127.0.0.1:3002/health/live"
Invoke-WebRequest "http://127.0.0.1:3002/health/ready"
Invoke-WebRequest "http://127.0.0.1:3002/kent-rehberi?tur=0&limit=10"
Invoke-WebRequest "http://127.0.0.1:3002/kent-rehberi?tur=42&limit=10"
```

To develop the Vite client against this API:

```powershell
cd Webclient.app
$env:VITE_API_PROXY_TARGET = "http://127.0.0.1:3002"
npm run dev
```

Vite forwards `/api/*` to `/*` on the API. The public URLs are
`/api/kent-rehberi?tur=0` and `/api/kent-rehberi/types`.

## Constraints and deployment

- Source is forcibly `PlanAski`, and `Enabled` must remain true.
  The pinned HTTPS source is
  `https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi`.
  `tur` is constrained to 0 through 42, inclusive.
- Only anonymous Kent Rehberi routes are discovered (search, single object,
  nearby, types, capabilities). There are no AppSettings, admin, authentication
  or generic GIS proxy endpoints. The full frontend may still require those
  endpoints for functionality outside the map-only API.
- The existing bounded PlanASKI fetch, URL validation, request deadlines,
  concurrency limits, GeoJSON normalization and caches are reused.
  An additional socket-IP-based 240-request/minute fixed-window limiter
  protects the standalone host. Forwarded client IP headers are not trusted.
  Configure client-aware limits on a **trusted** ingress reverse proxy.
- `/health/live` is a liveness probe. `/health/ready` checks the actual
  PlanASKI upstream and may return 503 if it is unavailable.
- No CORS origins are opened by default. Prefer same-origin reverse-proxy
  paths. For production deployment use HTTPS at a trusted ingress, access
  logging, secrets outside source, and explicit approval/rollout. This mode
  does **not** migrate data or alter IIS or PostgreSQL.

To return to the original backend, unset the flag:

```powershell
Remove-Item Env:\KentRehberiData__Standalone -ErrorAction SilentlyContinue
```

This change is code-only; it does **not** deploy the standalone mode to the
municipal production site.
