import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.mjs";

export default mergeConfig(base, defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["tests/unit/**", "tests/contracts/**"],
    hookTimeout: 180_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
}));
