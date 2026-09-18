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

  // @arcgis/core is intentionally split by stable SDK responsibility rather
  // than collapsed into one vendor chunk. The 5.x ESM graph is substantially
  // larger than the retired loader shim; keeping views, layers, widgets,
  // geometry and REST clients separate preserves lazy loading and prevents a
  // single GIS chunk from monopolising the production gzip budget.
  if (id.includes('/@arcgis/core/')) {
    if (id.includes('/@arcgis/core/views/')) return 'arcgis-views';
    if (id.includes('/@arcgis/core/widgets/')) return 'arcgis-widgets';
    if (id.includes('/@arcgis/core/layers/')) return 'arcgis-layers';
    if (id.includes('/@arcgis/core/geometry/')) return 'arcgis-geometry';
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
    // Narrow bridge for the one remaining public-asset call site. Do not expose
    // a generic process.env object to browser code.
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
    // Keep dependency discovery enabled during the remaining legacy/CJS migration.
    // Warm the bundled ArcGIS ESM package rather than the removed esri-loader.
    // Vite remains free to discover imports not listed here.
    include: ['react', 'react-dom', 'react-dom/client', 'react-redux', 'redux', 'bootstrap', 'react-bootstrap', '@arcgis/core/Map.js', '@arcgis/core/views/MapView.js', '@arcgis/core/views/SceneView.js', 'prop-types', '@fortawesome/react-fontawesome', 'crypto-js'],
  },
  build: {
    // Vite 8's Baseline target tracks browsers that are widely interoperable
    // instead of forcing a newer ES syntax level than the product requires.
    target: 'baseline-widely-available',
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 900,
    rolldownOptions: { output: { manualChunks: manualChunk } },
  },
  server: { host: '0.0.0.0', port: 3000, strictPort: false },
  preview: { host: '0.0.0.0', port: 4173 },
});
