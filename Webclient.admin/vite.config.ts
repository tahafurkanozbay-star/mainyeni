import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import {
  legacyEnvironmentGuardPlugin,
  legacyJavascriptJsxPlugin,
} from './tooling/sourceTransforms.ts';

export default defineConfig({
  base: './',
  plugins: [
    legacyEnvironmentGuardPlugin(),
    legacyJavascriptJsxPlugin(),
    react({ include: /\.[jt]sx?$/u }),
  ],
  build: {
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    manifest: true,
    target: 'es2022',
    cssCodeSplit: true,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react-vendor';
          if (id.includes('/react-router') || id.includes('/history/')) return 'router-vendor';
          if (id.includes('/bootstrap/') || id.includes('/react-bootstrap/')) return 'ui-vendor';
          if (id.includes('/jspdf') || id.includes('/xlsx/') || id.includes('/file-saver/')) {
            return 'export-vendor';
          }
          if (id.includes('/react-icons/')) return 'icons-vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3001,
    strictPort: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 4301,
  },
});
