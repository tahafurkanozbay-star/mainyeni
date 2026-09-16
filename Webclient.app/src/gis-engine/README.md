# GIS Engine

The GIS engine is the typed runtime boundary for Kent Rehberi. New engine code is written in TypeScript and compiled through the repository quality gate; React screens may still be JavaScript while migration proceeds, but they consume these typed contracts through extensionless imports.

## Runtime contracts

`contracts.ts` defines the shared domain language for services, layers, geometries, view state, icons and cancellation. Runtime modules should prefer these contracts over ad-hoc object shapes. The goal is progressive typing without forking behavior or creating parallel configuration systems.

## Service and network policy

The engine is ArcGIS Maps SDK oriented because the application already uses `esri-loader` and server-owned GIS configuration. WMS/WFS/WMTS/OGC variants are deliberately rejected. Service URLs should resolve through the existing same-origin/server proxy policy rather than introducing new client-owned endpoints.

`serviceCatalog.ts` is responsible for normalization and policy validation. `serviceRegistry.ts` owns timeout, retry, cancellation and health semantics. `layerFactory.ts` translates approved catalog records into SDK layers.

## Icon authority

`iconRegistry.json` remains the only record/category-to-icon configuration authority. `iconResolver.ts` and `iconPresentation.ts` are the shared deterministic resolver/presentation path used by list/table, 2D marker, popup and 3D surfaces. Do not add a second icon map in a component.

## Spatial and view state

`spatialEngine.ts` owns typed geometry operations and feature queries. `viewState.ts` owns serializable 2D/3D state and shareable URL state. Temporary query results and operational layers must use scoped ownership/cleanup helpers instead of global map clears.

## Migration rule

Keep `main` as the canonical integration source. Long-lived or diverged branches must not receive new modernization work; start from current `main`, reapply validated behavior, and let CI verify typecheck, tests, build and bundle budgets before merge.
