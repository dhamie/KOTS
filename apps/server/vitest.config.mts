import { defineConfig } from "vitest/config";

// These tests need Postgres (npm run db:up). They use the separate kots_test database.
export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    // Booting Nest and rebuilding the schema can exceed the 10 s default on a loaded machine.
    hookTimeout: 60_000,
    // Reuse transformed modules between runs; the cold transform is a large share of the run time here.
    fsModuleCache: true,
  },
});
