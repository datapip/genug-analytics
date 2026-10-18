import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderClientScript } from "./clientScript.js";

// The real compiled client, as server/app.ts reads it, so renaming the
// placeholder on one side fails here, not at startup.
const compiled = readFileSync(
  fileURLToPath(
    new URL("../../../packages/client/dist/index.js", import.meta.url),
  ),
  "utf8",
);

test("renderClientScript writes the lists into the compiled client", () => {
  const rendered = renderClientScript(compiled, {
    params: ["utm_source", "gclid"],
    hashes: "*",
  });
  assert.ok(!rendered.includes("__GENUG_KEPT_URL_PARTS__"));
  assert.ok(
    rendered.includes('{"params":["utm_source","gclid"],"hashes":"*"}'),
  );
});

// Serving the file without the lists wouldn't visibly break it: the
// client would just drop every campaign parameter.
test("renderClientScript refuses a script without exactly one placeholder", () => {
  const parts = { params: [], hashes: [] };
  assert.throws(() => renderClientScript("var x = 1;", parts), /exactly once/);
  assert.throws(
    () =>
      renderClientScript(
        '"__GENUG_KEPT_URL_PARTS__";"__GENUG_KEPT_URL_PARTS__"',
        parts,
      ),
    /exactly once/,
  );
});

// KEPT_QUERY_PARAMS and KEPT_HASH_VALUES only forbid spaces, commas and
// "*" (see parseKeptList), so a quote, backslash or "</script>" is
// allowed. The values end up in JavaScript sent to every visitor, so
// they must not break or change the code. new Function throws on invalid
// syntax, which is a quick way to check.
test("renderClientScript stays valid, faithful JS for an adversarial value", () => {
  const tricky = ['a"b\\c', "</script><!--", "d'e"];
  const rendered = renderClientScript(compiled, {
    params: tricky,
    hashes: [],
  });
  assert.doesNotThrow(() => new Function(rendered));
  const match = rendered.match(/const KEPT_URL_PARTS = (.*?);/);
  assert.ok(match, "expected the assignment to still be findable");
  assert.deepEqual(JSON.parse(match![1]!), { params: tricky, hashes: [] });
});
