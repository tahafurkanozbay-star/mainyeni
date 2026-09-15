# GIS Engine

Shared runtime modules for service governance, layer state, spatial analysis, icon presentation and 2D/3D view synchronization.

The engine is deliberately ArcGIS Maps SDK oriented because the application already uses `esri-loader` and server-owned GIS configuration. WMS/WFS are not supported in this runtime. Service URLs should resolve through the existing server-side proxy configuration rather than introducing new client-side endpoints.
