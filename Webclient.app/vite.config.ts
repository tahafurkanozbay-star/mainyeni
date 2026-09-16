import { defineConfig, transformWithOxc, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const SOURCE_FILE = /\/src\/.*\.[cm]?[jt]sx?$/;
const LEGACY_PUBLIC_URL_REFERENCE = 'process.env.PUBLIC_URL';

const legacyJsxPlugin = (): Plugin => ({
  name: 'kent-rehberi-legacy-jsx',
  enforce: 'pre',
  async transform(code, id) {
    if (!id.includes('/src/') || !id.endsWith('.js')) return null;
    const result = await transformWithOxc(code, id, {
      lang: 'jsx',
      jsx: { runtime: 'automatic' },
    });
    return result.map ? { code: result.code, map: result.map } : { code: result.code };
  },
});

const legacyEnvironmentGuardPlugin = (): Plugin => ({
  name: 'kent-rehberi-legacy-environment-guard',
  enforce: 'pre',
  transform(code, id) {
    if (!SOURCE_FILE.test(id) || !code.includes('process.env')) return null;
    const references = code.match(/process\.env\.[A-Z0-9_]+/g) ?? [];
    const disallowed = [...new Set(references.filter((reference) => reference !== LEGACY_PUBLIC_URL_REFERENCE))];
    if (disallowed.length > 0) {
      throw new Error(
        `Legacy browser environment access is forbidden in ${id}: ${disallowed.join(', ')}. `
        + 'Use the typed runtimeConfig/import.meta.env boundary instead.',
      );
    }
    return null;
  },
});

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
    noDiscovery: true,
    include: ['react', 'react-dom', 'react-dom/client', 'react-redux', 'redux', 'bootstrap', 'react-bootstrap', 'esri-loader'],
  },
  build: {
    target: 'es2022',
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
