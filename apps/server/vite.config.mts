import { defineConfig } from "vite";

/** Bundles the two server processes, the seed, moderator, event and admin commands (and the workspace packages they use) into CommonJS files for Node. */
export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  build: {
    ssr: true,
    outDir: "dist",
    target: "node22",
    rollupOptions: {
      input: { api: "src/main.api.ts", worker: "src/main.worker.ts", seed: "src/main.seed.ts", mod: "src/main.mod.ts", event: "src/main.event.ts", admin: "src/main.admin.ts" },
      output: { format: "cjs", entryFileNames: "[name].cjs" },
    },
  },
  ssr: { noExternal: [/^@kots\//] },
});
