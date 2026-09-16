import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    reportCompressedSize: true
  },
  server: {
    host: '0.0.0.0',
    strictPort: true
  },
  preview: {
    host: '0.0.0.0',
    strictPort: true
  }
});
