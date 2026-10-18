// Loaded as a normal (blocking) <script> in <head>, so it runs before the
// page is drawn and the wrong theme never flashes. Applies the choice
// saved by the theme switch in cockpit.js; without one, the attribute
// stays unset and prefers-color-scheme decides.
(function () {
  var saved = localStorage.getItem("genug-theme");
  if (saved === "light" || saved === "dark") {
    document.documentElement.dataset.theme = saved;
  }
})();
