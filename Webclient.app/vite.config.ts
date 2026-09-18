import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import {
  legacyEnvironmentGuardPlugin,
  legacyJsxPlugin,
  legacyPresentationCleanupPlugin,
} from './tooling/sourceTransforms';

const manualChunk = (id: string): string | undefined => {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-redux/') || id.includes('/redux/')) return 'react-vendor';
  if (id.includes('/bootstrap/') || id.includes('/react-bootstrap/')) return 'ui-vendor';
  if (id.includes('/@fortawesome/') || id.includes('/react-icons/')) return 'icons-vendor';

  // Keep ArcGIS' large ESM graph lazy, but prevent any single responsibility
  // bucket from becoming a multi-megabyte transfer. These boundaries follow
  // stable SDK directories rather than individual application call sites so
  // cache identity remains deterministic across feature routes.
  if (id.includes('/@arcgis/core/')) {
    if (id.includes('/@arcgis/core/views/2d/')) return 'arcgis-views-2d';
    if (id.includes('/@arcgis/core/views/3d/')) return 'arcgis-views-3d';
    if (id.includes('/@arcgis/core/views/support/')) return 'arcgis-views-support';
    if (id.includes('/@arcgis/core/views/')) return 'arcgis-views-runtime';

    if (id.includes('/@arcgis/core/layers/support/')) return 'arcgis-layers-support';
    if (id.includes('/@arcgis/core/layers/graphics/')) return 'arcgis-layers-graphics';
    if (id.includes('/@arcgis/core/layers/vectorTiles/')) return 'arcgis-layers-vector';
    if (id.includes('/@arcgis/core/layers/')) return 'arcgis-layers-runtime';

    if (id.includes('/@arcgis/core/geometry/operators/')) return 'arcgis-geometry-operators';
    if (id.includes('/@arcgis/core/geometry/support/')) return 'arcgis-geometry-support';
    if (id.includes('/@arcgis/core/geometry/')) return 'arcgis-geometry-runtime';

    if (id.includes('/@arcgis/core/widgets/')) return 'arcgis-widgets';
    if (id.includes('/@arcgis/core/rest/')) return 'arcgis-rest';
    if (id.includes('/@arcgis/core/renderers/') || id.includes('/@arcgis/core/symbols/')) return 'arcgis-rendering';
    if (id.includes('/@arcgis/core/core/')) return 'arcgis-core-runtime';
    return 'arcgis-shared';
  }
  return undefined;
};

/**
 * Lets the client shell render without production secrets when the local API
 * is intentionally unavailable. This middleware exists only in Vite's dev
 * server; production builds and deployed API requests are unaffected.
 */
const localBootstrapPreviewPlugin = (): Plugin => ({
  name: 'kent-rehberi-local-bootstrap-preview',
  configureServer(server) {
    server.middlewares.use('/api', (request, response, next) => {
      const requestUrl = new URL((request as { url?: string }).url || '/', 'http://localhost');
      const payload = requestUrl.pathname === '/AppSettings/List'
        ? {
          isSuccess: requestUrl.searchParams.get('key') === 'GisMapConfig',
          data: { configValue: JSON.stringify({ Centerx: 32.854, Centery: 39.92, Zoom: 12 }) },
        }
        : requestUrl.pathname === '/Gis/ConfigService/List'
          ? { isSuccess: true, data: [] }
          : null;

      if (!payload) return next();
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    });
  },
});

export default defineConfig({
  base: './',
  envPrefix: ['VITE_'],
  define: {
    'process.env.PUBLIC_URL': JSON.stringify('./'),
  },
  plugins: [
    legacyEnvironmentGuardPlugin(),
    legacyPresentationCleanupPlugin(),
    legacyJsxPlugin(),
    localBootstrapPreviewPlugin(),
    react({ include: /\.[jt]sx?$/ }),
  ],
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react-redux', 'redux', 'bootstrap', 'react-bootstrap', '@arcgis/core/Map.js', '@arcgis/core/views/MapView.js', '@arcgis/core/views/SceneView.js', 'prop-types', '@fortawesome/react-fontawesome', 'crypto-js'],
  },
  build: {
    target: 'baseline-widely-available',
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: true,
    // Emit Vite's graph manifest so release verification can distinguish the
    // eagerly transferred application shell from intentionally lazy ArcGIS
    // capability chunks instead of treating every possible feature as startup.
    manifest: true,
    chunkSizeWarningLimit: 900,
    rolldownOptions: { output: { manualChunks: manualChunk } },
  },
  server: { host: '0.0.0.0', port: 3000, strictPort: false },
  preview: { host: '0.0.0.0', port: 4173 },
});
