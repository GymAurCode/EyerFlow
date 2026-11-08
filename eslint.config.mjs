import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "out/**",
      "release/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".tmp/**",
      "print-preview-out/**",
      // Developer diagnostics written as plain JavaScript. They sit outside the
      // type graph and are not part of the application.
      "tools/print-preview/**/*.js",
      "*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Two files stand outside every tsconfig on purpose: the theme
        // bootstrap is a plain script loaded before the bundle exists, and the
        // visual review is a standalone developer tool. Everything else is
        // resolved through the project references in `tsconfig.json`.
        projectService: {
          allowDefaultProject: ["src/renderer/public/theme-boot.js", "visual-review.mts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // No `any` anywhere. Use `unknown` + narrowing instead.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // The visual review is a standalone developer tool: it drives a browser
    // page and prints what it measures, so it is allowed to talk to the
    // console and to the DOM.
    files: ["visual-review.mts"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    // The theme bootstrap runs in the page before the bundle is loaded, so it
    // is a browser script even though it lives with the renderer.
    files: ["src/renderer/public/theme-boot.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Build configuration and maintenance scripts are plain JS outside the
    // app's type graph, so the type-aware rules have nothing to check and
    // produce false positives on plugin option objects. PostCSS config is the
    // same: it is consumed by Vite, never by TypeScript.
    files: [
      "*.config.ts",
      "*.config.mjs",
      "*.config.js",
      "eslint.config.mjs",
      "postcss.config.js",
      "scripts/**/*.js",
      "tools/**/*.ts",
    ],
    // Spread first, rules last: in a flat config object a later `rules` key
    // replaces an earlier one wholesale. disableTypeChecked carries its own
    // `rules`, so these additions must follow it or they are discarded.
    ...tseslint.configs.disableTypeChecked,
    rules: {
      // These are Node CLI tools run from a terminal, where printing to stdout
      // is the entire point of the script. `tools/keygen` issues and checks
      // licence keys and has nothing to show the operator otherwise.
      ...tseslint.configs.disableTypeChecked.rules,
      "no-console": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Tests that drive renderer code. They cannot join the Node project (no
    // DOM lib, so `window` is unresolved) and adding them to the web project
    // pulls the two dead editor pages - which have pre-existing broken imports
    // and are not routed - into type-aware linting. Type information buys
    // nothing here: the tests assert on timers and rejection values.
    files: ["tests/renderer-*.test.ts"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },
  {
    files: ["e2e/**/*.ts"],
    languageOptions: {
      // E2E specs are their own TS project (`tsconfig.e2e.json`, referenced
      // from `tsconfig.json`) because their `page.evaluate` callbacks run in
      // the renderer and need the DOM lib, which the Node-side app config
      // deliberately does not expose.
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Playwright fixtures are called through destructured helpers and the
      // specs assert on Playwright's loosely-typed locator results.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // The renderer receives a narrow structural slice of `window.api` rather
    // than the whole object: `api.invoke` is generic and destructuring it
    // would lose the method/type pairing that keeps call sites type-checked.
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // The SQLite driver is CommonJS and has no type declarations we can import
    // from, so it is loaded through `require` on purpose. The result is cast to
    // a narrow constructor type at a single call site.
    files: ["src/data/connection.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
