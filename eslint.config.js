import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // local-demo/ is an optional local playground (a compose file and a
    // static site) excluded from git via .git/info/exclude. eslint doesn't
    // read git's ignore files, so it is listed here; otherwise lint would
    // fail on machines that have it.
    ignores: ["**/dist/**", "**/node_modules/**", "local-demo/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // The cockpit's scripts run in a browser, not in Node.
  //
  // The browser globals are listed by hand instead of using the `globals`
  // package, to avoid a dependency for one line (see docs/decisions.md).
  // The list also shows which browser features the cockpit uses; using a
  // new one causes a lint error until it is added.
  {
    files: ["apps/cockpit/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        location: "readonly",
        fetch: "readonly",
        Node: "readonly",
        ResizeObserver: "readonly",
        TextEncoder: "readonly",
      },
    },
  },
  // The scripts in scripts/ are plain Node modules outside the
  // workspaces, so Node's globals are listed for them, like the browser
  // ones above.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
      },
    },
  },
  eslintConfigPrettier,
);
