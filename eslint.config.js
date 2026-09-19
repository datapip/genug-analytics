import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // local-demo/ is a throwaway playground (a compose file and a static
    // site, for trying the stack out by hand) kept out of the repo via
    // .git/info/exclude, so most clones won't have it at all. It's
    // listed anyway because eslint walks the filesystem and reads no
    // ignore file of git's — without this, a machine that does have the
    // folder fails the lint run on it.
    ignores: ["**/dist/**", "**/node_modules/**", "local-demo/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // The cockpit's scripts run in a browser, not Node. Splitting them out
  // of index.html into real .js files is what brought them under eslint
  // at all — while they were inline in the HTML nothing checked them.
  //
  // The browser globals are listed by hand rather than pulling in the
  // `globals` package: it's one dependency for one config line, which
  // doesn't pass the "prefer a small amount of plain code over a
  // dependency" test in docs/decisions.md. Listing only what's actually used
  // also documents how small the cockpit's browser surface really is —
  // and anything new shows up as a lint error rather than slipping in.
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
      },
    },
  },
  // The two measurement scripts in scripts/ are plain Node ES modules,
  // not part of a workspace, so they need Node's globals named the same
  // way the cockpit's browser ones are above.
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
