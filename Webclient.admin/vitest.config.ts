import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/setupTests.ts"],
      restoreMocks: true,
      clearMocks: true,
      mockReset: true,
      testTimeout: 10_000,
      hookTimeout: 10_000,
      coverage: {
        reporter: ["text", "json-summary"],
      },
    },
  }),
);
