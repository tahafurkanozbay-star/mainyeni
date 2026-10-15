# Codebase audit — 2026-10-15

## Method and scope

The checked baseline was `main` at
`e788ea57a86cba4364384c4945105b44acca3d0e` (after PR #508).
The Git tree contains approximately **3,115 tracked blobs**, including about
1,450 Webclient.app TypeScript files and 175 TSX files, 371 KentRehberi
TypeScript files, and C# backend, admin, tooling and test projects.

A truthful audit of every statement in several thousand files is **not**
feasible in one review. This is a **risk-based** analysis of live request
paths, recent change interfaces, CI, startup isolation, credentials/configuration
file metadata, map layer loading, browser transport limits, and operational
dependencies. It is not a full security certification or a production
penetration test.

### Verified within this review

- Checked the current branch SHA, root Git tree inventory, open PRs/issues,
  and recent `main` GitHub Actions outcomes.
- Examined the official PlanASKI browser-direct adapter, same-origin GeoJSON
  adapter, data filters/fast-access runtime, ArcGIS map startup, shared
  results window, and relevant Vitest regressions.
- Examined the standalone PlanASKI .NET hosting boundary and data source
  exception/validation handling, as well as local Vite proxy configuration.
- Examined tracked environment/configuration **filenames and setting names**;
  no credential values were copied into this review.
- Six existing draft pull requests (#496, #492, #488, #487, #485 and #266)
  remain untouched. They contain other changes and should be evaluated
  independently before integration.

## Confirmed finding and correction

**Finding BR-01 — response size budget enforced too late (fixed).**
Both `kentRehberiPlanAskiDirect.ts` and
`kentRehberiGeoJsonLayer.ts` previously awaited `Response.text()` and
**only then** compared the size of the entire result with the configured
budget. A defective/malicious upstream could send a very large body without
a useful `Content-Length` header. That would allocate and buffer data
in the browser *before* any resource limit took effect, despite the
nominal 8-MiB-per-category policy.

**Correction:** a shared, streaming, UTF-8 decoder counts received bytes and
rejects **before** reading the remainder. It cancels rejected streams, decodes
split multibyte characters correctly, and preserves the existing response
content-type/JSON/schema checks and all existing upper limits. No data is
silently dropped. Both the official cross-origin path and same-origin
BFF path now use the bounded reader.

Regression tests cover oversized streams lacking `Content-Length`, precise
byte limits, split Turkish UTF-8, invalid UTF-8 and missing bodies, plus
direct PlanASKI and same-origin adapter integration.

## Boundaries intentionally not changed

- PlanASKI uses its canonical pinned HTTPS endpoint with
  `tur=0..42`. No new destination override, token, credential or fallback
  to a less-restricted external host was introduced.
- The all-city orange marker overlay remains hidden by default after
  PR #508; selected category results still own their separate layers.
- Source mode and map preview are opt-in development/runtime configuration
  decisions, not an IIS deployment action.
- The default full backend still requires its application DB. Standalone
  PlanASKI mode is isolated and intentionally does not expose AppSettings
  or admin endpoints.
- The repository's older commit history is known to have contained
  database credentials. **Credential rotation/revocation and any Git history
  rewriting require a coordinated administrator-led response**, not an
  automatic force push in a code-cleanup PR. No sensitive value is reproduced
  here.

## Remaining review/rollout risks

1. **Production CORS**: direct PlanASKI fetch was demonstrated by the user
   at `localhost:3000`; it is not yet proof that the deployed municipal
   origin is allowed. Test that exact origin before production activation.
2. **All-type availability**: direct search and catalog intentionally
   read 43 upstream categories. One invalid/unavailable category can
   still fail an aggregate request. Separate outage-tolerant partial
   result semantics would require explicit UX/data-integrity decisions;
   this change does not silently hide missing results.
3. **Release test semantics**: Webclient CI includes both strict
   targeted tests and baseline-comparison gates. A green check is a
   strong regression signal, but it does not by itself prove every
   legacy test was newly passing. Review diagnostic test outputs when
   doing a formal release.
4. **Tracked legacy files**: `Webclient.admin/.env` and
   `Webclient.app/build.rar` are present in the tracked tree. The
   admin .env showed configuration **key names only** during this
   review, not an identified active secret. Their retirement should
   be planned against legacy build/runtime compatibility, not
   deleted speculatively.
5. **Production deployment/DB**: no live IIS changes, PostgreSQL
   migrations or secrets rotations were made. Runtime browser testing
   and production rollout approval remain separate work.

## Quality gate

Require all checks on this PR to be green: browser-quality Vitest,
TypeScript, lint, build budget/integrity, backend Release, dependency
and architecture governance. Merge to `main` only when the PR head
is unchanged and no conflicts exist.
