import { createNodeResolver, importX } from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/", "**/node_modules/", "**/drizzle/"] },
  tseslint.configs.recommended,
  {
    plugins: { "import-x": importX },
    settings: {
      // Let the import rules follow and parse TypeScript files, not just .js.
      "import-x/extensions": [".ts", ".tsx", ".mts", ".js", ".mjs"],
      "import-x/parsers": { "@typescript-eslint/parser": [".ts", ".tsx", ".mts"] },
      "import-x/resolver-next": [createNodeResolver({ extensions: [".ts", ".tsx", ".js", ".mjs", ".mts"] })],
    },
    rules: {
      // Module boundaries: no circular imports anywhere.
      "import-x/no-cycle": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Tests read loosely-typed JSON responses.
    files: ["**/test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // packages/rules must stay pure and deterministic (see CLAUDE.md).
    files: ["packages/rules/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["@nestjs/*", "drizzle-orm*", "pg", "pg-boss", "phaser", "react*", "node:*"] },
      ],
      "no-restricted-globals": ["error", "Date", "window", "document", "process"],
      "no-restricted-properties": ["error", { object: "Math", property: "random", message: "Use the seeded RNG." }],
    },
  },
);
