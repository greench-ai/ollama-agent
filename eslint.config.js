import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "release/**",
      "node_modules/**",
      "web/prism.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        // Type-aware linting is what catches the bugs that matter here:
        // unawaited promises and dead conditions across module boundaries.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The single highest-value rule for a codebase full of async tool calls.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Unused args are often intentional in interfaces and test doublers.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
  {
    files: ["web/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        Node: "readonly",
        requestAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        EventSource: "readonly",
        Prism: "readonly",
        globalThis: "readonly",
        localStorage: "readonly",
        FileReader: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        confirm: "readonly",
        DOMParser: "readonly",
        AbortController: "readonly",
        TextDecoder: "readonly",
        Blob: "readonly",
        File: "readonly",
        Image: "readonly",
        location: "readonly",
        history: "readonly",
        performance: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      // node:test registers async cases by returning a promise it owns; these
      // are collected by the runner, not dropped.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    files: ["test/fixtures/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    files: ["web/highlight-src.js"],
    rules: { "no-redeclare": "off" },
  },
  {
    files: ["web/markdown.js"],
    // \u0000 fences are a deliberate placeholder marker in the renderer.
    rules: { "no-control-regex": "off" },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
);
