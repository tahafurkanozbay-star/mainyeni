import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { moduleResolutionGuardPlugin } from './tooling/moduleResolutionGuard';
import {
  legacyEnvironmentGuardPlugin,
  legacyJsxPlugin,
  legacyPresentationCleanupPlugin,
} from './tooling/sourceTransforms';

const arcgisLeafChunk = (id: string, prefix: string, chunkPrefix: string): string | undefined => {
  const marker = `/@arcgis/core/${prefix}/`;
  const markerIndex = id.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const relative = id.slice(markerIndex + marker.length);
  const [firstSegment] = relative.split('/');
  if (!firstSegment) return chunkPrefix;
  const stableSegment = firstSegment.replace(/\.js$/u, '').replace(/[^a-zA-Z0-9_-]/gu, '-').toLowerCase();
  return `${chunkPrefix}-${stableSegment}`;
};

const manualChunk = (id: string): string | undefined => {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-redux/') || id.includes('/redux/')) return 'react-vendor';
  if (id.includes('/bootstrap/') || id.includes('/react-bootstrap/')) return 'ui-vendor';
  if (id.includes('/@fortawesome/') || id.includes('/react-icons/')) return 'icons-vendor';

  // ArcGIS is capability-loaded. Keep cache identities deterministic while
  // splitting the two SDK responsibility buckets that exceed the release
  // transfer ceiling. Leaf boundaries are derived from stable SDK paths, not
  // application call sites, so a feature route does not perturb chunk names.
  if (id.includes('/@arcgis/core/')) {
    if (id.includes('/@arcgis/core/views/2d/')) return arcgisLeafChunk(id, 'views/2d', 'arcgis-views-2d');
    if (id.includes('/@arcgis/core/views/3d/')) return arcgisLeafChunk(id, 'views/3d', 'arcgis-views-3d');
    if (id.includes('/@arcgis/core/views/support/')) return 'arcgis-views-support';
    if (id.includes('/@arcgis/core/views/')) return arcgisLeafChunk(id, 'views', 'arcgis-views');

    if (id.includes('/@arcgis/core/layers/support/')) return 'arcgis-layers-support';
    if (id.includes('/@arcgis/core/layers/graphics/')) return 'arcgis-layers-graphics';
    if (id.includes('/@arcgis/core/layers/vectorTiles/')) return 'arcgis-layers-vector';
    if (id.includes('/@arcgis/core/layers/')) return arcgisLeafChunk(id, 'layers', 'arcgis-layers');

    if (id.includes('/@arcgis/core/geometry/operators/')) return 'arcgis-geometry-operators';
    if (id.includes('/@arcgis/core/geometry/support/')) return 'arcgis-geometry-support';
    if (id.includes('/@arcgis/core/geometry/')) return arcgisLeafChunk(id, 'geometry', 'arcgis-geometry');

    if (id.includes('/@arcgis/core/widgets/')) return arcgisLeafChunk(id, 'widgets', 'arcgis-widgets');
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
      const requestUrl = new URL((request as { url?: string }).url || '/', 'https://vite.local');
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
    moduleResolutionGuardPlugin(),
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
    manifest: true,
    chunkSizeWarningLimit: 900,
    rolldownOptions: { output: { manualChunks: manualChunk } },
  },
  server: { host: '0.0.0.0', port: 3000, strictPort: false },
  preview: { host: '0.0.0.0', port: 4173 },
});
