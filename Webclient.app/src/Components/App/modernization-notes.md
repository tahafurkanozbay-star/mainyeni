# Modern application shell boundary

The primary application shell is now TypeScript-first. `CompanyLogo`, `NavigationBar`, `MapAna`, `MapComponent`, and `SidebarModern` are guarded against JavaScript regressions by `typescriptMigrationBoundary.test.ts`.

ArcGIS module loading for the primary map shell must flow through `gis-engine/arcgisModuleRuntime.ts`. Direct `esri-loader` imports are restricted to the exact migration allowlist and must only decrease over time.

The `typecheck:modern-shell` command provides an explicit `allowJs: false` strict TypeScript gate for newly migrated shell modules in addition to the repository-wide typecheck.
