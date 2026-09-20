import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [
    react({
      include: /\.[jt]sx?$/u,
    }),
  ],
  envPrefix: ["VITE_", "REACT_APP_"],
  esbuild: {
    loader: "jsx",
    include: /src\/.*\.js$/u,
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        ".js": "jsx",
      },
    },
  },
  build: {
    outDir: "build",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    cssCodeSplit: true,
    reportCompressedSize: true,
  },
  server: {
    host: "0.0.0.0",
  },
  preview: {
    host: "0.0.0.0",
  },
});
