// Loaded as a blocking <script> in <head>, so it runs before the first
// paint and the page never flashes the wrong theme. Reads the preference
// saved by the theme toggle in cockpit.js if it was ever used; otherwise
// leaves the attribute unset entirely, deferring to prefers-color-scheme.
(function () {
  var saved = localStorage.getItem("genug-theme");
  if (saved === "light" || saved === "dark") {
    document.documentElement.dataset.theme = saved;
  }
})();
