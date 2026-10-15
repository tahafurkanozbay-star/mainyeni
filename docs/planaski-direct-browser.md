# Browser-direct PlanASKI Kent Rehberi data (opt-in)

The Kent Rehberi React client can read the official
`https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=N`
endpoint **directly from the browser** in its data, search, detail and type
catalog workflows. The official endpoint returns plain JSON arrays; the
frontend validates and converts those records to EPSG:4326 GeoJSON, which is
still what ArcGIS expects.

## Activate in local development

The source option is supplied at **Vite startup**, not inside the .NET API:

```powershell
cd Webclient.app
$env:VITE_KENT_REHBERI_SOURCE = "planaski"
npm run dev
```

An existing `Webclient.app/.env` is **not overwritten** by the setup script.
For a persistent local setup, add this to the ignored `.env`:

```dotenv
VITE_KENT_REHBERI_SOURCE=planaski
```

In a new local setup, `.env.example` contains that option. Restart Vite
after changing source mode; a refresh alone is insufficient.

Open browser Developer Tools → Network and filter by `kentrehberi?tur=`.
The network URL should now be the **PlanASKI host**, not `/api/kent-rehberi`.
The direct source does not require the standalone .NET host for these
four Kent Rehberi data operations; other app endpoints (e.g. AppSettings
and unrelated admin/EGO services) may still require a backend. In
development the existing map/bootstrap preview may provide map shell
defaults if old database-backed AppSettings are unavailable.

## Safe transport and limitations

- Only the fixed official HTTPS host/path is used; category IDs are limited
  to integers 0..42. No arbitrary URL override or credential forwarding.
- `GET` with `credentials: omit`, `cache: no-store`, and `redirect: error`
  is used. Direct mode does not cache PlanASKI JSON in this transport.
- Every category payload must be a bounded JSON array (20,000 rows /
  8 MiB per category); requests for all types use at most four concurrent
  fetches. Browser requests remain abortable and have a bounded deadline.
- Names and addresses may have CR/LF/CRLF normalized to spaces. All other
  control characters, invalid IDs, duplicate IDs, nonnumeric/invalid
  coordinates and unexpected data shapes remain rejected. No records are
  silently discarded when malformed.
- Existing UI collection limits still apply (500 default, 2,000 maximum,
  with `meta.hasMore` indicating truncation).
- Unfiltered search and type-catalog discovery require all 43 upstream
  types. As requested, no proxy-level performance caching is used; latency
  and official-service request volumes can be higher than the .NET proxy.
- The browser origin **must be permitted by PlanASKI's CORS configuration**.
  It was confirmed for `http://localhost:3000` when the user directly
  fetched `tur=13` (HTTP 200, six records). This does *not* establish that
  the same CORS headers will work on the production municipal domain.

For existing same-origin .NET API behavior, set:

```dotenv
VITE_KENT_REHBERI_SOURCE=api
```

Omitting the setting also preserves the original API mode (the explicit
local template is the opt-in). This branch contains only client and
documentation changes. It does not alter production IIS or PostgreSQL.

## Verification

The direct-source test suite uses mocked responses for category parsing,
control-character normalization, invalid records, full catalog/search,
feature lookup, and same-origin fallback. CI tests alone cannot prove
the cross-origin HTTP behavior of every deployment; use DevTools to
check the actual production-origin CORS policy before switching production.
