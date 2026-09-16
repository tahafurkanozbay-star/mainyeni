import { defineConfig, loadEnv, transformWithOxc, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const legacyJsxPlugin = (): Plugin => ({
  name: 'kent-rehberi-legacy-jsx',
  enforce: 'pre',
  async transform(code, id) {
    if (!id.includes('/src/') || !id.endsWith('.js')) return null;
    const result = await transformWithOxc(code, id, {
      lang: 'jsx',
      jsx: {
        runtime: 'automatic',
      },
    });
    return result.map
      ? { code: result.code, map: result.map }
      : { code: result.code };
  },
});

const manualChunk = (id: string): string | undefined => {
  if (!id.includes('node_modules')) return undefined;
  if (
    id.includes('/react/') ||
    id.includes('/react-dom/') ||
    id.includes('/react-redux/') ||
    id.includes('/@reduxjs/toolkit/') ||
    id.includes('/redux/')
  ) return 'react-vendor';
  if (id.includes('/bootstrap/') || id.includes('/react-bootstrap/')) return 'ui-vendor';
  if (id.includes('/@fortawesome/') || id.includes('/react-icons/')) return 'icons-vendor';
  if (id.includes('/esri-loader/')) return 'arcgis-loader';
  return undefined;
};

const safeLegacyEnvironmentDefinitions = (mode: string): Record<string, string> => {
  const env = loadEnv(mode, '.', '');
  const mappings = [
    ['VITE_APP_ENV', 'REACT_APP_ENV'],
    ['VITE_APP_VERSION', 'REACT_APP_VERSION'],
    ['VITE_APP_RELEASE', 'REACT_APP_RELEASE'],
    ['VITE_ESRI_API_VERSION', 'REACT_APP_ESRI_API_VERSION'],
    ['VITE_API_URL', 'REACT_APP_API_URL'],
    ['VITE_API_BASE_URL', 'REACT_APP_API_BASE_URL'],
    ['VITE_API_TIMEOUT_MS', 'REACT_APP_API_TIMEOUT_MS'],
    ['VITE_API_CACHE_TTL_MS', 'REACT_APP_API_CACHE_TTL_MS'],
    ['VITE_API_MAX_RETRIES', 'REACT_APP_API_MAX_RETRIES'],
    ['VITE_TKGM_CITY_ID', 'REACT_APP_TKGM_CITY_ID'],
  ] as const;

  const definitions: Record<string, string> = {};
  for (const [modernName, legacyName] of mappings) {
    if (env[modernName] || !env[legacyName]) continue;
    definitions[`import.meta.env.${modernName}`] = JSON.stringify(env[legacyName]);
  }
  return definitions;
};

export default defineConfig(({ mode }) => ({
  base: './',
  define: safeLegacyEnvironmentDefinitions(mode),
  plugins: [
    legacyJsxPlugin(),
    react({ include: /\.[jt]sx?$/ }),
  ],
  build: {
    target: 'es2022',
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: manualChunk,
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
}));
