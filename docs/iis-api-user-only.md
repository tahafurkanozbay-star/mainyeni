
# IIS deployment — Webclient.app User API only

## Scope

This deployment target is **only Api.User**, the backend used by the public Webclient.app. It does not publish Webclient.app, Webclient.admin, or Api.Admin. Project references to Api.Core, Business, and Toolbox are included automatically by dotnet publish.

The publishing script is deliberately separate from Operations/build.ps1 -Target User, because that existing target also builds the frontend. It only compiles and packages the API; it does not connect to IIS or change production services.

## Build a deployable package

Requirements: Windows or PowerShell-compatible build host, .NET SDK pinned by global.json (10.0.401), and network access to restore NuGet packages.

From the repository root, run the following command:

    .\Operations\publish-webclient-api-iis.ps1

Output:
- **artifacts/iis-api-user/publish/** — expanded publish directory.
- **artifacts/iis-api-user/api-user-iis.zip** — package to transfer to the IIS host.

The script checks the required User API assembly, generated IIS web.config, and appsettings.json; it also fails if the Admin API assembly appears in the output. Output cleanup is constrained to a child of this repository's ignored artifacts/ directory.

## Select the right runtime mode

For the **full Webclient.app backend**, use the normal Api.User mode.

- Do **not** set KentRehberiData__Standalone=true for the full-client deployment. That opt-in mode intentionally exposes only the anonymous Kent Rehberi data controller and health endpoints; it omits AppSettings, public GIS configuration, EGO, TKGM, feedback, and other legacy User API routes that parts of the full frontend may call.
- Api.User/appsettings.json selects the PlanASKI source for Kent Rehberi data. The API contacts the fixed official HTTPS upstream server-side; no PostgreSQL connection is needed specifically for that PlanASKI data source.
- Normal mode still uses the application database for endpoints such as /AppSettings/List?key=GisMapConfig and /Gis/ConfigService/List. Supply a valid ConnectionStrings__Primary value through secure IIS/server configuration before production traffic is enabled. Do not put a real connection string or password into Git, this script, or a tracked JSON file.
- If only the map-data routes are required in a future deliberately reduced deployment, standalone mode can be reconsidered separately; it is not a drop-in backend for all current frontend features.

## IIS host preparation

1. Install the IIS Web Server role.
2. Install the current .NET 10 Hosting Bundle **after IIS is installed**. It provides the ASP.NET Core Module and runtime needed by framework-dependent deployments. Restart IIS services if the installer requires it. See [Microsoft's .NET 10 IIS publishing guide](https://learn.microsoft.com/en-us/aspnet/core/tutorials/publish-to-iis?view=aspnetcore-10.0) and [Hosting Bundle guide](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/hosting-bundle?view=aspnetcore-10.0).
3. Extract the ZIP contents (the contents, not a nested extra ZIP directory) to a dedicated physical directory such as C:\inetpub\KentRehberiApi\.
4. Create a dedicated IIS application pool for the site, with **.NET CLR Version = No Managed Code** and 64-bit enabled. Give the pool identity read/execute access to the published files and only the permissions it actually needs for required resources.
5. Create an IIS website pointing at that directory. A public hostname and certificate are not required to build the package; arrange an internal/test binding for validation, then add the eventual DNS host binding and HTTPS certificate when the subdomain is supplied.
6. Keep the generated web.config from the publish output. Do not replace it with a static-file SPA web.config.
7. Set ASPNETCORE_ENVIRONMENT=Production and ConnectionStrings__Primary securely in server/IIS application-pool environment configuration. Recycle the application pool after changing environment variables. Do not log or paste secrets into deployment logs.
8. Keep Swagger__Enabled=false in production unless there is a separately reviewed operational reason to expose Swagger.

The API process also needs outbound HTTPS access to planaski.ankara.bel.tr for Kent Rehberi data. The readiness check may fail when that upstream or the configured application database is unavailable.

## Smoke tests

After the IIS site has a usable test binding, check these paths:

    GET /health/live
    GET /health/ready
    GET /kent-rehberi?tur=0&limit=10

- /health/live checks whether the process is live.
- /health/ready checks the configured dependencies and may return 503 when one is unhealthy.
- The User API route is /kent-rehberi, not /api/kent-rehberi by itself.

Do not send public production traffic until the health probes, database access and real upstream request have been checked from the server.

## How the later frontend will reach this API

The current Webclient.app runtime configuration intentionally accepts **same-origin relative API paths only**; an absolute URL on a different API subdomain falls back to /api. Keep that security boundary unchanged for now.

When the frontend subdomain is known, the preferred low-change setup is:

    Browser
      -> https://<frontend-subdomain>/api/*
      -> frontend IIS reverse-proxy rule (strip /api)
      -> https://<api-subdomain>/*
      -> Api.User

This preserves the current /api browser contract and normally avoids cross-origin browser requests. It requires IIS URL Rewrite and Application Request Routing to be configured on the frontend site when that site is published. Do not add wildcard CORS origins now. If direct browser-to-API-subdomain access is later chosen instead, the frontend runtime policy and API CORS allowlist must be deliberately reviewed together and tested against the exact frontend origin.

## What this does not do

It does not deploy to a live IIS server, create DNS records, issue TLS certificates, choose a database connection string, open CORS, or change the frontend. Those steps require the target host, secure database configuration and (for bindings/proxy rules) the actual subdomain details.
