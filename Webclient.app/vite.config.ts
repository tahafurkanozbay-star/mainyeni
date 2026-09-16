import { defineConfig, transformWithOxc, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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
  plugins: [legacyJsxPlugin(), react({ include: /\.[jt]sx?$/ })],
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
