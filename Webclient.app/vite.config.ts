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
  if (id.includes('/esri-loader/')) return 'arcgis-loader';
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
      const requestUrl = new URL(request.url || '/', 'http://localhost');
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
    // Keep core boot dependencies explicit for predictable warm startup while
    // allowing Vite 8 to pre-bundle the remaining legacy/CJS graph explicitly.
    // Dependency discovery parses source before the legacy JSX bridge runs, so
    // scanning historical .js files that contain JSX would otherwise fail.
    noDiscovery: true,
    include: ['react', 'react-dom', 'react-dom/client', 'react-redux', 'redux', 'bootstrap', 'react-bootstrap', 'esri-loader', 'prop-types', '@fortawesome/react-fontawesome', 'crypto-js'],
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
