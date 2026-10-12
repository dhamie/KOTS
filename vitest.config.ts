import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests that need Postgres (apps/server) run separately: npm run test:db.
    include: ["packages/*/test/**/*.test.ts", "apps/client/test/**/*.test.ts"],
  },
});
