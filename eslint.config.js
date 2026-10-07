import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  },
  {
    files: ["**/*.{js,mjs,ts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["packages/core/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@azure/*",
                "@azure/**",
                "langchain",
                "langchain/**",
                "@langchain/*",
                "@langchain/**",
              ],
              message:
                "packages/core cannot import Azure SDKs or LangChain. Depend on a port instead.",
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
