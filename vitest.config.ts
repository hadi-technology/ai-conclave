import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Engine spawns (init, run start, watch) take ~1s each — give room.
    testTimeout: 60000,
    hookTimeout: 60000
  }
});
