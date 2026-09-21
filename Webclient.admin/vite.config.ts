import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  envPrefix: ['VITE_'],
  plugins: [react()],
  build: {
    target: 'baseline-widely-available',
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: true,
  },
  server: {
    host: '0.0.0.0',
    port: 3001,
    strictPort: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 4174,
  },
});
