import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {
  legacyEnvironmentGuardPlugin,
  legacyJsxPlugin,
} from './tooling/sourceTransforms';

const manualChunk = (id: string): string | undefined => {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-redux/') || id.includes('/redux/')) return 'react-vendor';
  if (id.includes('/bootstrap/') || id.includes('/react-bootstrap/')) return 'ui-vendor';
  if (id.includes('/@fortawesome/') || id.includes('/react-icons/')) return 'icons-vendor';
  if (id.includes('/esri-loader/')) return 'arcgis-loader';
  return undefined;
};

export default defineConfig({
  base: './',
  envPrefix: ['VITE_'],
  define: {
    // Narrow bridge for the one remaining public-asset call site. Do not expose
    // a generic process.env object to browser code.
    'process.env.PUBLIC_URL': JSON.stringify('./'),
  },
  plugins: [legacyEnvironmentGuardPlugin(), legacyJsxPlugin(), react({ include: /\.[jt]sx?$/ })],
  optimizeDeps: {
    // Keep core boot dependencies explicit for predictable warm startup while
    // allowing Vite 8 to discover the remaining legacy/CJS graph automatically.
    include: ['react', 'react-dom', 'react-dom/client', 'react-redux', 'redux', 'bootstrap', 'react-bootstrap', 'esri-loader'],
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
